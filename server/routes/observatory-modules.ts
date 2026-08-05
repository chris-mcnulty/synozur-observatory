/**
 * Observatory — specialized assessment module routes (workbenches).
 *
 * Six workbenches on top of the Observatory foundation:
 *   - Accessibility Review    (checklist: 12 categories)
 *   - Source Code Review      (checklist: 10 categories + source metadata)
 *   - Penetration Test Mgmt   (pen test records + CVSS findings → shared findings)
 *   - Architecture Review     (checklist: 8 areas + Azure capability checklist)
 *   - Privacy & Compliance    (checklist: 7 areas, mapped to standards library)
 *   - AI Governance           (checklist: 8 areas — AI-enabled applications only)
 *
 * Checklist rows live in obs_review_items (module + category), sharing one
 * link model to findings and evidence so the traceability chain
 * (Application → Version → Assessment → Finding → Evidence) is preserved.
 * Pen-test findings always create/wrap rows in the shared obs_findings table.
 */
import type { Express, Request, Response } from "express";
import { db } from "../db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getRequestContext, ContextError, type RequestContext } from "../context";
import { hasAdminAccess, hasContentAccess, logAiUsage } from "./helpers";
import {
  obsApplications,
  obsAssessments,
  obsFindings,
  obsEvidence,
  obsReviewItems,
  obsReviewItemFindings,
  obsReviewItemEvidence,
  obsSourceReviewMeta,
  obsPenTests,
  obsPenTestFindings,
  obsAuditLogs,
  insertObsSourceReviewMetaSchema,
  insertObsPenTestSchema,
  OBS_REVIEW_MODULES,
  OBS_REVIEW_STATUSES,
  OBS_AZURE_STATUSES,
  OBS_MODULE_CATEGORIES,
  OBS_PEN_TEST_RESULTS,
  OBS_VALIDATION_STATUSES,
  OBS_EXPLOITABILITY_LEVELS,
  OBS_FINDING_SEVERITIES,
  OBS_FINDING_DOMAINS,
  AI_FEATURES,
  type ObsReviewModule,
} from "@shared/schema";
import { z } from "zod";
import { completeForFeature } from "../services/ai-provider";
import { securityScanner } from "../services/security-scanner";
import { computeScanReconciliation } from "../services/scan-reconciliation";
import { enqueueScan, getJobStatusByLabel } from "../services/job-queue";

// ── helpers (mirror server/routes/observatory.ts) ───────────────────────────

async function ctxOr401(req: Request, res: Response): Promise<RequestContext | null> {
  try {
    return await getRequestContext(req);
  } catch (err) {
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

function canDelete(ctx: RequestContext): boolean {
  return hasAdminAccess(ctx.userRole) || hasContentAccess(ctx.userRole);
}

async function audit(
  ctx: RequestContext,
  entityType: string,
  entityId: string,
  action: string,
  summary?: string,
  changes?: Record<string, unknown>,
) {
  try {
    await db.insert(obsAuditLogs).values({
      tenantDomain: ctx.tenantDomain,
      userId: ctx.userId,
      entityType,
      entityId,
      action,
      summary: summary ?? null,
      changes: changes ?? null,
    });
  } catch (err) {
    console.error("[observatory-modules] audit log write failed:", err);
  }
}

const dateish = z.preprocess(
  (v) => (typeof v === "string" && v ? new Date(v) : v === "" ? null : v),
  z.date().nullable().optional(),
);

function handleError(res: Response, err: unknown, what: string) {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ message: `Invalid ${what}`, errors: err.errors });
  }
  console.error(`[observatory-modules] ${what} error:`, err);
  return res.status(500).json({ message: `Failed to process ${what}` });
}

/** Statuses valid for a given module's checklist rows. */
function statusesForModule(module: ObsReviewModule): readonly string[] {
  return module === "architecture_azure" ? OBS_AZURE_STATUSES : OBS_REVIEW_STATUSES;
}

/** Which assessment types each workbench module may be initialized on. */
const MODULE_ASSESSMENT_TYPES: Record<ObsReviewModule, readonly string[]> = {
  accessibility: ["accessibility"],
  source_code: ["security_source_review", "code_quality"],
  architecture: ["architecture_review"],
  architecture_azure: ["architecture_review"],
  privacy: ["privacy_review", "compliance"],
  ai_governance: ["ai_governance"],
};

/** Map a CVSS 3.x base score to an Observatory severity. */
export function severityFromCvss(score: number): (typeof OBS_FINDING_SEVERITIES)[number] {
  if (score >= 9.0) return "Critical";
  if (score >= 7.0) return "High";
  if (score >= 4.0) return "Medium";
  if (score > 0) return "Low";
  return "Informational";
}

/** Reasonable default CVSS score when a finding has no explicit score. */
function defaultCvssForSeverity(severity: string): number {
  switch (severity) {
    case "Critical":      return 9.0;
    case "High":          return 7.5;
    case "Medium":        return 5.0;
    case "Low":           return 2.0;
    case "Informational": return 0.0;
    default:              return 5.0;
  }
}

async function getTenantAssessment(ctx: RequestContext, assessmentId: string) {
  const [assessment] = await db
    .select()
    .from(obsAssessments)
    .where(and(eq(obsAssessments.id, assessmentId), eq(obsAssessments.tenantDomain, ctx.tenantDomain)));
  return assessment ?? null;
}

// ── route registration ──────────────────────────────────────────────────────

