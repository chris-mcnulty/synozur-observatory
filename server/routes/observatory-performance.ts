/**
 * Observatory — Performance Scan routes.
 *
 * POST /api/observatory/assessments/:id/performance-scan
 *   Trigger a headless browser performance scan. Scans the application's
 *   primary appUrl plus every URL in perfExtraUrls independently. Each URL
 *   gets its own obs_performance_scan_pages child row; the parent
 *   obs_performance_scans row is the batch record. One unreachable page
 *   records a failed page row but does not abort the others.
 *
 * GET  /api/observatory/assessments/:id/performance-scans
 *   List all scan batches with their embedded page rows (most recent first).
 *
 * GET  /api/observatory/assessments/:id/performance-scan/status
 *   Poll whether a scan job is currently active/pending for this assessment.
 *
 * PUT  /api/observatory/applications/:id/perf-sla
 *   Update the SLA threshold config for an application.
 *
 * PUT  /api/observatory/applications/:id/perf-urls
 *   Update the extra URL list for an application.
 */
import type { Express, Request, Response } from "express";
import { db } from "../db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getRequestContext, ContextError, type RequestContext } from "../context";
import { hasContentAccess } from "./helpers";
import {
  obsApplications,
  obsAssessments,
  obsFindings,
  obsEvidence,
  obsAssessmentEvidence,
  obsPerformanceScans,
  obsPerformanceScanPages,
  obsAuditLogs,
  obsScanHistory,
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
import {
  planPerfFindingReconcile,
  scopedPerfRuleId,
  type ExistingPerfFinding,
} from "../services/perf-scan-reconcile";

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

/** Extra URL list validation schema (max 20 URLs, each a valid https/http URL). */
const extraUrlsSchema = z.object({
  extraUrls: z
    .array(z.string().url("Each entry must be a valid URL"))
    .max(20, "Maximum 20 extra URLs allowed")
    .default([]),
});
const scanScheduleSchema = z.object({
  scanSchedule: z.enum(["daily", "weekly", "disabled"]),
});

/** Job label prefix for performance scans (used for deduplication / status polling). */
export function scanJobLabel(assessmentId: string): string {
  return `perf-scan:${assessmentId}`;
}
export interface ExecuteScanOptions {
  tenantDomain: string;
  assessment: { id: string; applicationId: string; versionId?: string | null; title: string };
  scanRow: { id: string };
  /** Primary appUrl — also used as the batch scanUrl. */
  url: string;
  /** Extra pages to scan in addition to url (already SSRF-validated). */
  extraUrls?: string[];
  slaConfig: PerfSlaConfig;
  scanSource: "manual" | "scheduled";
  triggeredByUserId: string | null;
}

export async function executePerfScan(opts: ExecuteScanOptions): Promise<void> {
  const { tenantDomain, assessment, scanRow, url, extraUrls = [], slaConfig, scanSource } = opts;
  const allUrls = [url, ...extraUrls];

  let totalFindingCount = 0;
  let allFailed = true;
  const perfStarted = Date.now();
  // Aggregated reconcile counters across all pages, for the scan-history snapshot.
  let historyNew = 0;
  let historyResolved = 0;
  let historyUnchanged = 0;
  let pagesSucceeded = 0;

  for (const pageUrl of allUrls) {
    // Create a page row for this URL immediately (status=running).
    const [pageRow] = await db
      .insert(obsPerformanceScanPages)
      .values({
        tenantDomain,
        scanId: scanRow.id,
        scanUrl: pageUrl,
        status: "running",
      })
      .returning();

    try {
      const { metrics, findings } = await runPerformanceScan(pageUrl, slaConfig, { timeoutMs: 60_000 });

      // ── Reconcile findings for this page URL ─────────────────────────────
      const existingForPage = await db
        .select({
          id: obsFindings.id,
          title: obsFindings.title,
          status: obsFindings.status,
          scanRuleId: obsFindings.scanRuleId,
          affectedComponent: obsFindings.affectedComponent,
        })
        .from(obsFindings)
        .where(
          and(
            eq(obsFindings.assessmentId, assessment.id),
            eq(obsFindings.affectedComponent, pageUrl),
          ),
        );

      const plan = planPerfFindingReconcile(existingForPage, findings, pageUrl, true);

      // Update matched findings (refresh title/description/severity, never status).
      for (const upd of plan.toUpdate) {
        await db
          .update(obsFindings)
          .set({ title: upd.title, description: upd.description, severity: upd.severity, scanRuleId: upd.scanRuleId, updatedAt: new Date() })
          .where(eq(obsFindings.id, upd.id))
          .catch((e) => console.error("[perf-scan] Failed to update finding:", e));
      }

      // Insert new findings.
      let pageFindingCount = plan.toUpdate.length;
      for (const ins of plan.toInsert) {
        try {
          const [created] = await db
            .insert(obsFindings)
            .values({
              tenantDomain,
              assessmentId: assessment.id,
              applicationId: assessment.applicationId,
              versionId: assessment.versionId ?? null,
              title: ins.title,
              description: ins.description,
              severity: ins.severity,
              domain: "performance",
              status: "open",
              recommendation: ins.recommendation,
              affectedComponent: pageUrl,
              scanRuleId: ins.scopedRuleId,
            })
            .returning({ id: obsFindings.id });
          pageFindingCount++;
          await db.insert(obsAuditLogs).values({
            tenantDomain,
            userId: null,
            entityType: "finding",
            entityId: created.id,
            action: "create",
            summary: `Performance scan (${scanSource}) created finding: ${ins.title} (${ins.severity}) on ${pageUrl}`,
          }).catch(() => {});
        } catch (findingErr) {
          console.error(`[perf-scan] Failed to insert finding for ${pageUrl}:`, findingErr);
        }
      }

      // Auto-resolve cleared findings (page scanned successfully).
      if (plan.toResolveIds.length > 0) {
        await db
          .update(obsFindings)
          .set({ status: "remediated", resolvedAt: new Date(), updatedAt: new Date() })
          .where(inArray(obsFindings.id, plan.toResolveIds))
          .catch((e) => console.error("[perf-scan] Failed to auto-resolve findings:", e));
      }

      // Mark page row completed.
      await db
        .update(obsPerformanceScanPages)
        .set({
          status: "completed",
          ttfbMs: metrics.ttfbMs ?? null,
          loadTimeMs: metrics.loadTimeMs ?? null,
          lcpMs: metrics.lcpMs ?? null,
          clsScore: metrics.clsScore ?? null,
          ttiMs: metrics.ttiMs ?? null,
          findingCount: pageFindingCount,
          warnings: (metrics.warnings ?? []) as any,
          scannedAt: new Date(metrics.scannedAt),
        })
        .where(eq(obsPerformanceScanPages.id, pageRow.id));

      historyNew += plan.toInsert.length;
      historyResolved += plan.toResolveIds.length;
      historyUnchanged += plan.toUpdate.length;
      pagesSucceeded++;

      totalFindingCount += pageFindingCount;
      allFailed = false;
      console.log(`[perf-scan] ${pageUrl} — ${pageFindingCount} finding(s) [${scanSource}]`);
    } catch (err: any) {
      console.error(`[perf-scan] Failed scanning ${pageUrl}:`, err);
      await db
        .update(obsPerformanceScanPages)
        .set({ status: "failed", scanError: err?.message ?? String(err) })
        .where(eq(obsPerformanceScanPages.id, pageRow.id))
        .catch(() => {});
      // Continue to the next URL — one failure must not abort the batch.
    }
  }

  // Store a summary evidence record.
  try {
    const [ev] = await db
      .insert(obsEvidence)
      .values({
        tenantDomain,
        title: `Performance Scan Report — ${new Date().toISOString().slice(0, 10)} (${allUrls.length} URL${allUrls.length !== 1 ? "s" : ""})`,
        description: `${scanSource} headless browser performance scan of ${allUrls.length} page(s). ${totalFindingCount} SLA breach(es) found.`,
        evidenceType: "scan_report",
        source: "headless-browser",
        collectedAt: new Date(),
      })
      .returning({ id: obsEvidence.id });
    await db.insert(obsAssessmentEvidence).values({ assessmentId: assessment.id, evidenceId: ev.id }).onConflictDoNothing();
  } catch (evErr) {
    console.error("[perf-scan] Failed to persist evidence:", evErr);
  }

  // ── Scan-history snapshot ──────────────────────────────────────────────────
  // Same contract as observatory-scan-runner: one row per completed scan run
  // with reconcile counters + open counts by severity. Never fails the scan.
  if (!allFailed) {
    try {
      const openRows = await db
        .select({ severity: obsFindings.severity, n: sql<number>`count(*)::int` })
        .from(obsFindings)
        .where(and(
          eq(obsFindings.assessmentId, assessment.id),
          eq(obsFindings.tenantDomain, tenantDomain),
          eq(obsFindings.status, "open"),
        ))
        .groupBy(obsFindings.severity);
      const open: Record<string, number> = {};
      for (const r of openRows) open[r.severity] = r.n;
      await db.insert(obsScanHistory).values({
        tenantDomain,
        assessmentId: assessment.id,
        applicationId: assessment.applicationId,
        tool: "performance-scanner",
        findingsNew: historyNew,
        findingsResolved: historyResolved,
        findingsUnchanged: historyUnchanged,
        openCritical: open["Critical"] ?? 0,
        openHigh: open["High"] ?? 0,
        openMedium: open["Medium"] ?? 0,
        openLow: open["Low"] ?? 0,
        openInfo: open["Informational"] ?? 0,
        scannedPages: pagesSucceeded,
        discoveredPages: allUrls.length,
        partial: pagesSucceeded < allUrls.length,
        durationMs: Date.now() - perfStarted,
      });
    } catch (histErr) {
      console.error("[perf-scan] Failed to record scan history (non-fatal):", histErr);
    }
  }

  const batchStatus = allFailed ? "failed" : "completed";
  await db
    .update(obsPerformanceScans)
    .set({ status: batchStatus, findingCount: totalFindingCount })
    .where(eq(obsPerformanceScans.id, scanRow.id))
    .catch(() => {});

  if (allFailed) {
    throw new Error(`All ${allUrls.length} URL(s) failed to scan`);
  }
  console.log(`[perf-scan] Batch ${scanRow.id} complete [${scanSource}]: ${batchStatus}, ${totalFindingCount} finding(s) across ${allUrls.length} URL(s)`);
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerObservatoryPerformanceRoutes(app: Express) {
  /**
   * GET /api/observatory/assessments/:id/performance-scans
   * List scan batches with embedded per-URL page rows.
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

      if (scans.length === 0) {
        return res.json([]);
      }

      // Embed per-page rows so the UI doesn't need a second round-trip.
      const scanIds = scans.map((s) => s.id);
      const pages = await db
        .select()
        .from(obsPerformanceScanPages)
        .where(inArray(obsPerformanceScanPages.scanId, scanIds))
        .orderBy(obsPerformanceScanPages.createdAt);

      const pagesByScan = new Map<string, typeof pages>();
      for (const p of pages) {
        if (!pagesByScan.has(p.scanId)) pagesByScan.set(p.scanId, []);
        pagesByScan.get(p.scanId)!.push(p);
      }

      const result = scans.map((s) => ({
        ...s,
        pages: pagesByScan.get(s.id) ?? [],
      }));

      res.json(result);
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
   * Trigger a headless performance scan across all configured URLs.
   * Idempotent — returns 409 if a scan is already running.
   */
  app.post("/api/observatory/assessments/:id/performance-scan", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });

    try {
      // Validate assessment.
      const [assessment] = await db
        .select()
        .from(obsAssessments)
        .where(and(eq(obsAssessments.id, req.params.id), eq(obsAssessments.tenantDomain, ctx.tenantDomain)));
      if (!assessment) return res.status(404).json({ message: "Assessment not found" });
      if (assessment.type !== "performance") {
        return res.status(400).json({ message: "Performance scans can only be run on assessments of type 'performance'." });
      }

      // Resolve the application and its URL list.
      const [appRow] = await db
        .select()
        .from(obsApplications)
        .where(and(eq(obsApplications.id, assessment.applicationId), eq(obsApplications.tenantDomain, ctx.tenantDomain)));
      if (!appRow) return res.status(404).json({ message: "Application not found" });

      const primaryUrl = (appRow as any).appUrl as string | null;
      if (!primaryUrl?.trim()) {
        return res.status(400).json({
          message: "The application does not have a URL configured. Add a URL on the application settings page before running a performance scan.",
        });
      }

      const extraUrls: string[] = ((appRow as any).perfExtraUrls as string[] | null) ?? [];
      const allUrls = [primaryUrl.trim(), ...extraUrls.map((u) => u.trim()).filter(Boolean)];

      // SSRF-guard all URLs before launching anything.
      for (const u of allUrls) {
        try {
          await assertScanUrlSafe(u);
        } catch (err: any) {
          return res.status(400).json({ message: `SSRF check failed for ${u}: ${err.message}` });
        }
      }

      // Guard: reject if a scan is already in flight.
      const existing = getJobStatusByLabel(scanJobLabel(assessment.id), ctx.tenantDomain);
      if (existing.status === "active" || existing.status === "pending") {
        return res.status(409).json({ message: "A performance scan is already running for this assessment. Please wait for it to complete." });
      }

      // Resolve SLA config — saved config → request body override → defaults.
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

      // Create the batch scan row immediately so the UI can show progress.
      const [scanRow] = await db
        .insert(obsPerformanceScans)
        .values({
          tenantDomain: ctx.tenantDomain,
          assessmentId: assessment.id,
          applicationId: assessment.applicationId,
          scanUrl: primaryUrl.trim(),
          status: "running",
          slaConfig,
          triggeredBy: ctx.userId,
        })
        .returning();

      await audit(ctx, "performance_scan", scanRow.id, "create", `Triggered performance scan of ${allUrls.length} URL(s)`);

      // Enqueue the background scan job using the shared executePerfScan executor.
      // executePerfScan throws when every URL fails so the queue records the job
      // as failed and the status endpoint reflects the scan failure correctly.
      const jobLabel = scanJobLabel(assessment.id);
      enqueue(
        "other",
        jobLabel,
        () => executePerfScan({
          tenantDomain: ctx.tenantDomain,
          assessment: {
            id: assessment.id,
            applicationId: assessment.applicationId,
            versionId: assessment.versionId,
            title: assessment.title,
          },
          scanRow,
          url: primaryUrl.trim(),
          extraUrls,
          slaConfig,
          scanSource: "manual",
          triggeredByUserId: ctx.userId,
        }),
        {
          priority: 3,
          timeoutMs: 120_000 * allUrls.length, // allow 2 min per URL
          maxRetries: 0,
          ctx: { tenantDomain: ctx.tenantDomain, targetId: assessment.id, targetName: assessment.title },
        },
      ).catch(async (err: unknown) => {
        // executePerfScan throws when all pages fail; the queue rejects after
        // retries are exhausted (maxRetries:0 here). Mark the batch failed so
        // the UI reflects the error and prevent an unhandled promise rejection.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[perf-scan] Manual scan failed for ${assessment.id}: ${message}`);
        await db
          .update(obsPerformanceScans)
          .set({
            status: "failed",
            scanError: message,
          })
          .where(
            and(
              eq(obsPerformanceScans.id, scanRow.id),
              eq(obsPerformanceScans.status, "running"),
            ),
          )
          .catch(() => {});
      });

      res.status(202).json({
        message: "Performance scan started",
        scanId: scanRow.id,
        scanUrl: primaryUrl.trim(),
        urlCount: allUrls.length,
      });
    } catch (err) {
      console.error("[observatory-performance] trigger scan error:", err);
      res.status(500).json({ message: "Failed to start performance scan" });
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

  /**
   * PUT /api/observatory/applications/:id/perf-urls
   * Save the extra URL list for an application.
   * Validates all URLs are http/https and passes the SSRF guard before saving.
   */
  app.put("/api/observatory/applications/:id/perf-urls", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const { extraUrls } = extraUrlsSchema.parse(req.body);

      // SSRF-validate each URL at save time so users get immediate feedback.
      for (const u of extraUrls) {
        try {
          await assertScanUrlSafe(u);
        } catch (err: any) {
          return res.status(400).json({ message: `URL not allowed: ${u} — ${err.message}` });
        }
      }

      const [updated] = await db
        .update(obsApplications)
        .set({ perfExtraUrls: extraUrls as any, updatedAt: new Date() })
        .where(and(eq(obsApplications.id, req.params.id), eq(obsApplications.tenantDomain, ctx.tenantDomain)))
        .returning();
      if (!updated) return res.status(404).json({ message: "Application not found" });
      await audit(ctx, "application", updated.id, "update", `Updated performance extra URLs (${extraUrls.length} URL(s))`);
      res.json({ extraUrls: (updated as any).perfExtraUrls ?? [] });
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: "Invalid URL list", errors: err.errors });
      console.error("[observatory-performance] perf-urls update error:", err);
      res.status(500).json({ message: "Failed to update extra URLs" });
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
}
