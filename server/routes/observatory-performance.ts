/**
 * Observatory — Performance Scan routes.
 *
 * POST /api/observatory/assessments/:id/performance-scan
 *   Trigger a headless browser performance scan for a performance assessment.
 *   The assessment must be type="performance" and the application must have
 *   an appUrl configured. Runs async via the job queue.
 *
 * GET  /api/observatory/assessments/:id/performance-scans
 *   List all scan history rows for an assessment (most recent first).
 *
 * GET  /api/observatory/assessments/:id/performance-scan/status
 *   Poll whether a scan job is currently active/pending for this assessment.
 *
 * PUT  /api/observatory/applications/:id/perf-sla
 *   Update the SLA threshold config for an application.
 *
 * PUT  /api/observatory/assessments/:id/scan-schedule
 *   Set the automated scan cadence (daily / weekly / disabled).
 */
import type { Express, Request, Response } from "express";
import { db } from "../db";
import { and, desc, eq, gte } from "drizzle-orm";
import { getRequestContext, ContextError, type RequestContext } from "../context";
import { hasContentAccess } from "./helpers";
import {
  obsApplications,
  obsAssessments,
  obsFindings,
  obsEvidence,
  obsAssessmentEvidence,
  obsPerformanceScans,
  obsAuditLogs,
  scheduledJobRuns,
} from "@shared/schema";
import { z } from "zod";
import { enqueue, getJobStatusByLabel } from "../services/job-queue";
import {
  runPerformanceScan,
  DEFAULT_PERF_SLA,
  type PerfSlaConfig,
} from "../services/performance-scanner";
import { assertScanUrlSafe } from "../services/ssrf-guard";
import { shouldSkipFinding } from "../services/perf-scan-schedule-core";

// ── helpers ──────────────────────────────────────────────────────────────────

async function ctxOr401(req: Request, res: Response): Promise<RequestContext | null> {
  try {
    return await getRequestContext(req);
  } catch (err: any) {
    if (err instanceof ContextError) {
      res.status(err.status).json({ message: err.message });
      return null;
    }
    throw err;
  }
}

function canWrite(ctx: RequestContext): boolean {
  return hasContentAccess(ctx.userRole);
}

async function audit(
  ctx: RequestContext,
  entityType: string,
  entityId: string,
  action: string,
  summary?: string,
) {
  try {
    await db.insert(obsAuditLogs).values({
      tenantDomain: ctx.tenantDomain,
      userId: ctx.userId,
      entityType,
      entityId,
      action,
      summary: summary ?? null,
    });
  } catch (err) {
    console.error("[observatory-performance] audit log write failed:", err);
  }
}

/** SLA config validation schema. */
const slaConfigSchema = z.object({
  ttfbMs: z.number().int().min(50).max(60_000).default(DEFAULT_PERF_SLA.ttfbMs),
  loadTimeMs: z.number().int().min(100).max(120_000).default(DEFAULT_PERF_SLA.loadTimeMs),
  lcpMs: z.number().int().min(100).max(60_000).default(DEFAULT_PERF_SLA.lcpMs),
  clsScore: z.number().min(0).max(10).default(DEFAULT_PERF_SLA.clsScore),
  ttiMs: z.number().int().min(100).max(120_000).default(DEFAULT_PERF_SLA.ttiMs),
});

const scanScheduleSchema = z.object({
  scanSchedule: z.enum(["daily", "weekly", "disabled"]),
});

/** Job label prefix for performance scans (used for deduplication / status polling). */
export function scanJobLabel(assessmentId: string): string {
  return `perf-scan:${assessmentId}`;
}

// ── Shared scan executor ──────────────────────────────────────────────────────
//
// Called by both the manual POST endpoint and the automated scheduler.
// Creates findings with deduplication for scheduled runs: if a scan is
// scheduled-source, skip inserting a finding when an open finding with the
// same scanRuleId already exists for the assessment. Never touches human-set
// finding statuses.

export interface ExecuteScanOptions {
  tenantDomain: string;
  assessment: { id: string; applicationId: string; versionId?: string | null; title: string };
  scanRow: { id: string };
  url: string;
  slaConfig: PerfSlaConfig;
  scanSource: "manual" | "scheduled";
  triggeredByUserId: string | null;
}

