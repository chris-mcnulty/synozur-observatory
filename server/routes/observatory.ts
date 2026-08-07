/**
 * Observatory — Application Assurance & Certification Intelligence routes.
 *
 * Traceability spine: Application → Version → Assessment → Finding →
 * Evidence → Control → Framework. All data is tenant-scoped; the
 * frameworks/controls catalog is a global, read-only standards library.
 *
 * Role mapping (spec → existing Orbit roles):
 *   ReadOnly      → Standard User / Consultant (read everything)
 *   Reviewer      → Analyst (create/edit assessments, findings, evidence)
 *   Administrator → Domain Admin / Global Admin (everything incl. delete)
 */
import type { Express, Request, Response } from "express";
import { db } from "../db";
import { and, desc, eq, gte, ilike, inArray, or, sql, asc } from "drizzle-orm";
import { getRequestContext, ContextError, type RequestContext } from "../context";
import { hasAdminAccess, hasContentAccess } from "./helpers";
import { ObjectStorageService, ObjectNotFoundError } from "../replit_integrations/object_storage/objectStorage";
import {
  obsApplications,
  obsVersions,
  obsAssessments,
  obsFindings,
  obsEvidence,
  obsFrameworks,
  obsControls,
  obsFindingEvidence,
  obsAssessmentEvidence,
  obsVersionEvidence,
  obsControlEvidence,
  obsReviewItemEvidence,
  obsFindingControls,
  obsAuditLogs,
  scheduledJobRuns,
  insertObsApplicationSchema,
  insertObsVersionSchema,
  insertObsAssessmentSchema,
  insertObsFindingSchema,
  insertObsEvidenceSchema,
  OBS_ASSESSMENT_TYPES,
  OBS_VERSION_STATUSES,
  OBS_ASSESSMENT_STATUSES,
  OBS_FINDING_SEVERITIES,
  OBS_FINDING_DOMAINS,
  OBS_FINDING_STATUSES,
  OBS_EVIDENCE_TYPES,
} from "@shared/schema";
import { z } from "zod";
import { seedStandardsCatalog } from "../services/observatory-standards";
import { seedObservatoryDemo } from "../services/observatory-demo-seed";
import { enqueueScan, getJobStatusByLabel } from "../services/job-queue";
import { runObservatoryScan } from "../services/observatory-scan-runner";
// Ensure the axe-core scanner is registered in the global registry at startup
import "../services/accessibility-scanner";
const objectStorageService = new ObjectStorageService();

// Scannable assessment types — these have a built-in scanner
const SCANNABLE_TYPES = new Set(["accessibility", "penetration_test", "performance"]);

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Given a set of candidate evidence IDs and a set of IDs that still appear in
 * at least one junction table, returns only the IDs that are now fully orphaned
 * (no remaining links anywhere).  Exported for unit-testing.
 */
export function selectOrphanedEvidenceIds(
  candidateIds: string[],
  stillLinkedIds: string[],
): string[] {
  const linked = new Set(stillLinkedIds);
  return candidateIds.filter((id) => !linked.has(id));
}

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
    console.error("[observatory] audit log write failed:", err);
  }
}

/** Coerce ISO date strings from JSON bodies into Date objects for timestamp columns. */
const dateish = z.preprocess(
  (v) => (typeof v === "string" && v ? new Date(v) : v === "" ? null : v),
  z.date().nullable().optional(),
);

function handleError(res: Response, err: unknown, what: string) {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ message: `Invalid ${what}`, errors: err.errors });
  }
  console.error(`[observatory] ${what} error:`, err);
  return res.status(500).json({ message: `Failed to process ${what}` });
}

// ── route registration ──────────────────────────────────────────────────────