export function registerObservatoryModuleRoutes(app: Express) {
  // ══ Review items (shared checklist model) ═════════════════════════════════

  /**
   * Initialize a workbench: seed the module's default category rows for an
   * assessment. Idempotent — existing rows are kept, missing ones are added.
   * AI Governance can only be initialized for AI-enabled applications.
   */
  app.post("/api/observatory/assessments/:id/review-items/init", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const { module } = z.object({ module: z.enum(OBS_REVIEW_MODULES) }).parse(req.body);
      const assessment = await getTenantAssessment(ctx, req.params.id);
      if (!assessment) return res.status(404).json({ message: "Assessment not found" });

      const allowedTypes = MODULE_ASSESSMENT_TYPES[module];
      if (allowedTypes && !allowedTypes.includes(assessment.type)) {
        return res.status(400).json({
          message: `The ${module} checklist cannot be initialized on a "${assessment.type}" assessment. Expected assessment type: ${allowedTypes.join(" or ")}.`,
        });
      }

      if (module === "ai_governance") {
        const [appRow] = await db
          .select()
          .from(obsApplications)
          .where(and(eq(obsApplications.id, assessment.applicationId), eq(obsApplications.tenantDomain, ctx.tenantDomain)));
        if (!appRow?.aiEnabled) {
          return res.status(400).json({ message: "AI Governance reviews are only available for AI-enabled applications. Flag the application as AI-enabled first." });
        }
      }

      const categories = OBS_MODULE_CATEGORIES[module];
      const inserted = await db
        .insert(obsReviewItems)
        .values(
          categories.map((category, i) => ({
            tenantDomain: ctx.tenantDomain,
            assessmentId: assessment.id,
            module,
            category,
            sortOrder: i,
            createdBy: ctx.userId,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: obsReviewItems.id });
      if (inserted.length > 0) {
        await audit(ctx, "review_item", assessment.id, "create", `Initialized ${module} workbench (${inserted.length} checklist rows)`);
      }
      res.status(201).json({ created: inserted.length });
    } catch (err) {
      handleError(res, err, "workbench init");
    }
  });

  /** List review items for an assessment (optionally one module), with linked finding/evidence summaries. */
  app.get("/api/observatory/assessments/:id/review-items", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const assessment = await getTenantAssessment(ctx, req.params.id);
      if (!assessment) return res.status(404).json({ message: "Assessment not found" });
      const conditions = [eq(obsReviewItems.assessmentId, assessment.id)];
      if (typeof req.query.module === "string" && (OBS_REVIEW_MODULES as readonly string[]).includes(req.query.module)) {
        conditions.push(eq(obsReviewItems.module, req.query.module));
      }
      const items = await db
        .select()
        .from(obsReviewItems)
        .where(and(...conditions))
        .orderBy(asc(obsReviewItems.module), asc(obsReviewItems.sortOrder));

      const itemIds = items.map((i) => i.id);
      const findingLinks = itemIds.length
        ? await db
            .select({
              reviewItemId: obsReviewItemFindings.reviewItemId,
              finding: obsFindings,
            })
            .from(obsReviewItemFindings)
            .innerJoin(obsFindings, eq(obsReviewItemFindings.findingId, obsFindings.id))
            .where(inArray(obsReviewItemFindings.reviewItemId, itemIds))
        : [];
      const evidenceLinks = itemIds.length
        ? await db
            .select({
              reviewItemId: obsReviewItemEvidence.reviewItemId,
              evidence: obsEvidence,
            })
            .from(obsReviewItemEvidence)
            .innerJoin(obsEvidence, eq(obsReviewItemEvidence.evidenceId, obsEvidence.id))
            .where(inArray(obsReviewItemEvidence.reviewItemId, itemIds))
        : [];

      res.json(
        items.map((item) => ({
          ...item,
          findings: findingLinks
            .filter((l) => l.reviewItemId === item.id)
            .map((l) => ({ id: l.finding.id, title: l.finding.title, severity: l.finding.severity, status: l.finding.status })),
          evidence: evidenceLinks
            .filter((l) => l.reviewItemId === item.id)
            .map((l) => ({ id: l.evidence.id, title: l.evidence.title, evidenceType: l.evidence.evidenceType })),
        })),
      );
    } catch (err) {
      handleError(res, err, "review items");
    }
  });

  /** Update a checklist row: status, notes, reviewer, reviewedAt. */
  app.patch("/api/observatory/review-items/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const data = z
        .object({
          status: z.string().optional(),
          notes: z.string().nullable().optional(),
          reviewer: z.string().nullable().optional(),
          reviewedAt: dateish,
        })
        .parse(req.body);
      const [existing] = await db
        .select()
        .from(obsReviewItems)
        .where(and(eq(obsReviewItems.id, req.params.id), eq(obsReviewItems.tenantDomain, ctx.tenantDomain)));
      if (!existing) return res.status(404).json({ message: "Review item not found" });
      if (data.status !== undefined) {
        const valid = statusesForModule(existing.module as ObsReviewModule);
        if (!valid.includes(data.status)) {
          return res.status(400).json({ message: `Invalid status. Expected one of: ${valid.join(", ")}` });
        }
      }
      const set: Record<string, unknown> = { ...data, updatedAt: new Date() };
      // Auto-stamp the review date when a status is set and none was provided.
      if (data.status && data.reviewedAt === undefined) set.reviewedAt = new Date();
      const [updated] = await db
        .update(obsReviewItems)
        .set(set)
        .where(eq(obsReviewItems.id, existing.id))
        .returning();
      await audit(ctx, "review_item", updated.id, "update", `${existing.module} · ${existing.category} → ${updated.status}`, { fields: Object.keys(data) });
      res.json(updated);
    } catch (err) {
      handleError(res, err, "review item");
    }
  });

  /** Create a new finding from a checklist row and link it. */
  app.post("/api/observatory/review-items/:id/findings", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const body = z
        .object({
          title: z.string().min(1),
          description: z.string().nullable().optional(),
          severity: z.enum(OBS_FINDING_SEVERITIES).default("Medium"),
          domain: z.enum(OBS_FINDING_DOMAINS),
          recommendation: z.string().nullable().optional(),
          affectedComponent: z.string().nullable().optional(),
          wcagCriterion: z.string().nullable().optional(),
          cweId: z.string().nullable().optional(),
          sourceFile: z.string().nullable().optional(),
          sourceLine: z.number().int().nullable().optional(),
        })
        .parse(req.body);
      const [item] = await db
        .select()
        .from(obsReviewItems)
        .where(and(eq(obsReviewItems.id, req.params.id), eq(obsReviewItems.tenantDomain, ctx.tenantDomain)));
      if (!item) return res.status(404).json({ message: "Review item not found" });
      if (item.module === "source_code" && !body.sourceFile?.trim()) {
        return res.status(400).json({ message: "Source code review findings must include the affected source file." });
      }
      const assessment = await getTenantAssessment(ctx, item.assessmentId);
      if (!assessment) return res.status(404).json({ message: "Assessment not found" });

      const created = await db.transaction(async (tx) => {
        const [finding] = await tx
          .insert(obsFindings)
          .values({
            tenantDomain: ctx.tenantDomain,
            assessmentId: assessment.id,
            applicationId: assessment.applicationId,
            versionId: assessment.versionId,
            title: body.title,
            description: body.description ?? null,
            severity: body.severity,
            domain: body.domain,
            status: "open",
            recommendation: body.recommendation ?? null,
            affectedComponent: body.affectedComponent ?? null,
            wcagCriterion: body.wcagCriterion ?? null,
            cweId: body.cweId ?? null,
            sourceFile: body.sourceFile ?? null,
            sourceLine: body.sourceLine ?? null,
            createdBy: ctx.userId,
          })
          .returning();
        await tx.insert(obsReviewItemFindings).values({ reviewItemId: item.id, findingId: finding.id }).onConflictDoNothing();
        return finding;
      });
      await audit(ctx, "finding", created.id, "create", `Created finding "${created.title}" from ${item.module} · ${item.category}`);
      res.status(201).json(created);
    } catch (err) {
      handleError(res, err, "review item finding");
    }
  });

  /** Link / unlink an existing finding to a checklist row. */
  app.post("/api/observatory/review-items/:id/findings/:findingId", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const [item] = await db
        .select()
        .from(obsReviewItems)
        .where(and(eq(obsReviewItems.id, req.params.id), eq(obsReviewItems.tenantDomain, ctx.tenantDomain)));
      const [finding] = await db
        .select()
        .from(obsFindings)
        .where(and(eq(obsFindings.id, req.params.findingId), eq(obsFindings.tenantDomain, ctx.tenantDomain)));
      if (!item || !finding) return res.status(404).json({ message: "Review item or finding not found" });
      await db.insert(obsReviewItemFindings).values({ reviewItemId: item.id, findingId: finding.id }).onConflictDoNothing();
      await audit(ctx, "review_item", item.id, "link", `Linked finding "${finding.title}" to ${item.module} · ${item.category}`);
      res.json({ success: true });
    } catch (err) {
      handleError(res, err, "review item finding link");
    }
  });

  app.delete("/api/observatory/review-items/:id/findings/:findingId", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const [item] = await db
        .select()
        .from(obsReviewItems)
        .where(and(eq(obsReviewItems.id, req.params.id), eq(obsReviewItems.tenantDomain, ctx.tenantDomain)));
      if (!item) return res.status(404).json({ message: "Review item not found" });
      await db
        .delete(obsReviewItemFindings)
        .where(and(eq(obsReviewItemFindings.reviewItemId, item.id), eq(obsReviewItemFindings.findingId, req.params.findingId)));
      await audit(ctx, "review_item", item.id, "unlink", "Unlinked finding from checklist row");
      res.json({ success: true });
    } catch (err) {
      handleError(res, err, "review item finding unlink");
    }
  });

  /** Link / unlink evidence to a checklist row. */
  app.post("/api/observatory/review-items/:id/evidence/:evidenceId", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const [item] = await db
        .select()
        .from(obsReviewItems)
        .where(and(eq(obsReviewItems.id, req.params.id), eq(obsReviewItems.tenantDomain, ctx.tenantDomain)));
      const [ev] = await db
        .select()
        .from(obsEvidence)
        .where(and(eq(obsEvidence.id, req.params.evidenceId), eq(obsEvidence.tenantDomain, ctx.tenantDomain)));
      if (!item || !ev) return res.status(404).json({ message: "Review item or evidence not found" });
      await db.insert(obsReviewItemEvidence).values({ reviewItemId: item.id, evidenceId: ev.id }).onConflictDoNothing();
      await audit(ctx, "review_item", item.id, "link", `Linked evidence "${ev.title}" to ${item.module} · ${item.category}`);
      res.json({ success: true });
    } catch (err) {
      handleError(res, err, "review item evidence link");
    }
  });

  app.delete("/api/observatory/review-items/:id/evidence/:evidenceId", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const [item] = await db
        .select()
        .from(obsReviewItems)
        .where(and(eq(obsReviewItems.id, req.params.id), eq(obsReviewItems.tenantDomain, ctx.tenantDomain)));
      if (!item) return res.status(404).json({ message: "Review item not found" });
      await db
        .delete(obsReviewItemEvidence)
        .where(and(eq(obsReviewItemEvidence.reviewItemId, item.id), eq(obsReviewItemEvidence.evidenceId, req.params.evidenceId)));
      await audit(ctx, "review_item", item.id, "unlink", "Unlinked evidence from checklist row");
      res.json({ success: true });
    } catch (err) {
      handleError(res, err, "review item evidence unlink");
    }
  });

  // ══ Source code review metadata ═══════════════════════════════════════════

  app.get("/api/observatory/assessments/:id/source-meta", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const assessment = await getTenantAssessment(ctx, req.params.id);
      if (!assessment) return res.status(404).json({ message: "Assessment not found" });
      const [meta] = await db
        .select()
        .from(obsSourceReviewMeta)
        .where(eq(obsSourceReviewMeta.assessmentId, assessment.id));
      res.json(meta ?? null);
    } catch (err) {
      handleError(res, err, "source metadata");
    }
  });

  const sourceMetaBodySchema = insertObsSourceReviewMetaSchema.omit({
    tenantDomain: true,
    assessmentId: true,
    createdBy: true,
  });

  /** Upsert (one row per assessment). */
  app.put("/api/observatory/assessments/:id/source-meta", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const data = sourceMetaBodySchema.parse(req.body);
      const assessment = await getTenantAssessment(ctx, req.params.id);
      if (!assessment) return res.status(404).json({ message: "Assessment not found" });
      const [existing] = await db
        .select()
        .from(obsSourceReviewMeta)
        .where(eq(obsSourceReviewMeta.assessmentId, assessment.id));
      let row;
      if (existing) {
        [row] = await db
          .update(obsSourceReviewMeta)
          .set({ ...data, updatedAt: new Date() })
          .where(eq(obsSourceReviewMeta.id, existing.id))
          .returning();
      } else {
        [row] = await db
          .insert(obsSourceReviewMeta)
          .values({ ...data, tenantDomain: ctx.tenantDomain, assessmentId: assessment.id, createdBy: ctx.userId })
          .returning();
      }
      await audit(ctx, "source_meta", row.id, existing ? "update" : "create", `Source review metadata for "${assessment.title}"`);
      res.json(row);
    } catch (err) {
      handleError(res, err, "source metadata");
    }
  });

  // ══ Penetration tests ═════════════════════════════════════════════════════

  app.get("/api/observatory/pen-tests", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const rows = await db
        .select({
          penTest: obsPenTests,
          assessment: obsAssessments,
          application: obsApplications,
          findingCount: sql<number>`(select count(*)::int from obs_pen_test_findings ptf where ptf.pen_test_id = ${obsPenTests.id})`,
        })
        .from(obsPenTests)
        .innerJoin(obsAssessments, eq(obsPenTests.assessmentId, obsAssessments.id))
        .innerJoin(obsApplications, eq(obsAssessments.applicationId, obsApplications.id))
        .where(eq(obsPenTests.tenantDomain, ctx.tenantDomain))
        .orderBy(desc(obsPenTests.createdAt));
      res.json(
        rows.map((r) => ({
          ...r.penTest,
          assessmentTitle: r.assessment.title,
          applicationId: r.application.id,
          applicationName: r.application.name,
          findingCount: r.findingCount,
        })),
      );
    } catch (err) {
      handleError(res, err, "pen tests");
    }
  });

  const penTestBodySchema = insertObsPenTestSchema
    .omit({ tenantDomain: true, createdBy: true })
    .extend({ startDate: dateish, endDate: dateish });

  function validatePenTestEnums(data: { result?: string | null }, res: Response): boolean {
    if (data.result && !(OBS_PEN_TEST_RESULTS as readonly string[]).includes(data.result)) {
      res.status(400).json({ message: `Invalid result. Expected one of: ${OBS_PEN_TEST_RESULTS.join(", ")}` });
      return false;
    }
    return true;
  }

  app.post("/api/observatory/pen-tests", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const data = penTestBodySchema.parse(req.body);
      if (!validatePenTestEnums(data, res)) return;
      const assessment = await getTenantAssessment(ctx, data.assessmentId);
      if (!assessment) return res.status(404).json({ message: "Assessment not found" });
      const [existing] = await db.select().from(obsPenTests).where(eq(obsPenTests.assessmentId, assessment.id));
      if (existing) return res.status(409).json({ message: "This assessment already has a pen test record" });
      const [created] = await db
        .insert(obsPenTests)
        .values({ ...data, tenantDomain: ctx.tenantDomain, createdBy: ctx.userId })
        .returning();
      await audit(ctx, "pen_test", created.id, "create", `Created pen test "${created.testName}"`);
      res.status(201).json(created);
    } catch (err) {
      handleError(res, err, "pen test");
    }
  });

  app.get("/api/observatory/pen-tests/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const [row] = await db
        .select({ penTest: obsPenTests, assessment: obsAssessments, application: obsApplications })
        .from(obsPenTests)
        .innerJoin(obsAssessments, eq(obsPenTests.assessmentId, obsAssessments.id))
        .innerJoin(obsApplications, eq(obsAssessments.applicationId, obsApplications.id))
        .where(and(eq(obsPenTests.id, req.params.id), eq(obsPenTests.tenantDomain, ctx.tenantDomain)));
      if (!row) return res.status(404).json({ message: "Pen test not found" });
      const findings = await db
        .select({ ext: obsPenTestFindings, finding: obsFindings })
        .from(obsPenTestFindings)
        .innerJoin(obsFindings, eq(obsPenTestFindings.findingId, obsFindings.id))
        .where(eq(obsPenTestFindings.penTestId, row.penTest.id))
        .orderBy(desc(obsPenTestFindings.cvssScore));
      res.json({
        ...row.penTest,
        assessment: { id: row.assessment.id, title: row.assessment.title, status: row.assessment.status },
        application: { id: row.application.id, name: row.application.name },
        findings: findings.map((f) => ({ ...f.ext, finding: f.finding })),
      });
    } catch (err) {
      handleError(res, err, "pen test");
    }
  });

  app.patch("/api/observatory/pen-tests/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const data = penTestBodySchema.partial().parse(req.body);
      if (!validatePenTestEnums(data, res)) return;
      delete (data as any).assessmentId;
      const [updated] = await db
        .update(obsPenTests)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(obsPenTests.id, req.params.id), eq(obsPenTests.tenantDomain, ctx.tenantDomain)))
        .returning();
      if (!updated) return res.status(404).json({ message: "Pen test not found" });
      await audit(ctx, "pen_test", updated.id, "update", `Updated pen test "${updated.testName}"`, { fields: Object.keys(data) });
      res.json(updated);
    } catch (err) {
      handleError(res, err, "pen test");
    }
  });

  app.delete("/api/observatory/pen-tests/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canDelete(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const penTestId = req.params.id;

      // Verify existence before entering the transaction (cheap exit path).
      const [existing] = await db
        .select()
        .from(obsPenTests)
        .where(and(eq(obsPenTests.id, penTestId), eq(obsPenTests.tenantDomain, ctx.tenantDomain)));
      if (!existing) return res.status(404).json({ message: "Pen test not found" });

      // Wrap the entire cleanup in a transaction so that a mid-operation DB failure
      // cannot leave orphaned obs_findings rows behind.
      //
      // Why findings are not removed automatically:
      //   obs_pen_test_findings.penTestId  → onDelete: "cascade" (junction rows go away)
      //   obs_pen_test_findings.findingId  → onDelete: "cascade" (finding→junction, not the reverse)
      //   obs_findings.assessmentId        → onDelete: "cascade"  (handles assessment-scoped deletes)
      // Deleting the pen test alone cascades only the junction rows, leaving the
      // underlying obs_findings rows alive. They must be removed explicitly.
      //
      // IMPORTANT: backlinked findings (backlinkFinding = true, created by the
      // relink-findings backfill endpoint) are NOT deleted. Those findings belong
      // to the assessment, not exclusively to the pen test — they should remain in
      // the shared register after the pen test is removed.
      const findingIds = await db.transaction(async (tx) => {
        // Collect obs_findings IDs while inside the transaction so the read and
        // the subsequent deletes are atomic — no partial cleanup on DB failure.
        // Exclude backlinked findings from the explicit delete list.
        const ptFindingRows = await tx
          .select({ findingId: obsPenTestFindings.findingId, backlinkFinding: obsPenTestFindings.backlinkFinding })
          .from(obsPenTestFindings)
          .where(eq(obsPenTestFindings.penTestId, penTestId));
        // Only delete findings that were originally created for this pen test
        // (backlinkFinding = false). Backfilled findings survive the deletion.
        const ids = ptFindingRows.filter((r) => !r.backlinkFinding).map((r) => r.findingId);

        // Delete the pen test — cascades obs_pen_test_findings rows via penTestId FK.
        // Any concurrent scanner that inserted a new finding + junction row after
        // our read above will have its junction row removed by this cascade; the
        // findings delete below clears the IDs we already collected.
        await tx
          .delete(obsPenTests)
          .where(and(eq(obsPenTests.id, penTestId), eq(obsPenTests.tenantDomain, ctx.tenantDomain)));

        // Remove the underlying findings. Deleting obs_findings also cascades
        // obs_finding_evidence, obs_finding_controls, and obs_review_item_findings.
        if (ids.length > 0) {
          await tx
            .delete(obsFindings)
            .where(and(inArray(obsFindings.id, ids), eq(obsFindings.tenantDomain, ctx.tenantDomain)));
        }

        return ids;
      });

      await audit(ctx, "pen_test", existing.id, "delete", `Deleted pen test "${existing.testName}" (${findingIds.length} finding(s) removed)`);
      res.json({ success: true });
    } catch (err) {
      handleError(res, err, "pen test");
    }
  });

  // ── Pen-test findings (create a shared finding + pen-test extension) ──────

  const penTestFindingBodySchema = z.object({
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    severity: z.enum(OBS_FINDING_SEVERITIES).optional(),
    recommendation: z.string().nullable().optional(),
    affectedComponent: z.string().nullable().optional(),
    stepsToReproduce: z.string().nullable().optional(),
    cweId: z.string().nullable().optional(),
    cvssScore: z.number().min(0).max(10).nullable().optional(),
    cvssVector: z.string().nullable().optional(),
    exploitability: z.enum(OBS_EXPLOITABILITY_LEVELS).nullable().optional(),
    validationStatus: z.enum(OBS_VALIDATION_STATUSES).optional(),
  });

  app.post("/api/observatory/pen-tests/:id/findings", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const body = penTestFindingBodySchema.parse(req.body);
      const [penTest] = await db
        .select()
        .from(obsPenTests)
        .where(and(eq(obsPenTests.id, req.params.id), eq(obsPenTests.tenantDomain, ctx.tenantDomain)));
      if (!penTest) return res.status(404).json({ message: "Pen test not found" });
      const assessment = await getTenantAssessment(ctx, penTest.assessmentId);
      if (!assessment) return res.status(404).json({ message: "Assessment not found" });

      const severity = body.severity ?? (body.cvssScore != null ? severityFromCvss(body.cvssScore) : "Medium");
      const result = await db.transaction(async (tx) => {
        const [finding] = await tx
          .insert(obsFindings)
          .values({
            tenantDomain: ctx.tenantDomain,
            assessmentId: assessment.id,
            applicationId: assessment.applicationId,
            versionId: assessment.versionId,
            title: body.title,
            description: body.description ?? null,
            severity,
            domain: "security",
            status: "open",
            recommendation: body.recommendation ?? null,
            affectedComponent: body.affectedComponent ?? null,
            stepsToReproduce: body.stepsToReproduce ?? null,
            cweId: body.cweId ?? null,
            createdBy: ctx.userId,
          })
          .returning();
        const [ext] = await tx
          .insert(obsPenTestFindings)
          .values({
            tenantDomain: ctx.tenantDomain,
            penTestId: penTest.id,
            findingId: finding.id,
            cvssScore: body.cvssScore ?? null,
            cvssVector: body.cvssVector ?? null,
            exploitability: body.exploitability ?? null,
            validationStatus: body.validationStatus ?? "Not Started",
          })
          .returning();
        return { ...ext, finding };
      });
      await audit(ctx, "finding", result.finding.id, "create", `Pen test finding "${result.finding.title}" (CVSS ${result.cvssScore ?? "—"})`);
      res.status(201).json(result);
    } catch (err) {
      handleError(res, err, "pen test finding");
    }
  });

  /** Update pen-test-specific fields (CVSS, exploitability, validation). Shared finding fields are edited via the findings routes. */
  app.patch("/api/observatory/pen-test-findings/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const data = z
        .object({
          cvssScore: z.number().min(0).max(10).nullable().optional(),
          cvssVector: z.string().nullable().optional(),
          exploitability: z.enum(OBS_EXPLOITABILITY_LEVELS).nullable().optional(),
          validationStatus: z.enum(OBS_VALIDATION_STATUSES).optional(),
          validatedBy: z.string().nullable().optional(),
          validatedAt: dateish,
        })
        .parse(req.body);
      const [existing] = await db
        .select()
        .from(obsPenTestFindings)
        .where(and(eq(obsPenTestFindings.id, req.params.id), eq(obsPenTestFindings.tenantDomain, ctx.tenantDomain)));
      if (!existing) return res.status(404).json({ message: "Pen test finding not found" });
      const set: Record<string, unknown> = { ...data, updatedAt: new Date() };
      if (data.validationStatus && ["Validated", "Failed Validation"].includes(data.validationStatus)) {
        if (data.validatedAt === undefined) set.validatedAt = new Date();
      }
      const updatedRows = await db.transaction(async (tx) => {
        const [updated] = await tx.update(obsPenTestFindings).set(set).where(eq(obsPenTestFindings.id, existing.id)).returning();
        // Keep the shared finding's severity aligned when CVSS changes and no manual severity override is requested.
        if (data.cvssScore != null) {
          await tx
            .update(obsFindings)
            .set({ severity: severityFromCvss(data.cvssScore), updatedAt: new Date() })
            .where(and(eq(obsFindings.id, existing.findingId), eq(obsFindings.tenantDomain, ctx.tenantDomain)));
        }
        return updated;
      });
      await audit(ctx, "pen_test_finding", existing.id, "update", `Updated pen test finding tracking`, { fields: Object.keys(data) });
      res.json(updatedRows);
    } catch (err) {
      handleError(res, err, "pen test finding");
    }
  });

  /** Remove a pen-test finding: deletes the extension row AND the underlying shared finding (created together). */
  app.delete("/api/observatory/pen-test-findings/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canDelete(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const [existing] = await db
        .select()
        .from(obsPenTestFindings)
        .where(and(eq(obsPenTestFindings.id, req.params.id), eq(obsPenTestFindings.tenantDomain, ctx.tenantDomain)));
      if (!existing) return res.status(404).json({ message: "Pen test finding not found" });
      await db
        .delete(obsFindings)
        .where(and(eq(obsFindings.id, existing.findingId), eq(obsFindings.tenantDomain, ctx.tenantDomain)));
      // obs_pen_test_findings row cascades with the finding delete.
      await audit(ctx, "pen_test_finding", existing.id, "delete", "Deleted pen test finding (incl. shared finding)");
      res.json({ success: true });
    } catch (err) {
      handleError(res, err, "pen test finding");
    }
  });

  // ══ Automated security scan ════════════════════════════════════════════════

  /**
   * POST /api/observatory/pen-tests/:id/security-scan
   * Enqueues a built-in security scan against the pen test's application URL.
   * Findings are created as pen-test findings (obs_pen_test_findings wrapping
   * obs_findings) with affectedComponent = "Automated Scan" so they are
   * visually distinct from manually entered findings.
   */
  app.post("/api/observatory/pen-tests/:id/security-scan", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });

    try {
      // Load the pen test with its assessment + application
      const [penTest] = await db
        .select({
          id: obsPenTests.id,
          tenantDomain: obsPenTests.tenantDomain,
          assessmentId: obsPenTests.assessmentId,
          assessment: {
            id: obsAssessments.id,
            applicationId: obsAssessments.applicationId,
            versionId: obsAssessments.versionId,
          },
          appUrl: obsApplications.appUrl,
          applicationId: obsApplications.id,
          applicationName: obsApplications.name,
        })
        .from(obsPenTests)
        .innerJoin(obsAssessments, eq(obsAssessments.id, obsPenTests.assessmentId))
        .innerJoin(obsApplications, eq(obsApplications.id, obsAssessments.applicationId))
        .where(and(eq(obsPenTests.id, req.params.id), eq(obsPenTests.tenantDomain, ctx.tenantDomain)));

      if (!penTest) return res.status(404).json({ message: "Pen test not found" });
      if (!penTest.appUrl)
        return res.status(422).json({ message: "Application has no URL configured — add one on the application record first." });

      const jobLabel = `security-scan:pen-test:${penTest.id}`;

      // Check if a scan is already running
      const existing = getJobStatusByLabel(jobLabel, ctx.tenantDomain);
      if (existing.status !== "not_found") {
        return res.status(202).json({ status: existing.status, message: "Scan already in progress" });
      }

      // Enqueue the scan through the Observatory scan queue
      enqueueScan(
        jobLabel,
        async () => {
          const scanResult = await securityScanner.runScan({
            tenantDomain: penTest.tenantDomain,
            applicationId: penTest.applicationId,
            assessmentId: penTest.assessmentId,
            target: { url: penTest.appUrl! },
          });

          // Was the scan a hard failure (target unreachable)?  If so, we still
          // upsert the "target-unreachable" finding but must NOT auto-resolve other
          // findings — a transient outage should never clear the register.
          const scanFailed = scanResult.findings.some((f) => f.ruleId === "target-unreachable");

          // Load ALL findings linked to this pen test, regardless of how they were created.
          // Earlier scans via the general assessment runner set affectedComponent=null;
          // filtering by affectedComponent="Automated Scan" would miss those rows and
          // cause duplicate findings to be inserted on every subsequent pen-test scan.
          const existingRows = await db
            .select({
              penTestFindingId: obsPenTestFindings.id,
              findingId: obsFindings.id,
              scanRuleId: obsFindings.scanRuleId,
              title: obsFindings.title,
              status: obsFindings.status,
            })
            .from(obsPenTestFindings)
            .innerJoin(obsFindings, eq(obsFindings.id, obsPenTestFindings.findingId))
            .where(
              and(
                eq(obsPenTestFindings.penTestId, penTest.id),
                eq(obsPenTestFindings.tenantDomain, penTest.tenantDomain),
              ),
            );

          // Compute reconciliation plan (pure, testable — no DB calls)
          const plan = computeScanReconciliation(existingRows, scanResult.findings, scanFailed);

          let inserted = 0;
          let updated = 0;
          let resolved = 0;

          // Apply updates for existing findings
          for (const op of plan.toUpdate) {
            try {
              await db
                .update(obsFindings)
                .set({
                  title: op.finding.title,
                  description: op.finding.description ?? null,
                  severity: op.finding.severity,
                  cweId: op.finding.cweId ?? null,
                  stepsToReproduce: op.finding.location?.url
                    ? `Checked URL: ${op.finding.location.url}`
                    : null,
                  // Backfill scanRuleId for legacy rows that were matched by title
                  scanRuleId: op.finding.ruleId,
                  status: op.newStatus,
                  resolvedAt: op.newStatus === "open" && op.row.status === "remediated" ? null : undefined,
                  updatedAt: new Date(),
                })
                .where(eq(obsFindings.id, op.row.findingId));
              updated++;
            } catch (err: any) {
              console.error(`[SecurityScan] Failed to update finding "${op.finding.title}" (${op.finding.ruleId}):`, err.message);
            }
          }

          // Insert genuinely new findings and link them to this pen test
          for (const sf of plan.toInsert) {
            try {
              const [finding] = await db
                .insert(obsFindings)
                .values({
                  tenantDomain: penTest.tenantDomain,
                  assessmentId: penTest.assessmentId,
                  applicationId: penTest.applicationId,
                  versionId: penTest.assessment.versionId ?? null,
                  title: sf.title,
                  description: sf.description ?? null,
                  severity: sf.severity,
                  domain: "security",
                  status: "open",
                  recommendation: null,
                  affectedComponent: "Automated Scan",
                  stepsToReproduce: sf.location?.url
                    ? `Checked URL: ${sf.location.url}`
                    : null,
                  cweId: sf.cweId ?? null,
                  scanRuleId: sf.ruleId,
                  createdBy: null,
                })
                .returning({ id: obsFindings.id });

              await db.insert(obsPenTestFindings).values({
                tenantDomain: penTest.tenantDomain,
                penTestId: penTest.id,
                findingId: finding.id,
                exploitability: null,
                validationStatus: "Not Started",
              });

              inserted++;
            } catch (err: any) {
              console.error(`[SecurityScan] Failed to insert finding "${sf.title}" (${sf.ruleId}):`, err.message);
            }
          }

          // Auto-resolve stale findings (only open ones; only on successful scans)
          if (plan.toResolve.length > 0) {
            const staleFindingIds = plan.toResolve.map((r) => r.findingId);
            await db
              .update(obsFindings)
              .set({ status: "remediated", resolvedAt: new Date(), updatedAt: new Date() })
              .where(inArray(obsFindings.id, staleFindingIds));
            resolved = staleFindingIds.length;
          }

          await db
            .insert(obsAuditLogs)
            .values({
              tenantDomain: penTest.tenantDomain,
              userId: null,
              entityType: "pen_test",
              entityId: penTest.id,
              action: "security_scan",
              summary: scanFailed
                ? `Automated security scan could not reach ${penTest.appUrl} — existing findings were preserved`
                : `Automated security scan completed for ${penTest.appUrl}: ${inserted} new, ${updated} updated, ${resolved} auto-resolved`,
              changes: {
                tool: scanResult.tool,
                url: penTest.appUrl,
                scanFailed,
                inserted,
                updated,
                resolved,
                durationMs: scanResult.finishedAt.getTime() - scanResult.startedAt.getTime(),
              },
            })
            .catch(() => {});

          return { inserted, updated, resolved };
        },
        {
          timeoutMs: 3 * 60 * 1000,
          ctx: { tenantDomain: ctx.tenantDomain, targetId: penTest.id, targetName: penTest.applicationName },
          maxRetries: 0,
        },
      );

      await audit(ctx, "pen_test", penTest.id, "security_scan_triggered", `Automated security scan triggered for ${penTest.appUrl}`);
      res.status(202).json({ status: "queued", message: "Security scan started" });
    } catch (err) {
      handleError(res, err, "security scan");
    }
  });

  /**
   * POST /api/observatory/pen-tests/:id/relink-findings
   *
   * One-time backfill: finds obs_findings rows that belong to this pen test's
   * assessment but have no obs_pen_test_findings junction row, and inserts the
   * missing junction rows.  Safe to call multiple times — uses onConflictDoNothing.
   */
  app.post("/api/observatory/pen-tests/:id/relink-findings", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const [penTest] = await db
        .select()
        .from(obsPenTests)
        .where(and(eq(obsPenTests.id, req.params.id), eq(obsPenTests.tenantDomain, ctx.tenantDomain)));
      if (!penTest) return res.status(404).json({ message: "Pen test not found" });

      // Find obs_findings for this pen test's assessment that were created by the
      // automated scan runner (runObservatoryScan) but are missing a junction row.
      //
      // Provenance criterion — scan-runner findings have an obs_finding_evidence row
      // linking to the SAME evidence that is also linked to this assessment via
      // obs_assessment_evidence, with evidenceType = 'scan_report'.
      //
      // Why this combination is reliable as a discriminator:
      //   • runObservatoryScan creates one scan_report obs_evidence per run, links it
      //     to the assessment (obsAssessmentEvidence) AND to each finding it creates
      //     (obsFindingEvidence) — atomically, in the same code path.
      //   • Manually created findings (pen test UI, general /api/observatory/findings
      //     route) have no scan_report evidence linked to them, so they are excluded.
      //   • Non-pen-test scan findings (accessibility, performance) have different
      //     assessmentIds and are already excluded by the assessmentId equality check.
      //
      // Deletion safety: junction rows created here have backlinkFinding = true.
      // The pen test deletion route only explicitly removes obs_findings rows where
      // the junction row has backlinkFinding = false, so backfilled findings survive
      // a pen test deletion and remain in the shared assessment register.
      const orphaned = await db
        .select({ id: obsFindings.id, severity: obsFindings.severity })
        .from(obsFindings)
        .where(
          and(
            eq(obsFindings.assessmentId, penTest.assessmentId),
            eq(obsFindings.tenantDomain, ctx.tenantDomain),
            // Provenance: finding must share a scan_report evidence with its assessment
            sql`EXISTS (
              SELECT 1
              FROM   obs_finding_evidence ofe
              JOIN   obs_assessment_evidence oae ON oae.evidence_id = ofe.evidence_id
              JOIN   obs_evidence oe ON oe.id = ofe.evidence_id
              WHERE  ofe.finding_id     = ${obsFindings.id}
                AND  oae.assessment_id  = ${penTest.assessmentId}
                AND  oe.evidence_type   = 'scan_report'
            )`,
            // Not already linked to any pen test
            sql`NOT EXISTS (
              SELECT 1 FROM obs_pen_test_findings ptf
              WHERE ptf.finding_id = ${obsFindings.id}
            )`,
          ),
        );

      if (orphaned.length === 0) {
        return res.json({ relinked: 0, message: "All findings are already linked to this pen test." });
      }

      // Insert missing junction rows, marked backlinkFinding = true so the
      // pen test deletion route knows NOT to delete the underlying obs_findings.
      await db
        .insert(obsPenTestFindings)
        .values(
          orphaned.map((f) => ({
            tenantDomain: ctx.tenantDomain,
            penTestId: penTest.id,
            findingId: f.id,
            cvssScore: defaultCvssForSeverity(f.severity ?? "Medium"),
            validationStatus: "Not Started" as const,
            backlinkFinding: true,
          })),
        )
        .onConflictDoNothing();

      await audit(
        ctx,
        "pen_test",
        penTest.id,
        "relink_findings",
        `Relinked ${orphaned.length} orphaned finding(s) to pen test`,
      );

      res.json({ relinked: orphaned.length });
    } catch (err) {
      handleError(res, err, "relink findings");
    }
  });

  /**
   * GET /api/observatory/pen-tests/:id/security-scan/status
   * Returns the current queue status of the security scan for this pen test.
   */
  app.get("/api/observatory/pen-tests/:id/security-scan/status", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const jobLabel = `security-scan:pen-test:${req.params.id}`;
      const status = getJobStatusByLabel(jobLabel, ctx.tenantDomain);
      res.json(status);
    } catch (err) {
      handleError(res, err, "security scan status");
    }
  });

  // ══ AI assist — draft finding description/recommendation from notes ═══════

  app.post("/api/observatory/ai/draft-finding", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const body = z
        .object({
          notes: z.string().min(1),
          module: z.string().optional(),
          category: z.string().optional(),
          applicationName: z.string().optional(),
        })
        .parse(req.body);

      const moduleLabel = (body.module ?? "").replace(/_/g, " ");
      const prompt = `You are an application assurance analyst writing a formal finding for an assessment report.

Context:
- Review area: ${moduleLabel || "general"}${body.category ? ` — ${body.category}` : ""}
- Application: ${body.applicationName ?? "(unnamed application)"}

Reviewer's raw notes:
"""
${body.notes.slice(0, 4000)}
"""

Turn the notes into a structured finding. Respond with ONLY a JSON object (no markdown fences) with exactly these keys:
{
  "title": "concise finding title (max 100 chars)",
  "description": "2-4 sentence formal description of the issue and its impact",
  "recommendation": "2-3 sentence actionable remediation guidance",
  "severity": "one of: Critical, High, Medium, Low, Informational"
}`;

      const result = await completeForFeature(AI_FEATURES.OBSERVATORY_ASSIST, prompt, {
        temperature: 0.3,
        maxTokens: 800,
        tenantDomain: ctx.tenantDomain,
      });
      await logAiUsage(
        ctx,
        "observatory_draft_finding",
        result.provider,
        result.model,
        { input_tokens: result.usage?.inputTokens, output_tokens: result.usage?.outputTokens },
        result.durationMs,
        { module: body.module, category: body.category },
      );

      let parsed: { title?: string; description?: string; recommendation?: string; severity?: string };
      try {
        const cleaned = result.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
        parsed = JSON.parse(cleaned);
      } catch {
        return res.status(502).json({ message: "AI response could not be parsed — please try again." });
      }
      const severity = (OBS_FINDING_SEVERITIES as readonly string[]).includes(parsed.severity ?? "")
        ? parsed.severity
        : "Medium";
      res.json({
        title: String(parsed.title ?? "").slice(0, 200),
        description: String(parsed.description ?? ""),
        recommendation: String(parsed.recommendation ?? ""),
        severity,
      });
    } catch (err) {
      handleError(res, err, "AI finding draft");
    }
  });
}