export async function executePerfScan(opts: ExecuteScanOptions): Promise<void> {
  const { tenantDomain, assessment, scanRow, url, slaConfig, scanSource } = opts;

  try {
    const { metrics, findings } = await runPerformanceScan(url, slaConfig, {
      timeoutMs: 60_000,
    });

    // ── Finding dedup (scheduled only) ───────────────────────────────────────
    // For scheduled scans, look up open findings by ruleId so we don't spam
    // new finding rows for persistent SLA breaches. Never touch human statuses.
    let openRuleIds = new Set<string>();
    if (scanSource === "scheduled" && findings.length > 0) {
      const existingFindings = await db
        .select({ scanRuleId: obsFindings.scanRuleId })
        .from(obsFindings)
        .where(
          and(
            eq(obsFindings.assessmentId, assessment.id),
            eq(obsFindings.status, "open"),
          ),
        );
      openRuleIds = new Set(
        existingFindings.map((f) => f.scanRuleId).filter(Boolean) as string[],
      );
    }

    // Persist findings to obs_findings.
    let findingCount = 0;
    for (const f of findings) {
      // Use pure helper: skip if scheduled and an open finding already exists for this rule.
      if (shouldSkipFinding({ scanSource, ruleId: f.ruleId, openRuleIds })) {
        continue;
      }

      try {
        const [created] = await db
          .insert(obsFindings)
          .values({
            tenantDomain,
            assessmentId: assessment.id,
            applicationId: assessment.applicationId,
            versionId: assessment.versionId ?? null,
            title: f.title,
            description: f.description,
            severity: f.severity,
            domain: "performance",
            status: "open",
            recommendation: f.recommendation,
            affectedComponent: url,
            scanRuleId: f.ruleId ?? null,
          })
          .returning({ id: obsFindings.id });
        findingCount++;

        await db.insert(obsAuditLogs).values({
          tenantDomain,
          userId: null,
          entityType: "finding",
          entityId: created.id,
          action: "create",
          summary: `Performance scan (${scanSource}) created finding: ${f.title} (${f.severity})`,
        }).catch(() => {});
      } catch (findingErr) {
        console.error("[perf-scan] Failed to persist finding:", findingErr);
      }
    }

    // Store raw metrics as scan_report evidence linked to the assessment.
    try {
      const evidenceBody = JSON.stringify({ metrics, findings, slaConfig }, null, 2);
      const [ev] = await db
        .insert(obsEvidence)
        .values({
          tenantDomain,
          title: `Performance Scan Report — ${new Date(metrics.scannedAt).toISOString().slice(0, 10)}`,
          description: `Headless browser performance scan of ${url}. ${findingCount} SLA breach(es) found.`,
          evidenceType: "scan_report",
          source: "headless-browser",
          collectedAt: new Date(metrics.scannedAt),
        })
        .returning({ id: obsEvidence.id });

      await db
        .insert(obsAssessmentEvidence)
        .values({ assessmentId: assessment.id, evidenceId: ev.id })
        .onConflictDoNothing();
    } catch (evErr) {
      console.error("[perf-scan] Failed to persist evidence:", evErr);
    }

    // Mark scan row completed with metrics.
    await db
      .update(obsPerformanceScans)
      .set({
        status: "completed",
        ttfbMs: metrics.ttfbMs ?? null,
        loadTimeMs: metrics.loadTimeMs ?? null,
        lcpMs: metrics.lcpMs ?? null,
        clsScore: metrics.clsScore ?? null,
        ttiMs: metrics.ttiMs ?? null,
        findingCount,
        warnings: (metrics.warnings ?? []) as any,
        scannedAt: new Date(metrics.scannedAt),
      })
      .where(eq(obsPerformanceScans.id, scanRow.id));

    console.log(`[perf-scan] Completed ${scanSource} scan for assessment ${assessment.id}: ${findingCount} finding(s)`);
  } catch (err: any) {
    console.error(`[perf-scan] ${scanSource} scan failed for assessment ${assessment.id}:`, err);
    await db
      .update(obsPerformanceScans)
      .set({ status: "failed", scanError: err?.message ?? String(err) })
      .where(eq(obsPerformanceScans.id, scanRow.id))
      .catch(() => {});
    throw err; // re-throw so the job queue records failure in scheduled_job_runs
  }
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerObservatoryPerformanceRoutes(app: Express) {
  /**
   * GET /api/observatory/assessments/:id/performance-scans
   * List scan history for a performance assessment.
   */
  app.get("/api/observatory/assessments/:id/performance-scans", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const [assessment] = await db
        .select()
        .from(obsAssessments)
        .where(and(eq(obsAssessments.id, req.params.id), eq(obsAssessments.tenantDomain, ctx.tenantDomain)));
      if (!assessment) return res.status(404).json({ message: "Assessment not found" });

      const scans = await db
        .select()
        .from(obsPerformanceScans)
        .where(eq(obsPerformanceScans.assessmentId, assessment.id))
        .orderBy(desc(obsPerformanceScans.createdAt))
        .limit(50);

      res.json(scans);
    } catch (err) {
      console.error("[observatory-performance] list scans error:", err);
      res.status(500).json({ message: "Failed to list performance scans" });
    }
  });

  /**
   * GET /api/observatory/assessments/:id/performance-scan/status
   * Poll the queue for an active or pending scan job.
   * Falls back to scheduled_job_runs for a recent failed run so the UI stops
   * spinning and shows the real error after a scan throws or times out.
   */
  app.get("/api/observatory/assessments/:id/performance-scan/status", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const assessmentId = req.params.id;
      const status = getJobStatusByLabel(scanJobLabel(assessmentId), ctx.tenantDomain);
      if (status.status !== "not_found") {
        return res.json(status);
      }

      // Job not in memory — check for a recent (< 30 min) failed run, scoped
      // to the exact job label so a concurrent accessibility scan failure for
      // the same assessment cannot trigger a false performance-scan error.
      const jobLabel = scanJobLabel(assessmentId);
      const recentCutoff = new Date(Date.now() - 30 * 60 * 1000);
      const [latestRun] = await db
        .select({ status: scheduledJobRuns.status, errorMessage: scheduledJobRuns.errorMessage })
        .from(scheduledJobRuns)
        .where(
          and(
            eq(scheduledJobRuns.jobLabel, jobLabel),
            eq(scheduledJobRuns.tenantDomain, ctx.tenantDomain),
            gte(scheduledJobRuns.startedAt, recentCutoff),
          ),
        )
        .orderBy(desc(scheduledJobRuns.startedAt))
        .limit(1);

      if (latestRun?.status === "failed") {
        return res.json({
          status: "failed",
          errorMessage: latestRun.errorMessage ?? "The performance scan encountered an error. Please try again.",
        });
      }

      res.json(status);
    } catch (err) {
      console.error("[observatory-performance] scan status error:", err);
      res.status(500).json({ message: "Failed to check scan status" });
    }
  });

  /**
   * POST /api/observatory/assessments/:id/performance-scan
   * Trigger a headless performance scan. Idempotent — returns 409 if a scan
   * is already running for this assessment.
   */
  app.post("/api/observatory/assessments/:id/performance-scan", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });

    try {
      // Validate assessment exists and belongs to this tenant.
      const [assessment] = await db
        .select()
        .from(obsAssessments)
        .where(and(eq(obsAssessments.id, req.params.id), eq(obsAssessments.tenantDomain, ctx.tenantDomain)));
      if (!assessment) return res.status(404).json({ message: "Assessment not found" });
      if (assessment.type !== "performance") {
        return res.status(400).json({ message: "Performance scans can only be run on assessments of type 'performance'." });
      }

      // Resolve the application URL.
      const [appRow] = await db
        .select()
        .from(obsApplications)
        .where(and(eq(obsApplications.id, assessment.applicationId), eq(obsApplications.tenantDomain, ctx.tenantDomain)));
      if (!appRow) return res.status(404).json({ message: "Application not found" });
      const url = (appRow as any).appUrl as string | null;
      if (!url?.trim()) {
        return res.status(400).json({
          message: "The application does not have a URL configured. Add a URL on the application settings page before running a performance scan.",
        });
      }

      // SSRF guard — reject private/loopback/link-local targets before launching the browser.
      try {
        await assertScanUrlSafe(url.trim());
      } catch (err: any) {
        return res.status(400).json({ message: err.message });
      }

      // Guard: reject if a scan is already in flight for this assessment.
      const existing = getJobStatusByLabel(scanJobLabel(assessment.id), ctx.tenantDomain);
      if (existing.status === "active" || existing.status === "pending") {
        return res.status(409).json({ message: "A performance scan is already running for this assessment. Please wait for it to complete." });
      }

      // Resolve SLA config — priority: request body override → app's saved config → defaults.
      let slaConfig: PerfSlaConfig = DEFAULT_PERF_SLA;
      // Apply the application's saved SLA config first (if set).
      const savedSla = (appRow as any).perfSlaConfig as Partial<PerfSlaConfig> | null;
      if (savedSla && typeof savedSla === "object") {
        const parsed = slaConfigSchema.safeParse({ ...DEFAULT_PERF_SLA, ...savedSla });
        if (parsed.success) slaConfig = parsed.data;
      }
      // Request body can override the saved config (used by SLA dialog "Save & Scan" flows).
      if (req.body && Object.keys(req.body).length > 0) {
        const parsed = slaConfigSchema.safeParse({ ...slaConfig, ...req.body });
        if (parsed.success) slaConfig = parsed.data;
      }

      // Create a "running" scan row immediately so the UI can show progress.
      const [scanRow] = await db
        .insert(obsPerformanceScans)
        .values({
          tenantDomain: ctx.tenantDomain,
          assessmentId: assessment.id,
          applicationId: assessment.applicationId,
          scanUrl: url.trim(),
          status: "running",
          slaConfig,
          triggeredBy: ctx.userId,
          scanSource: "manual",
        })
        .returning();

      await audit(ctx, "performance_scan", scanRow.id, "create", `Triggered manual performance scan of ${url}`);

      // Enqueue the background scan job.
      const jobLabel = scanJobLabel(assessment.id);
      enqueue(
        "other",
        jobLabel,
        async () => {
          await executePerfScan({
            tenantDomain: ctx.tenantDomain,
            assessment: {
              id: assessment.id,
              applicationId: assessment.applicationId,
              versionId: assessment.versionId,
              title: assessment.title,
            },
            scanRow,
            url: url.trim(),
            slaConfig,
            scanSource: "manual",
            triggeredByUserId: ctx.userId,
          });
        },
        {
          priority: 3,
          timeoutMs: 120_000,
          maxRetries: 0, // manual: user can click again
          ctx: { tenantDomain: ctx.tenantDomain, targetId: assessment.id, targetName: assessment.title },
        },
      );

      res.status(202).json({
        message: "Performance scan started",
        scanId: scanRow.id,
        scanUrl: url.trim(),
      });
    } catch (err) {
      console.error("[observatory-performance] trigger scan error:", err);
      res.status(500).json({ message: "Failed to start performance scan" });
    }
  });

  /**
   * PUT /api/observatory/assessments/:id/scan-schedule
   * Set automated scan cadence for a performance assessment.
   */
  app.put("/api/observatory/assessments/:id/scan-schedule", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });

    try {
      const parsed = scanScheduleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid scan schedule. Must be 'daily', 'weekly', or 'disabled'.", errors: parsed.error.errors });
      }
      const { scanSchedule } = parsed.data;

      const [assessment] = await db
        .select()
        .from(obsAssessments)
        .where(and(eq(obsAssessments.id, req.params.id), eq(obsAssessments.tenantDomain, ctx.tenantDomain)));
      if (!assessment) return res.status(404).json({ message: "Assessment not found" });
      if (assessment.type !== "performance") {
        return res.status(400).json({ message: "Scan schedules can only be set on performance assessments." });
      }

      const [updated] = await db
        .update(obsAssessments)
        .set({ scanSchedule, updatedAt: new Date() })
        .where(and(eq(obsAssessments.id, req.params.id), eq(obsAssessments.tenantDomain, ctx.tenantDomain)))
        .returning();

      await audit(ctx, "assessment", updated.id, "update", `Set automated scan schedule to '${scanSchedule}'`);
      res.json({ id: updated.id, scanSchedule: updated.scanSchedule });
    } catch (err: any) {
      console.error("[observatory-performance] scan-schedule update error:", err);
      res.status(500).json({ message: "Failed to update scan schedule" });
    }
  });

  /**
   * PUT /api/observatory/applications/:id/perf-sla
   * Save custom SLA thresholds for an application.
   */
  app.put("/api/observatory/applications/:id/perf-sla", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const sla = slaConfigSchema.parse(req.body);
      const [updated] = await db
        .update(obsApplications)
        .set({ perfSlaConfig: sla as any, updatedAt: new Date() })
        .where(and(eq(obsApplications.id, req.params.id), eq(obsApplications.tenantDomain, ctx.tenantDomain)))
        .returning();
      if (!updated) return res.status(404).json({ message: "Application not found" });
      await audit(ctx, "application", updated.id, "update", `Updated performance SLA thresholds`);
      res.json(updated);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: "Invalid SLA config", errors: err.errors });
      console.error("[observatory-performance] perf-sla update error:", err);
      res.status(500).json({ message: "Failed to update SLA config" });
    }
  });
}