export function registerObservatoryRoutes(app: Express) {
  // Seed the global standards catalog once at boot (idempotent, after migrations).
  seedStandardsCatalog()
    .then((r) => {
      if (r.frameworks > 0 || r.controls > 0) {
        console.log(`[observatory] standards catalog seeded: +${r.frameworks} frameworks, +${r.controls} controls`);
      }
    })
    .catch((err) => console.error("[observatory] standards seed failed:", err));

  // ── Applications ──────────────────────────────────────────────────────────
  app.get("/api/observatory/applications", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const apps = await db
        .select()
        .from(obsApplications)
        .where(eq(obsApplications.tenantDomain, ctx.tenantDomain))
        .orderBy(asc(obsApplications.name));
      // Attach lightweight rollups: version count, latest version, open finding count.
      const appIds = apps.map((a) => a.id);
      const versions = appIds.length
        ? await db.select().from(obsVersions).where(inArray(obsVersions.applicationId, appIds)).orderBy(desc(obsVersions.createdAt))
        : [];
      const findingCounts = appIds.length
        ? await db
            .select({ applicationId: obsFindings.applicationId, count: sql<number>`count(*)::int` })
            .from(obsFindings)
            .where(and(inArray(obsFindings.applicationId, appIds), inArray(obsFindings.status, ["open", "in_progress"])))
            .groupBy(obsFindings.applicationId)
        : [];
      const openByApp = new Map(findingCounts.map((f) => [f.applicationId, f.count]));
      const result = apps.map((a) => {
        const appVersions = versions.filter((v) => v.applicationId === a.id);
        return {
          ...a,
          versionCount: appVersions.length,
          latestVersion: appVersions[0] ?? null,
          openFindingCount: openByApp.get(a.id) ?? 0,
        };
      });
      res.json(result);
    } catch (err) {
      handleError(res, err, "applications");
    }
  });

  app.get("/api/observatory/applications/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const [appRow] = await db
        .select()
        .from(obsApplications)
        .where(and(eq(obsApplications.id, req.params.id), eq(obsApplications.tenantDomain, ctx.tenantDomain)));
      if (!appRow) return res.status(404).json({ message: "Application not found" });
      const versions = await db
        .select()
        .from(obsVersions)
        .where(eq(obsVersions.applicationId, appRow.id))
        .orderBy(desc(obsVersions.createdAt));
      const assessments = await db
        .select()
        .from(obsAssessments)
        .where(eq(obsAssessments.applicationId, appRow.id))
        .orderBy(desc(obsAssessments.createdAt));
      const findings = await db
        .select()
        .from(obsFindings)
        .where(eq(obsFindings.applicationId, appRow.id))
        .orderBy(desc(obsFindings.createdAt));
      res.json({ ...appRow, versions, assessments, findings });
    } catch (err) {
      handleError(res, err, "application");
    }
  });

  app.post("/api/observatory/applications", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const data = insertObsApplicationSchema
        .omit({ tenantDomain: true, createdBy: true })
        .parse(req.body);
      const [created] = await db
        .insert(obsApplications)
        .values({ ...data, tenantDomain: ctx.tenantDomain, createdBy: ctx.userId })
        .returning();
      await audit(ctx, "application", created.id, "create", `Created application "${created.name}"`);
      res.status(201).json(created);
    } catch (err) {
      handleError(res, err, "application");
    }
  });

  app.patch("/api/observatory/applications/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const data = insertObsApplicationSchema
        .omit({ tenantDomain: true, createdBy: true })
        .partial()
        .parse(req.body);
      const [updated] = await db
        .update(obsApplications)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(obsApplications.id, req.params.id), eq(obsApplications.tenantDomain, ctx.tenantDomain)))
        .returning();
      if (!updated) return res.status(404).json({ message: "Application not found" });
      await audit(ctx, "application", updated.id, "update", `Updated application "${updated.name}"`, { fields: Object.keys(data) });
      res.json(updated);
    } catch (err) {
      handleError(res, err, "application");
    }
  });

  app.delete("/api/observatory/applications/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canDelete(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const appId = req.params.id;

      // Verify the application exists and belongs to this tenant before touching children.
      const [existing] = await db
        .select()
        .from(obsApplications)
        .where(and(eq(obsApplications.id, appId), eq(obsApplications.tenantDomain, ctx.tenantDomain)));
      if (!existing) return res.status(404).json({ message: "Application not found" });

      // Collect evidence IDs linked to this application's entities BEFORE deletion
      // so we can clean up obs_evidence rows that become orphaned.
      const [evFromFindings, evFromAssessments, evFromVersions] = await Promise.all([
        db
          .select({ id: obsFindingEvidence.evidenceId })
          .from(obsFindingEvidence)
          .innerJoin(obsFindings, eq(obsFindings.id, obsFindingEvidence.findingId))
          .where(and(eq(obsFindings.applicationId, appId), eq(obsFindings.tenantDomain, ctx.tenantDomain))),
        db
          .select({ id: obsAssessmentEvidence.evidenceId })
          .from(obsAssessmentEvidence)
          .innerJoin(obsAssessments, eq(obsAssessments.id, obsAssessmentEvidence.assessmentId))
          .where(and(eq(obsAssessments.applicationId, appId), eq(obsAssessments.tenantDomain, ctx.tenantDomain))),
        db
          .select({ id: obsVersionEvidence.evidenceId })
          .from(obsVersionEvidence)
          .innerJoin(obsVersions, eq(obsVersions.id, obsVersionEvidence.versionId))
          .where(and(eq(obsVersions.applicationId, appId), eq(obsVersions.tenantDomain, ctx.tenantDomain))),
      ]);
      const candidateEvidenceIds = [
        ...new Set([
          ...evFromFindings.map((r) => r.id),
          ...evFromAssessments.map((r) => r.id),
          ...evFromVersions.map((r) => r.id),
        ]),
      ];

      // Explicit cascade cleanup — defensive layer on top of DB-level FK cascades.
      // Order matters: most-dependent rows first so that nothing is left dangling
      // even if a future migration accidentally drops a cascade rule.
      //   findings    → cascades obs_finding_evidence, obs_finding_controls,
      //                           obs_review_item_findings
      //   assessments → cascades obs_review_items (→ obs_review_item_evidence,
      //                           obs_review_item_findings), obs_assessment_evidence
      //   versions    → cascades obs_version_evidence
      await db.delete(obsFindings).where(
        and(eq(obsFindings.applicationId, appId), eq(obsFindings.tenantDomain, ctx.tenantDomain)),
      );
      await db.delete(obsAssessments).where(
        and(eq(obsAssessments.applicationId, appId), eq(obsAssessments.tenantDomain, ctx.tenantDomain)),
      );
      await db.delete(obsVersions).where(
        and(eq(obsVersions.applicationId, appId), eq(obsVersions.tenantDomain, ctx.tenantDomain)),
      );

      // Delete obs_evidence rows that are now orphaned (no remaining junction links).
      // Candidates that were also linked to OTHER applications/controls/review-items
      // will still have junction rows and will NOT be deleted.
      if (candidateEvidenceIds.length > 0) {
        const [stillFinding, stillAssessment, stillVersion, stillControl, stillReviewItem] =
          await Promise.all([
            db
              .select({ id: obsFindingEvidence.evidenceId })
              .from(obsFindingEvidence)
              .where(inArray(obsFindingEvidence.evidenceId, candidateEvidenceIds)),
            db
              .select({ id: obsAssessmentEvidence.evidenceId })
              .from(obsAssessmentEvidence)
              .where(inArray(obsAssessmentEvidence.evidenceId, candidateEvidenceIds)),
            db
              .select({ id: obsVersionEvidence.evidenceId })
              .from(obsVersionEvidence)
              .where(inArray(obsVersionEvidence.evidenceId, candidateEvidenceIds)),
            db
              .select({ id: obsControlEvidence.evidenceId })
              .from(obsControlEvidence)
              .where(inArray(obsControlEvidence.evidenceId, candidateEvidenceIds)),
            db
              .select({ id: obsReviewItemEvidence.evidenceId })
              .from(obsReviewItemEvidence)
              .where(inArray(obsReviewItemEvidence.evidenceId, candidateEvidenceIds)),
          ]);

        const orphanedIds = selectOrphanedEvidenceIds(candidateEvidenceIds, [
          ...stillFinding.map((r) => r.id),
          ...stillAssessment.map((r) => r.id),
          ...stillVersion.map((r) => r.id),
          ...stillControl.map((r) => r.id),
          ...stillReviewItem.map((r) => r.id),
        ]);

        if (orphanedIds.length > 0) {
          await db
            .delete(obsEvidence)
            .where(
              and(inArray(obsEvidence.id, orphanedIds), eq(obsEvidence.tenantDomain, ctx.tenantDomain)),
            );
        }
      }

      const [deleted] = await db
        .delete(obsApplications)
        .where(and(eq(obsApplications.id, appId), eq(obsApplications.tenantDomain, ctx.tenantDomain)))
        .returning();
      if (!deleted) return res.status(404).json({ message: "Application not found" });
      await audit(ctx, "application", deleted.id, "delete", `Deleted application "${deleted.name}"`);
      res.json({ success: true });
    } catch (err) {
      handleError(res, err, "application");
    }
  });

  // ── Versions ──────────────────────────────────────────────────────────────
  app.get("/api/observatory/versions", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const conditions = [eq(obsVersions.tenantDomain, ctx.tenantDomain)];
      if (typeof req.query.applicationId === "string") {
        conditions.push(eq(obsVersions.applicationId, req.query.applicationId));
      }
      const rows = await db
        .select({
          version: obsVersions,
          applicationName: obsApplications.name,
        })
        .from(obsVersions)
        .innerJoin(obsApplications, eq(obsVersions.applicationId, obsApplications.id))
        .where(and(...conditions))
        .orderBy(desc(obsVersions.createdAt));
      res.json(rows.map((r) => ({ ...r.version, applicationName: r.applicationName })));
    } catch (err) {
      handleError(res, err, "versions");
    }
  });

  const versionBodySchema = insertObsVersionSchema
    .omit({ tenantDomain: true, createdBy: true })
    .extend({ releaseDate: dateish });

  app.post("/api/observatory/versions", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const data = versionBodySchema.parse(req.body);
      if (data.assessmentStatus && !OBS_VERSION_STATUSES.includes(data.assessmentStatus as any)) {
        return res.status(400).json({ message: `Invalid status. Expected one of: ${OBS_VERSION_STATUSES.join(", ")}` });
      }
      // Verify parent application belongs to this tenant.
      const [parent] = await db
        .select()
        .from(obsApplications)
        .where(and(eq(obsApplications.id, data.applicationId), eq(obsApplications.tenantDomain, ctx.tenantDomain)));
      if (!parent) return res.status(404).json({ message: "Application not found" });
      const [created] = await db
        .insert(obsVersions)
        .values({ ...data, tenantDomain: ctx.tenantDomain, createdBy: ctx.userId })
        .returning();
      await audit(ctx, "version", created.id, "create", `Created version ${created.versionNumber} of "${parent.name}"`);
      res.status(201).json(created);
    } catch (err) {
      handleError(res, err, "version");
    }
  });

  app.patch("/api/observatory/versions/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const data = versionBodySchema.partial().parse(req.body);
      if (data.assessmentStatus && !OBS_VERSION_STATUSES.includes(data.assessmentStatus as any)) {
        return res.status(400).json({ message: `Invalid status. Expected one of: ${OBS_VERSION_STATUSES.join(", ")}` });
      }
      delete (data as any).applicationId; // versions cannot be re-parented
      const [updated] = await db
        .update(obsVersions)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(obsVersions.id, req.params.id), eq(obsVersions.tenantDomain, ctx.tenantDomain)))
        .returning();
      if (!updated) return res.status(404).json({ message: "Version not found" });
      await audit(ctx, "version", updated.id, "update", `Updated version ${updated.versionNumber}`, { fields: Object.keys(data) });
      res.json(updated);
    } catch (err) {
      handleError(res, err, "version");
    }
  });

  app.delete("/api/observatory/versions/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canDelete(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const versionId = req.params.id;

      // Verify the version exists and belongs to this tenant before touching children.
      const [existing] = await db
        .select()
        .from(obsVersions)
        .where(and(eq(obsVersions.id, versionId), eq(obsVersions.tenantDomain, ctx.tenantDomain)));
      if (!existing) return res.status(404).json({ message: "Version not found" });

      // Explicit cascade cleanup — defensive layer on top of DB-level FK cascades.
      // The version→finding and version→assessment FKs use ON DELETE SET NULL (not
      // CASCADE), so without this block those rows would be orphaned with a null
      // versionId rather than removed.
      //   findings    → cascades obs_finding_evidence, obs_finding_controls,
      //                           obs_review_item_findings
      //   assessments → cascades obs_review_items (→ obs_review_item_evidence,
      //                           obs_review_item_findings), obs_assessment_evidence
      await db.delete(obsFindings).where(
        and(eq(obsFindings.versionId, versionId), eq(obsFindings.tenantDomain, ctx.tenantDomain)),
      );
      await db.delete(obsAssessments).where(
        and(eq(obsAssessments.versionId, versionId), eq(obsAssessments.tenantDomain, ctx.tenantDomain)),
      );

      const [deleted] = await db
        .delete(obsVersions)
        .where(and(eq(obsVersions.id, versionId), eq(obsVersions.tenantDomain, ctx.tenantDomain)))
        .returning();
      if (!deleted) return res.status(404).json({ message: "Version not found" });
      await audit(ctx, "version", deleted.id, "delete", `Deleted version ${deleted.versionNumber}`);
      res.json({ success: true });
    } catch (err) {
      handleError(res, err, "version");
    }
  });

  // ── Assessments ───────────────────────────────────────────────────────────
  app.get("/api/observatory/assessments", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const conditions = [eq(obsAssessments.tenantDomain, ctx.tenantDomain)];
      if (typeof req.query.applicationId === "string") conditions.push(eq(obsAssessments.applicationId, req.query.applicationId));
      if (typeof req.query.versionId === "string") conditions.push(eq(obsAssessments.versionId, req.query.versionId));
      if (typeof req.query.type === "string") conditions.push(eq(obsAssessments.type, req.query.type));
      if (typeof req.query.status === "string") conditions.push(eq(obsAssessments.status, req.query.status));
      const rows = await db
        .select({
          assessment: obsAssessments,
          applicationName: obsApplications.name,
          versionNumber: obsVersions.versionNumber,
          findingCount: sql<number>`(select count(*)::int from obs_findings f where f.assessment_id = ${obsAssessments.id})`,
        })
        .from(obsAssessments)
        .innerJoin(obsApplications, eq(obsAssessments.applicationId, obsApplications.id))
        .leftJoin(obsVersions, eq(obsAssessments.versionId, obsVersions.id))
        .where(and(...conditions))
        .orderBy(desc(obsAssessments.createdAt));
      res.json(rows.map((r) => ({ ...r.assessment, applicationName: r.applicationName, versionNumber: r.versionNumber, findingCount: r.findingCount })));
    } catch (err) {
      handleError(res, err, "assessments");
    }
  });

  app.get("/api/observatory/assessments/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const [row] = await db
        .select()
        .from(obsAssessments)
        .where(and(eq(obsAssessments.id, req.params.id), eq(obsAssessments.tenantDomain, ctx.tenantDomain)));
      if (!row) return res.status(404).json({ message: "Assessment not found" });
      const [application] = await db.select().from(obsApplications).where(eq(obsApplications.id, row.applicationId));
      const version = row.versionId
        ? (await db.select().from(obsVersions).where(eq(obsVersions.id, row.versionId)))[0] ?? null
        : null;
      const findings = await db
        .select()
        .from(obsFindings)
        .where(eq(obsFindings.assessmentId, row.id))
        .orderBy(desc(obsFindings.createdAt));
      const evidence = await db
        .select({ evidence: obsEvidence })
        .from(obsAssessmentEvidence)
        .innerJoin(obsEvidence, eq(obsAssessmentEvidence.evidenceId, obsEvidence.id))
        .where(eq(obsAssessmentEvidence.assessmentId, row.id));
      res.json({ ...row, application, version, findings, evidence: evidence.map((e) => e.evidence) });
    } catch (err) {
      handleError(res, err, "assessment");
    }
  });

  const assessmentBodySchema = insertObsAssessmentSchema
    .omit({ tenantDomain: true, createdBy: true })
    .extend({ startDate: dateish, endDate: dateish });

  app.post("/api/observatory/assessments", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const data = assessmentBodySchema.parse(req.body);
      if (!OBS_ASSESSMENT_TYPES.includes(data.type as any)) {
        return res.status(400).json({ message: `Invalid type. Expected one of: ${OBS_ASSESSMENT_TYPES.join(", ")}` });
      }
      if (data.status && !OBS_ASSESSMENT_STATUSES.includes(data.status as any)) {
        return res.status(400).json({ message: `Invalid status. Expected one of: ${OBS_ASSESSMENT_STATUSES.join(", ")}` });
      }
      const [parent] = await db
        .select()
        .from(obsApplications)
        .where(and(eq(obsApplications.id, data.applicationId), eq(obsApplications.tenantDomain, ctx.tenantDomain)));
      if (!parent) return res.status(404).json({ message: "Application not found" });
      const [created] = await db
        .insert(obsAssessments)
        .values({ ...data, tenantDomain: ctx.tenantDomain, createdBy: ctx.userId })
        .returning();
      await audit(ctx, "assessment", created.id, "create", `Created assessment "${created.title}"`);

      // Auto-trigger a built-in scan when a scannable assessment is created and
      // the application has a URL. SSRF validation is handled inside the scanner.
      let scanQueued = false;
      if (SCANNABLE_TYPES.has(created.type) && parent.appUrl) {
        try {
          const assessmentId = created.id;
          const scanLabel = `scan:${created.type}:${assessmentId}`;
          enqueueScan(
            scanLabel,
            async (signal) => runObservatoryScan({ assessmentId, tenantDomain: ctx.tenantDomain, triggeredByUserId: ctx.userId, signal }),
            { ctx: { tenantDomain: ctx.tenantDomain, targetId: assessmentId } },
          ).catch((err) => {
            console.error(`[Observatory] Auto-triggered scan failed for ${assessmentId}:`, err);
          });
          scanQueued = true;
          await audit(ctx, "assessment", assessmentId, "scan_triggered", `Auto-triggered ${created.type} scan on assessment creation`);
          console.log(`[Observatory] Auto-queued ${created.type} scan for assessment ${assessmentId} → ${parent.appUrl}`);
        } catch (err: any) {
          // Non-fatal: scanner unavailable or URL invalid — log and continue
          console.warn(`[Observatory] Could not auto-queue ${created.type} scan: ${err?.message}`);
        }
      }

      res.status(201).json({ ...created, scanQueued });
    } catch (err) {
      handleError(res, err, "assessment");
    }
  });

  app.patch("/api/observatory/assessments/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const data = assessmentBodySchema.partial().parse(req.body);
      if (data.type && !OBS_ASSESSMENT_TYPES.includes(data.type as any)) {
        return res.status(400).json({ message: `Invalid type. Expected one of: ${OBS_ASSESSMENT_TYPES.join(", ")}` });
      }
      if (data.status && !OBS_ASSESSMENT_STATUSES.includes(data.status as any)) {
        return res.status(400).json({ message: `Invalid status. Expected one of: ${OBS_ASSESSMENT_STATUSES.join(", ")}` });
      }
      delete (data as any).applicationId;
      const [updated] = await db
        .update(obsAssessments)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(obsAssessments.id, req.params.id), eq(obsAssessments.tenantDomain, ctx.tenantDomain)))
        .returning();
      if (!updated) return res.status(404).json({ message: "Assessment not found" });
      await audit(ctx, "assessment", updated.id, "update", `Updated assessment "${updated.title}"`, { fields: Object.keys(data) });
      res.json(updated);
    } catch (err) {
      handleError(res, err, "assessment");
    }
  });

  app.delete("/api/observatory/assessments/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canDelete(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const assessmentId = req.params.id;

      // Verify existence before entering the transaction (cheap exit path).
      const [existing] = await db
        .select()
        .from(obsAssessments)
        .where(and(eq(obsAssessments.id, assessmentId), eq(obsAssessments.tenantDomain, ctx.tenantDomain)));
      if (!existing) return res.status(404).json({ message: "Assessment not found" });

      // Wrap the cleanup in a transaction so a mid-operation DB failure cannot
      // leave orphaned findings behind.
      //
      // Deletion order (matters):
      //   1. obs_findings (assessment-scoped) — cascades obs_pen_test_findings via
      //      the findingId FK, and also cascades obs_finding_evidence,
      //      obs_finding_controls, obs_review_item_findings.
      //   2. obs_assessments — cascades obs_pen_tests, obs_review_items, and
      //      obs_assessment_evidence via DB-level FK rules.
      //
      // Deleting findings first is the defensive layer: even if the DB-level
      // assessmentId cascade rule were ever accidentally dropped, scan-created
      // findings would still be removed before the assessment row disappears.
      await db.transaction(async (tx) => {
        await tx
          .delete(obsFindings)
          .where(and(eq(obsFindings.assessmentId, assessmentId), eq(obsFindings.tenantDomain, ctx.tenantDomain)));

        await tx
          .delete(obsAssessments)
          .where(and(eq(obsAssessments.id, assessmentId), eq(obsAssessments.tenantDomain, ctx.tenantDomain)));
      });

      await audit(ctx, "assessment", existing.id, "delete", `Deleted assessment "${existing.title}"`);
      res.json({ success: true });
    } catch (err) {
      handleError(res, err, "assessment");
    }
  });

  // ── Findings ──────────────────────────────────────────────────────────────
  app.get("/api/observatory/findings", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const conditions = [eq(obsFindings.tenantDomain, ctx.tenantDomain)];
      if (typeof req.query.assessmentId === "string") conditions.push(eq(obsFindings.assessmentId, req.query.assessmentId));
      if (typeof req.query.applicationId === "string") conditions.push(eq(obsFindings.applicationId, req.query.applicationId));
      if (typeof req.query.severity === "string") conditions.push(eq(obsFindings.severity, req.query.severity));
      if (typeof req.query.domain === "string") conditions.push(eq(obsFindings.domain, req.query.domain));
      if (typeof req.query.status === "string") conditions.push(eq(obsFindings.status, req.query.status));
      if (typeof req.query.search === "string" && req.query.search.trim()) {
        const term = `%${req.query.search.trim()}%`;
        conditions.push(or(ilike(obsFindings.title, term), ilike(obsFindings.description, term))!);
      }
      const rows = await db
        .select({
          finding: obsFindings,
          applicationName: obsApplications.name,
          assessmentTitle: obsAssessments.title,
        })
        .from(obsFindings)
        .innerJoin(obsApplications, eq(obsFindings.applicationId, obsApplications.id))
        .innerJoin(obsAssessments, eq(obsFindings.assessmentId, obsAssessments.id))
        .where(and(...conditions))
        .orderBy(desc(obsFindings.createdAt));
      res.json(rows.map((r) => ({ ...r.finding, applicationName: r.applicationName, assessmentTitle: r.assessmentTitle })));
    } catch (err) {
      handleError(res, err, "findings");
    }
  });

  app.get("/api/observatory/findings/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const [row] = await db
        .select()
        .from(obsFindings)
        .where(and(eq(obsFindings.id, req.params.id), eq(obsFindings.tenantDomain, ctx.tenantDomain)));
      if (!row) return res.status(404).json({ message: "Finding not found" });
      const [application] = await db.select().from(obsApplications).where(eq(obsApplications.id, row.applicationId));
      const [assessment] = await db.select().from(obsAssessments).where(eq(obsAssessments.id, row.assessmentId));
      const version = row.versionId
        ? (await db.select().from(obsVersions).where(eq(obsVersions.id, row.versionId)))[0] ?? null
        : null;
      const evidence = await db
        .select({ evidence: obsEvidence })
        .from(obsFindingEvidence)
        .innerJoin(obsEvidence, eq(obsFindingEvidence.evidenceId, obsEvidence.id))
        .where(eq(obsFindingEvidence.findingId, row.id));
      const controls = await db
        .select({ control: obsControls, framework: obsFrameworks })
        .from(obsFindingControls)
        .innerJoin(obsControls, eq(obsFindingControls.controlId, obsControls.id))
        .innerJoin(obsFrameworks, eq(obsControls.frameworkId, obsFrameworks.id))
        .where(eq(obsFindingControls.findingId, row.id));
      res.json({
        ...row,
        application,
        assessment,
        version,
        evidence: evidence.map((e) => e.evidence),
        controls: controls.map((c) => ({ ...c.control, framework: c.framework })),
      });
    } catch (err) {
      handleError(res, err, "finding");
    }
  });

  // applicationId is omitted because the server derives it from the parent
  // assessment on create (and it is immutable on update).
  const findingBodySchema = insertObsFindingSchema
    .omit({ tenantDomain: true, createdBy: true, applicationId: true })
    .extend({ dueDate: dateish, resolvedAt: dateish });

  function validateFindingEnums(data: Partial<z.infer<typeof findingBodySchema>>, res: Response): boolean {
    if (data.severity && !OBS_FINDING_SEVERITIES.includes(data.severity as any)) {
      res.status(400).json({ message: `Invalid severity. Expected one of: ${OBS_FINDING_SEVERITIES.join(", ")}` });
      return false;
    }
    if (data.domain && !OBS_FINDING_DOMAINS.includes(data.domain as any)) {
      res.status(400).json({ message: `Invalid domain. Expected one of: ${OBS_FINDING_DOMAINS.join(", ")}` });
      return false;
    }
    if (data.status && !OBS_FINDING_STATUSES.includes(data.status as any)) {
      res.status(400).json({ message: `Invalid status. Expected one of: ${OBS_FINDING_STATUSES.join(", ")}` });
      return false;
    }
    return true;
  }

  app.post("/api/observatory/findings", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const data = findingBodySchema.parse(req.body);
      if (!validateFindingEnums(data, res)) return;
      const [assessment] = await db
        .select()
        .from(obsAssessments)
        .where(and(eq(obsAssessments.id, data.assessmentId), eq(obsAssessments.tenantDomain, ctx.tenantDomain)));
      if (!assessment) return res.status(404).json({ message: "Assessment not found" });
      const [created] = await db
        .insert(obsFindings)
        .values({
          ...data,
          applicationId: assessment.applicationId,
          versionId: data.versionId ?? assessment.versionId,
          tenantDomain: ctx.tenantDomain,
          createdBy: ctx.userId,
        })
        .returning();
      await audit(ctx, "finding", created.id, "create", `Created finding "${created.title}" (${created.severity})`);
      res.status(201).json(created);
    } catch (err) {
      handleError(res, err, "finding");
    }
  });

  app.patch("/api/observatory/findings/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const data = findingBodySchema.partial().parse(req.body);
      if (!validateFindingEnums(data, res)) return;
      delete (data as any).assessmentId;
      delete (data as any).applicationId;
      const set: Record<string, unknown> = { ...data, updatedAt: new Date() };
      if (data.status && ["remediated", "verified"].includes(data.status) && !data.resolvedAt) {
        set.resolvedAt = new Date();
      }
      const [updated] = await db
        .update(obsFindings)
        .set(set)
        .where(and(eq(obsFindings.id, req.params.id), eq(obsFindings.tenantDomain, ctx.tenantDomain)))
        .returning();
      if (!updated) return res.status(404).json({ message: "Finding not found" });
      await audit(ctx, "finding", updated.id, "update", `Updated finding "${updated.title}"`, { fields: Object.keys(data) });
      res.json(updated);
    } catch (err) {
      handleError(res, err, "finding");
    }
  });

  app.post("/api/observatory/findings/bulk-status", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const { ids, status } = z
        .object({ ids: z.array(z.string()).min(1), status: z.enum(OBS_FINDING_STATUSES) })
        .parse(req.body);
      const set: Record<string, unknown> = { status, updatedAt: new Date() };
      if (["remediated", "verified"].includes(status)) set.resolvedAt = new Date();
      const updated = await db
        .update(obsFindings)
        .set(set)
        .where(and(inArray(obsFindings.id, ids), eq(obsFindings.tenantDomain, ctx.tenantDomain)))
        .returning({ id: obsFindings.id });
      await audit(ctx, "finding", updated.map((u) => u.id).join(","), "bulk_update", `Bulk status → ${status} on ${updated.length} finding(s)`);
      res.json({ updated: updated.length });
    } catch (err) {
      handleError(res, err, "findings bulk update");
    }
  });

  app.delete("/api/observatory/findings/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canDelete(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const [deleted] = await db
        .delete(obsFindings)
        .where(and(eq(obsFindings.id, req.params.id), eq(obsFindings.tenantDomain, ctx.tenantDomain)))
        .returning();
      if (!deleted) return res.status(404).json({ message: "Finding not found" });
      await audit(ctx, "finding", deleted.id, "delete", `Deleted finding "${deleted.title}"`);
      res.json({ success: true });
    } catch (err) {
      handleError(res, err, "finding");
    }
  });

  // Finding ↔ evidence / control links
  app.post("/api/observatory/findings/:id/evidence/:evidenceId", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const [finding] = await db
        .select()
        .from(obsFindings)
        .where(and(eq(obsFindings.id, req.params.id), eq(obsFindings.tenantDomain, ctx.tenantDomain)));
      const [ev] = await db
        .select()
        .from(obsEvidence)
        .where(and(eq(obsEvidence.id, req.params.evidenceId), eq(obsEvidence.tenantDomain, ctx.tenantDomain)));
      if (!finding || !ev) return res.status(404).json({ message: "Finding or evidence not found" });
      await db.insert(obsFindingEvidence).values({ findingId: finding.id, evidenceId: ev.id }).onConflictDoNothing();
      await audit(ctx, "finding", finding.id, "link", `Linked evidence "${ev.title}" to finding "${finding.title}"`);
      res.json({ success: true });
    } catch (err) {
      handleError(res, err, "evidence link");
    }
  });

  app.delete("/api/observatory/findings/:id/evidence/:evidenceId", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const [finding] = await db
        .select()
        .from(obsFindings)
        .where(and(eq(obsFindings.id, req.params.id), eq(obsFindings.tenantDomain, ctx.tenantDomain)));
      if (!finding) return res.status(404).json({ message: "Finding not found" });
      await db
        .delete(obsFindingEvidence)
        .where(and(eq(obsFindingEvidence.findingId, finding.id), eq(obsFindingEvidence.evidenceId, req.params.evidenceId)));
      await audit(ctx, "finding", finding.id, "unlink", "Unlinked evidence from finding");
      res.json({ success: true });
    } catch (err) {
      handleError(res, err, "evidence unlink");
    }
  });

  app.delete("/api/observatory/assessments/:id/evidence/:evidenceId", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const [assessment] = await db
        .select()
        .from(obsAssessments)
        .where(and(eq(obsAssessments.id, req.params.id), eq(obsAssessments.tenantDomain, ctx.tenantDomain)));
      if (!assessment) return res.status(404).json({ message: "Assessment not found" });
      await db
        .delete(obsAssessmentEvidence)
        .where(and(eq(obsAssessmentEvidence.assessmentId, assessment.id), eq(obsAssessmentEvidence.evidenceId, req.params.evidenceId)));
      await audit(ctx, "assessment", assessment.id, "unlink", "Unlinked evidence from assessment");
      res.json({ success: true });
    } catch (err) {
      handleError(res, err, "evidence unlink");
    }
  });

  app.post("/api/observatory/findings/:id/controls/:controlId", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const [finding] = await db
        .select()
        .from(obsFindings)
        .where(and(eq(obsFindings.id, req.params.id), eq(obsFindings.tenantDomain, ctx.tenantDomain)));
      const [control] = await db.select().from(obsControls).where(eq(obsControls.id, req.params.controlId));
      if (!finding || !control) return res.status(404).json({ message: "Finding or control not found" });
      await db.insert(obsFindingControls).values({ findingId: finding.id, controlId: control.id }).onConflictDoNothing();
      await audit(ctx, "finding", finding.id, "link", `Mapped control ${control.controlId} to finding "${finding.title}"`);
      res.json({ success: true });
    } catch (err) {
      handleError(res, err, "control link");
    }
  });

  app.delete("/api/observatory/findings/:id/controls/:controlId", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const [finding] = await db
        .select()
        .from(obsFindings)
        .where(and(eq(obsFindings.id, req.params.id), eq(obsFindings.tenantDomain, ctx.tenantDomain)));
      if (!finding) return res.status(404).json({ message: "Finding not found" });
      await db
        .delete(obsFindingControls)
        .where(and(eq(obsFindingControls.findingId, finding.id), eq(obsFindingControls.controlId, req.params.controlId)));
      await audit(ctx, "finding", finding.id, "unlink", "Unmapped control from finding");
      res.json({ success: true });
    } catch (err) {
      handleError(res, err, "control unlink");
    }
  });

  // ── Evidence ──────────────────────────────────────────────────────────────

  /**
   * Strip the raw object-storage path from an evidence row before sending it
   * to the client.  Callers should use GET /api/observatory/evidence/:id/file
   * (which enforces tenant ownership) to download the actual file.  Exposing
   * the raw /objects/ path would let a determined user bypass that check.
   */
  function sanitizeEvidence<T extends { fileUrl?: string | null }>(row: T): Omit<T, "fileUrl"> & { hasFile: boolean } {
    const { fileUrl, ...rest } = row;
    return { ...rest, hasFile: !!fileUrl };
  }

  app.get("/api/observatory/evidence", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const conditions = [eq(obsEvidence.tenantDomain, ctx.tenantDomain)];
      if (typeof req.query.type === "string") conditions.push(eq(obsEvidence.evidenceType, req.query.type));
      if (typeof req.query.search === "string" && req.query.search.trim()) {
        const term = `%${req.query.search.trim()}%`;
        conditions.push(or(ilike(obsEvidence.title, term), ilike(obsEvidence.description, term))!);
      }
      const rows = await db
        .select()
        .from(obsEvidence)
        .where(and(...conditions))
        .orderBy(desc(obsEvidence.createdAt));
      res.json(rows.map(sanitizeEvidence));
    } catch (err) {
      handleError(res, err, "evidence");
    }
  });

  app.get("/api/observatory/evidence/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const [row] = await db
        .select()
        .from(obsEvidence)
        .where(and(eq(obsEvidence.id, req.params.id), eq(obsEvidence.tenantDomain, ctx.tenantDomain)));
      if (!row) return res.status(404).json({ message: "Evidence not found" });
      const findings = await db
        .select({ finding: obsFindings })
        .from(obsFindingEvidence)
        .innerJoin(obsFindings, eq(obsFindingEvidence.findingId, obsFindings.id))
        .where(eq(obsFindingEvidence.evidenceId, row.id));
      const assessments = await db
        .select({ assessment: obsAssessments })
        .from(obsAssessmentEvidence)
        .innerJoin(obsAssessments, eq(obsAssessmentEvidence.assessmentId, obsAssessments.id))
        .where(eq(obsAssessmentEvidence.evidenceId, row.id));
      const versions = await db
        .select({ version: obsVersions })
        .from(obsVersionEvidence)
        .innerJoin(obsVersions, eq(obsVersionEvidence.versionId, obsVersions.id))
        .where(eq(obsVersionEvidence.evidenceId, row.id));
      const controls = await db
        .select({ control: obsControls, framework: obsFrameworks })
        .from(obsControlEvidence)
        .innerJoin(obsControls, eq(obsControlEvidence.controlId, obsControls.id))
        .innerJoin(obsFrameworks, eq(obsControls.frameworkId, obsFrameworks.id))
        .where(eq(obsControlEvidence.evidenceId, row.id));
      res.json({
        ...sanitizeEvidence(row),
        findings: findings.map((f) => f.finding),
        assessments: assessments.map((a) => a.assessment),
        versions: versions.map((v) => v.version),
        controls: controls.map((c) => ({ ...c.control, framework: c.framework })),
      });
    } catch (err) {
      handleError(res, err, "evidence");
    }
  });

  app.get("/api/observatory/evidence/:id/file", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const [row] = await db
        .select()
        .from(obsEvidence)
        .where(and(eq(obsEvidence.id, req.params.id), eq(obsEvidence.tenantDomain, ctx.tenantDomain)));
      if (!row) return res.status(404).json({ message: "Evidence not found" });
      if (!row.fileUrl) return res.status(404).json({ message: "No file attached to this evidence" });

      const objectStorageService = new ObjectStorageService();
      const objectFile = await objectStorageService.getObjectEntityFile(row.fileUrl);

      if (row.fileName) {
        res.setHeader("Content-Disposition", `attachment; filename="${row.fileName.replace(/"/g, '\\"')}"`);
      }
      if (row.contentType) {
        res.setHeader("Content-Type", row.contentType);
      }

      await objectStorageService.downloadObject(objectFile, res);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        return res.status(404).json({ message: "File not found in storage" });
      }
      handleError(res, err, "evidence file");
    }
  });

  const evidenceBodySchema = insertObsEvidenceSchema
    .omit({ tenantDomain: true, createdBy: true })
    .extend({ collectedAt: dateish });

  app.post("/api/observatory/evidence", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const data = evidenceBodySchema.parse(req.body);
      if (data.evidenceType && !OBS_EVIDENCE_TYPES.includes(data.evidenceType as any)) {
        return res.status(400).json({ message: `Invalid evidence type. Expected one of: ${OBS_EVIDENCE_TYPES.join(", ")}` });
      }
      const [created] = await db
        .insert(obsEvidence)
        .values({ ...data, tenantDomain: ctx.tenantDomain, createdBy: ctx.userId })
        .returning();
      // Optional immediate links
      const linkFindingId = typeof req.body.linkFindingId === "string" ? req.body.linkFindingId : null;
      const linkAssessmentId = typeof req.body.linkAssessmentId === "string" ? req.body.linkAssessmentId : null;
      const linkVersionId = typeof req.body.linkVersionId === "string" ? req.body.linkVersionId : null;
      if (linkFindingId) {
        const [f] = await db.select().from(obsFindings).where(and(eq(obsFindings.id, linkFindingId), eq(obsFindings.tenantDomain, ctx.tenantDomain)));
        if (f) await db.insert(obsFindingEvidence).values({ findingId: f.id, evidenceId: created.id }).onConflictDoNothing();
      }
      if (linkAssessmentId) {
        const [a] = await db.select().from(obsAssessments).where(and(eq(obsAssessments.id, linkAssessmentId), eq(obsAssessments.tenantDomain, ctx.tenantDomain)));
        if (a) await db.insert(obsAssessmentEvidence).values({ assessmentId: a.id, evidenceId: created.id }).onConflictDoNothing();
      }
      if (linkVersionId) {
        const [v] = await db.select().from(obsVersions).where(and(eq(obsVersions.id, linkVersionId), eq(obsVersions.tenantDomain, ctx.tenantDomain)));
        if (v) await db.insert(obsVersionEvidence).values({ versionId: v.id, evidenceId: created.id }).onConflictDoNothing();
      }
      await audit(ctx, "evidence", created.id, "create", `Added evidence "${created.title}"`);
      res.status(201).json(sanitizeEvidence(created));
    } catch (err) {
      handleError(res, err, "evidence");
    }
  });

  app.patch("/api/observatory/evidence/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const data = evidenceBodySchema.partial().parse(req.body);
      const [existing] = await db
        .select({ fileUrl: obsEvidence.fileUrl })
        .from(obsEvidence)
        .where(and(eq(obsEvidence.id, req.params.id), eq(obsEvidence.tenantDomain, ctx.tenantDomain)));
      if (!existing) return res.status(404).json({ message: "Evidence not found" });
      const [updated] = await db
        .update(obsEvidence)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(obsEvidence.id, req.params.id), eq(obsEvidence.tenantDomain, ctx.tenantDomain)))
        .returning();
      if (!updated) return res.status(404).json({ message: "Evidence not found" });
      if (existing.fileUrl && "fileUrl" in data && data.fileUrl !== existing.fileUrl) {
        objectStorageService.tryDeleteObjectEntity(existing.fileUrl);
      }
      await audit(ctx, "evidence", updated.id, "update", `Updated evidence "${updated.title}"`, { fields: Object.keys(data) });
      res.json(sanitizeEvidence(updated));
    } catch (err) {
      handleError(res, err, "evidence");
    }
  });

  app.delete("/api/observatory/evidence/:id", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canDelete(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const [deleted] = await db
        .delete(obsEvidence)
        .where(and(eq(obsEvidence.id, req.params.id), eq(obsEvidence.tenantDomain, ctx.tenantDomain)))
        .returning();
      if (!deleted) return res.status(404).json({ message: "Evidence not found" });
      if (deleted.fileUrl) {
        objectStorageService.tryDeleteObjectEntity(deleted.fileUrl);
      }
      await audit(ctx, "evidence", deleted.id, "delete", `Deleted evidence "${deleted.title}"`);
      res.json({ success: true });
    } catch (err) {
      handleError(res, err, "evidence");
    }
  });

  // ── Standards library (global, read-only) ─────────────────────────────────
  app.get("/api/observatory/frameworks", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const rows = await db
        .select({
          framework: obsFrameworks,
          controlCount: sql<number>`count(${obsControls.id})::int`,
        })
        .from(obsFrameworks)
        .leftJoin(obsControls, eq(obsControls.frameworkId, obsFrameworks.id))
        .groupBy(obsFrameworks.id)
        .orderBy(asc(obsFrameworks.sortOrder));
      res.json(rows.map((r) => ({ ...r.framework, controlCount: r.controlCount })));
    } catch (err) {
      handleError(res, err, "frameworks");
    }
  });

  app.get("/api/observatory/frameworks/:id/controls", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const [fw] = await db.select().from(obsFrameworks).where(eq(obsFrameworks.id, req.params.id));
      if (!fw) return res.status(404).json({ message: "Framework not found" });
      const controls = await db
        .select()
        .from(obsControls)
        .where(eq(obsControls.frameworkId, fw.id))
        .orderBy(asc(obsControls.sortOrder));
      res.json({ ...fw, controls });
    } catch (err) {
      handleError(res, err, "framework controls");
    }
  });

  // Flat control search (for mapping pickers)
  app.get("/api/observatory/controls", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const conditions = [] as any[];
      if (typeof req.query.frameworkId === "string") conditions.push(eq(obsControls.frameworkId, req.query.frameworkId));
      if (typeof req.query.search === "string" && req.query.search.trim()) {
        const term = `%${req.query.search.trim()}%`;
        conditions.push(or(ilike(obsControls.title, term), ilike(obsControls.controlId, term))!);
      }
      const rows = await db
        .select({ control: obsControls, frameworkName: obsFrameworks.name, frameworkCode: obsFrameworks.code })
        .from(obsControls)
        .innerJoin(obsFrameworks, eq(obsControls.frameworkId, obsFrameworks.id))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(asc(obsFrameworks.sortOrder), asc(obsControls.sortOrder))
        .limit(200);
      res.json(rows.map((r) => ({ ...r.control, frameworkName: r.frameworkName, frameworkCode: r.frameworkCode })));
    } catch (err) {
      handleError(res, err, "controls");
    }
  });

  // ── Dashboard stats ───────────────────────────────────────────────────────
  app.get("/api/observatory/stats", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const t = ctx.tenantDomain;
      const [apps] = await db.select({ count: sql<number>`count(*)::int` }).from(obsApplications).where(eq(obsApplications.tenantDomain, t));
      const [versions] = await db.select({ count: sql<number>`count(*)::int` }).from(obsVersions).where(eq(obsVersions.tenantDomain, t));
      const [assessments] = await db.select({ count: sql<number>`count(*)::int` }).from(obsAssessments).where(eq(obsAssessments.tenantDomain, t));
      const [evidence] = await db.select({ count: sql<number>`count(*)::int` }).from(obsEvidence).where(eq(obsEvidence.tenantDomain, t));
      const findingsBySeverity = await db
        .select({ severity: obsFindings.severity, count: sql<number>`count(*)::int` })
        .from(obsFindings)
        .where(and(eq(obsFindings.tenantDomain, t), inArray(obsFindings.status, ["open", "in_progress"])))
        .groupBy(obsFindings.severity);
      const findingsByStatus = await db
        .select({ status: obsFindings.status, count: sql<number>`count(*)::int` })
        .from(obsFindings)
        .where(eq(obsFindings.tenantDomain, t))
        .groupBy(obsFindings.status);
      const recentAudit = await db
        .select()
        .from(obsAuditLogs)
        .where(eq(obsAuditLogs.tenantDomain, t))
        .orderBy(desc(obsAuditLogs.createdAt))
        .limit(10);
      res.json({
        applications: apps.count,
        versions: versions.count,
        assessments: assessments.count,
        evidence: evidence.count,
        openFindingsBySeverity: findingsBySeverity,
        findingsByStatus,
        recentActivity: recentAudit,
      });
    } catch (err) {
      handleError(res, err, "stats");
    }
  });

  // ── Audit log history ────────────────────────────────────────────────────
  app.get("/api/observatory/audit-logs", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    try {
      const rows = await db
        .select()
        .from(obsAuditLogs)
        .where(eq(obsAuditLogs.tenantDomain, ctx.tenantDomain))
        .orderBy(desc(obsAuditLogs.createdAt))
        .limit(200);
      res.json(rows);
    } catch (err) {
      handleError(res, err, "audit-logs");
    }
  });

  // ── Automated scan ───────────────────────────────────────────────────────
  /**
   * POST /api/observatory/assessments/:id/scan
   * Enqueue a built-in automated scan for the given assessment.
   * Supported types: accessibility, penetration_test, performance.
   */
  app.post("/api/observatory/assessments/:id/scan", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });

    const assessmentId = req.params.id;

    // Verify assessment belongs to this tenant and is of a scannable type
    const [assessment] = await db
      .select({ id: obsAssessments.id, type: obsAssessments.type, status: obsAssessments.status })
      .from(obsAssessments)
      .where(and(eq(obsAssessments.id, assessmentId), eq(obsAssessments.tenantDomain, ctx.tenantDomain)));

    if (!assessment) return res.status(404).json({ message: "Assessment not found" });
    if (!SCANNABLE_TYPES.has(assessment.type)) {
      return res.status(400).json({ message: `Assessment type "${assessment.type}" does not support automated scanning. Supported: ${[...SCANNABLE_TYPES].join(", ")}` });
    }

    const scanLabel = `scan:${assessment.type}:${assessmentId}`;

    // Reject if a scan is already running for this assessment
    const existing = getJobStatusByLabel(scanLabel, ctx.tenantDomain);
    if (existing.status === "active" || existing.status === "pending") {
      return res.status(409).json({ message: "A scan is already queued or running for this assessment.", jobStatus: existing });
    }

    // Optional pageLimit for accessibility scans (1–25, default 10 in scanner)
    const rawPageLimit = req.body?.pageLimit;
    let pageLimit: number | undefined;
    if (rawPageLimit !== undefined && rawPageLimit !== null) {
      const parsed = Number(rawPageLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 25) {
        return res.status(400).json({ message: "pageLimit must be an integer between 1 and 25" });
      }
      pageLimit = parsed;
    }

    // Enqueue — don't await; the job runs in the background
    enqueueScan(
      scanLabel,
      async (signal) => runObservatoryScan({ assessmentId, tenantDomain: ctx.tenantDomain, triggeredByUserId: ctx.userId, signal, pageLimit }),
      { ctx: { tenantDomain: ctx.tenantDomain, targetId: assessmentId } },
    ).catch((err) => {
      console.error(`[observatory] scan job failed for ${assessmentId}:`, err);
    });

    await audit(ctx, "assessment", assessmentId, "scan_triggered", `Automated ${assessment.type} scan queued${pageLimit != null ? ` (pageLimit=${pageLimit})` : ""}`);
    res.json({ queued: true, label: scanLabel });
  });

  /**
   * GET /api/observatory/assessments/:id/scan-status
   * Poll the status of an in-flight scan job for the given assessment.
   *
   * Falls back to scheduled_job_runs when the in-memory job is not found so
   * the UI can show the real failure reason instead of spinning forever. This
   * covers two scenarios:
   *   (a) Normal failure — runObservatoryScan throws/times out, restores the
   *       assessment status, removes the job from memory. The scheduled_job_runs
   *       row has status="failed" with errorMessage.
   *   (b) Autoscale instance recycle — job is lost from memory while the
   *       assessment is still in_progress. No DB failure row exists, so we
   *       surface a generic "server restarted" message.
   *
   * Recency guard (30 min): avoids surfacing a stale failure from an old scan
   * after a later successful scan has completed and the job is long gone.
   */
  app.get("/api/observatory/assessments/:id/scan-status", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;

    const assessmentId = req.params.id;
    const [assessment] = await db
      .select({ type: obsAssessments.type, status: obsAssessments.status })
      .from(obsAssessments)
      .where(and(eq(obsAssessments.id, assessmentId), eq(obsAssessments.tenantDomain, ctx.tenantDomain)));

    if (!assessment) return res.status(404).json({ message: "Assessment not found" });

    const scanLabel = `scan:${assessment.type}:${assessmentId}`;
    const jobStatus = getJobStatusByLabel(scanLabel, ctx.tenantDomain);

    // If the job is found in memory, return it directly.
    if (jobStatus.status !== "not_found") {
      return res.json({ ...jobStatus, label: scanLabel, scannable: SCANNABLE_TYPES.has(assessment.type) });
    }

    // Job not in memory — check scheduled_job_runs for a recent (< 30 min)
    // failed run for this assessment. This surfaces real error messages after
    // a scan throws or times out (runObservatoryScan restores assessment status
    // on failure, so checking assessment.status === "in_progress" is wrong).
    const recentCutoff = new Date(Date.now() - 30 * 60 * 1000);
    const [latestRun] = await db
      .select({
        status: scheduledJobRuns.status,
        errorMessage: scheduledJobRuns.errorMessage,
        startedAt: scheduledJobRuns.startedAt,
      })
      .from(scheduledJobRuns)
      .where(
        and(
          eq(scheduledJobRuns.jobLabel, scanLabel),
          eq(scheduledJobRuns.tenantDomain, ctx.tenantDomain),
          gte(scheduledJobRuns.startedAt, recentCutoff),
        ),
      )
      .orderBy(desc(scheduledJobRuns.startedAt))
      .limit(1);

    if (latestRun?.status === "failed") {
      return res.json({
        status: "failed",
        errorMessage: latestRun.errorMessage ?? "The scan encountered an error. Please try again.",
        label: scanLabel,
        scannable: SCANNABLE_TYPES.has(assessment.type),
      });
    }

    // Secondary fallback: no recent DB run but assessment is still in_progress
    // — the job was lost mid-run (Autoscale instance recycle).
    if (!latestRun && assessment.status === "in_progress") {
      return res.json({
        status: "failed",
        errorMessage: "Scan job was lost — the server may have restarted. Please try scanning again.",
        label: scanLabel,
        scannable: SCANNABLE_TYPES.has(assessment.type),
      });
    }

    // For completed accessibility scans, surface the partial-scan flag from the
    // most recent scan_report evidence so the UI can warn users when the time
    // budget stopped early and not all pages were covered.
    let partialScanInfo: { partial: boolean; scannedPages: number; discoveredPages: number } | undefined;
    if (assessment.type === "accessibility" && jobStatus.status === "not_found") {
      try {
        const [latestEvidence] = await db
          .select({ body: obsEvidence.body })
          .from(obsAssessmentEvidence)
          .innerJoin(obsEvidence, eq(obsAssessmentEvidence.evidenceId, obsEvidence.id))
          .where(
            and(
              eq(obsAssessmentEvidence.assessmentId, assessmentId),
              eq(obsEvidence.evidenceType, "scan_report"),
            ),
          )
          .orderBy(desc(obsEvidence.createdAt))
          .limit(1);
        if (latestEvidence?.body) {
          const reportObj = JSON.parse(latestEvidence.body) as any;
          const scannedPages = Array.isArray(reportObj?.scannedPages) ? reportObj.scannedPages.length : null;
          const discoveredPages = typeof reportObj?.discoveredPages === "number" ? reportObj.discoveredPages : null;
          const pageLimit = typeof reportObj?.pageLimit === "number" ? reportObj.pageLimit : null;
          if (scannedPages !== null && discoveredPages !== null) {
            partialScanInfo = {
              partial: scannedPages < discoveredPages,
              scannedPages,
              discoveredPages,
              ...(pageLimit !== null ? { pageLimit } : {}),
            };
          }
        }
      } catch {
        // Non-critical: if we can't parse the evidence body, just omit partial info
      }
    }

    res.json({ ...jobStatus, label: scanLabel, scannable: SCANNABLE_TYPES.has(assessment.type), ...partialScanInfo });
  });

  // ── Demo seed ─────────────────────────────────────────────────────────────
  app.post("/api/observatory/seed-demo", async (req, res) => {
    const ctx = await ctxOr401(req, res);
    if (!ctx) return;
    if (!canWrite(ctx)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const result = await seedObservatoryDemo(ctx.tenantDomain, ctx.userId);
      if (result.seeded) {
        await audit(ctx, "application", "demo-seed", "create", "Loaded Observatory sample data");
      }
      res.json(result);
    } catch (err) {
      handleError(res, err, "demo seed");
    }
  });
}
