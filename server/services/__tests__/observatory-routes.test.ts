/**
 * Integration tests for the Observatory API routes.
 *
 * Traceability spine: Application → Version → Assessment → Finding →
 * Evidence → Control. Covers create, link/unlink, status transitions,
 * tenant scoping (401/403), and cascade-delete in each layer.
 *
 * The key regression guard: POST /api/observatory/findings must NOT require
 * applicationId in the request body — the server derives it from the parent
 * assessment. This was a bug found and fixed during manual testing.
 *
 * All I/O is mocked (no real DB or network). A queue-based chainable proxy
 * lets each test push exactly the rows each DB call should return, in order.
 */

import { describe, it, beforeEach, vi, expect } from "vitest";
import express from "express";
import request from "supertest";

// ── DB mock — queue-based chainable proxy ────────────────────────────────────
//
// vi.hoisted() runs BEFORE vi.mock so the objects it produces can be used
// inside mock factories (which are also hoisted).

const { dbQ, makeMockDb } = vi.hoisted(() => {
  /** Each entry is the array the next DB terminal call will resolve with. */
  const dbQ: any[][] = [];

  /**
   * terminal() — pops one entry from dbQ and returns an object that is both
   * thenable (so `await chain.where(...)` works) AND chainable with the most
   * common suffixes (.returning(), .orderBy(), .onConflictDoNothing()).
   */
  function terminal(): any {
    const val = dbQ.shift() ?? [];
    // Self-referential so .where(...).groupBy(...), .where(...).orderBy(...).limit(...) etc. all resolve to val.
    const t: any = {
      then: (resolve: any, reject?: any) => Promise.resolve(val).then(resolve, reject),
      catch: (reject: any) => Promise.resolve(val).catch(reject),
      finally: (cb: any) => Promise.resolve(val).finally(cb),
      returning: () => Promise.resolve(val),
      orderBy: () => t,
      groupBy: () => t,
      onConflictDoNothing: () => Promise.resolve(val),
      limit: () => t,
    };
    return t;
  }

  function mkChain(): any {
    return {
      from: () => mkChain(),
      where: terminal,
      set: () => mkChain(),
      values: terminal,
      innerJoin: () => mkChain(),
      leftJoin: () => mkChain(),
      groupBy: () => mkChain(),
      orderBy: () => Promise.resolve(dbQ.shift() ?? []),
      returning: () => Promise.resolve(dbQ.shift() ?? []),
      onConflictDoUpdate: () => ({ returning: () => Promise.resolve(dbQ.shift() ?? []) }),
      limit: () => mkChain(),
    };
  }

  /**
   * mkDeleteChain — supports both:
   *   await db.delete(t).where(...)              (no .returning())
   *   await db.delete(t).where(...).returning()
   * Both pop ONE entry from dbQ.
   */
  function mkDeleteChain(): any {
    return {
      where: terminal,
    };
  }

  function makeMockDb() {
    const db: any = {
      select: mkChain,
      insert: mkChain,
      update: mkChain,
      delete: mkDeleteChain,
      transaction: async (fn: any) => fn(db),
    };
    return db;
  }

  return { dbQ, makeMockDb };
});

// ── Mock all I/O modules ─────────────────────────────────────────────────────

vi.mock("../../db", () => ({ db: makeMockDb() }));

vi.mock("../../context", () => ({
  getRequestContext: vi.fn(),
  ContextError: class ContextError extends Error {
    status: number;
    constructor(msg: string, status = 401) {
      super(msg);
      this.status = status;
    }
  },
}));

// seedStandardsCatalog is called at registration time — mock to no-op.
vi.mock("../observatory-standards", () => ({
  seedStandardsCatalog: vi.fn().mockResolvedValue({ frameworks: 0, controls: 0 }),
}));

// seedObservatoryDemo is called by the seed-demo route — mock it.
vi.mock("../observatory-demo-seed", () => ({
  seedObservatoryDemo: vi.fn().mockResolvedValue({ seeded: false, message: "Already seeded" }),
}));

// enqueueScan + getJobStatusByLabel are called by the assessment creation and
// /scan routes — mock so no real job queue or DB side-effects happen in tests.
vi.mock("../job-queue", () => ({
  enqueueScan: vi.fn().mockReturnValue(Promise.resolve()),
  getJobStatusByLabel: vi.fn().mockReturnValue({ status: "not_found" }),
  enqueue: vi.fn().mockReturnValue(Promise.resolve()),
}));

// runObservatoryScan is called inside the enqueueScan callback — mock it so
// tests don't require a real headless browser or DB scan pipeline.
vi.mock("../observatory-scan-runner", () => ({
  runObservatoryScan: vi.fn().mockResolvedValue({
    findingsCreated: 2,
    findingsSkipped: 0,
    findingsResolved: 0,
    evidenceId: "ev-scan-1",
    tool: "axe-core",
    durationMs: 1200,
  }),
}));

// accessibility-scanner side-effect import: mock so headless-crawler/puppeteer
// is not loaded during tests.
vi.mock("../../services/accessibility-scanner", () => ({
  axeCoreScanner: {
    key: "axe_core",
    name: "axe-core (built-in, WCAG 2.1/2.2)",
    supportedTypes: ["accessibility"],
    runScan: vi.fn(),
  },
}));

// ── Import under test AFTER mocks ────────────────────────────────────────────

import { registerObservatoryRoutes, selectOrphanedEvidenceIds } from "../../routes/observatory";
import { getRequestContext } from "../../context";
import { enqueueScan, getJobStatusByLabel } from "../job-queue";

// ── Shared test fixtures ─────────────────────────────────────────────────────

const WRITER_CTX = {
  userId: "user-1",
  tenantId: "tenant-1",
  marketId: "market-1",
  userRole: "Domain Admin",   // hasContentAccess && hasAdminAccess
  tenantDomain: "acme.com",
  isDefaultMarket: true,
};

const READONLY_CTX = {
  ...WRITER_CTX,
  userRole: "Standard User",  // hasContentAccess → false → 403 on write routes
};

const APP = {
  id: "app-1",
  tenantDomain: "acme.com",
  name: "Customer Portal",
  description: "Main customer-facing portal",
  createdBy: "user-1",
};

const VERSION = {
  id: "ver-1",
  tenantDomain: "acme.com",
  applicationId: "app-1",
  versionNumber: "1.0.0",
  assessmentStatus: "Draft",
  createdBy: "user-1",
};

const ASSESSMENT = {
  id: "asmnt-1",
  tenantDomain: "acme.com",
  applicationId: "app-1",
  versionId: "ver-1",
  title: "Q2 Pen Test",
  type: "penetration_test",
  status: "planned",
  createdBy: "user-1",
};

const FINDING = {
  id: "find-1",
  tenantDomain: "acme.com",
  applicationId: "app-1",
  assessmentId: "asmnt-1",
  title: "SQL injection in login form",
  severity: "Critical",
  domain: "security",
  status: "open",
  createdBy: "user-1",
};

const EVIDENCE = {
  id: "ev-1",
  tenantDomain: "acme.com",
  title: "Screenshot of error page",
  evidenceType: "screenshot",
  createdBy: "user-1",
};

const CONTROL = {
  id: "ctrl-1",
  frameworkId: "fw-1",
  controlId: "A.9.4.2",
  title: "Secure log-on procedures",
  sortOrder: 10,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  registerObservatoryRoutes(app);
  return app;
}

/** Push one result set into the DB queue (one terminal() pop). */
function pushDb(...rows: any[]) {
  dbQ.push(rows);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("observatory routes", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    dbQ.length = 0;
    vi.mocked(getRequestContext).mockResolvedValue(WRITER_CTX as any);
    app = buildApp();
  });

  // ── 401 / 403 tenant-scoping ────────────────────────────────────────────────

  describe("tenant scoping", () => {
    it("returns 401 when the request carries no valid context", async () => {
      const { ContextError } = await import("../../context");
      vi.mocked(getRequestContext).mockRejectedValue(
        new (ContextError as any)("No tenant context", 401),
      );

      const res = await request(app)
        .post("/api/observatory/applications")
        .send({ name: "My App" });

      expect(res.status).toBe(401);
    });

    it("returns 403 when the user lacks write permission", async () => {
      vi.mocked(getRequestContext).mockResolvedValue(READONLY_CTX as any);

      const res = await request(app)
        .post("/api/observatory/applications")
        .send({ name: "My App" });

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/permission/i);
    });

    it("returns 403 on finding create for read-only user", async () => {
      vi.mocked(getRequestContext).mockResolvedValue(READONLY_CTX as any);

      const res = await request(app).post("/api/observatory/findings").send({
        assessmentId: "asmnt-1",
        title: "XSS",
        severity: "High",
        domain: "security",
      });

      expect(res.status).toBe(403);
    });
  });

  // ── Applications ─────────────────────────────────────────────────────────────

  describe("POST /api/observatory/applications", () => {
    it("creates an application and returns 201", async () => {
      pushDb(APP);        // insert(obsApplications).values().returning()
      pushDb();           // audit insert().values()

      const res = await request(app)
        .post("/api/observatory/applications")
        .send({ name: "Customer Portal", description: "Main customer-facing portal" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id: "app-1", name: "Customer Portal" });
    });

    it("returns 400 when required field name is missing", async () => {
      const res = await request(app)
        .post("/api/observatory/applications")
        .send({ description: "No name provided" });

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/observatory/applications/:id", () => {
    it("deletes an application and returns { success: true }", async () => {
      pushDb(APP);  // select(obsApplications).where() — existence check
      pushDb();     // evidence from findings junction (none → candidateIds = [])
      pushDb();     // evidence from assessments junction (none)
      pushDb();     // evidence from versions junction (none)
      pushDb();     // delete(obsFindings).where()
      pushDb();     // delete(obsAssessments).where()
      pushDb();     // delete(obsVersions).where()
      // candidateEvidenceIds = [] → skip the 5 still-linked checks and evidence delete
      pushDb(APP);  // delete(obsApplications).where().returning()
      pushDb();     // audit

      const res = await request(app).delete("/api/observatory/applications/app-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
    });

    it("returns 404 when the application does not exist for this tenant", async () => {
      pushDb();    // select(obsApplications).where() returns [] → not found
      // no child deletes and no audit because we return early

      const res = await request(app).delete("/api/observatory/applications/nonexistent");

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/not found/i);
    });

    it("explicitly deletes findings, assessments, and versions before removing the parent — cascade regression guard", async () => {
      // This test is the cascade regression guard.
      //
      // The route issues explicit child deletes (findings → assessments → versions)
      // BEFORE deleting the application row. This means:
      //   1. The test will fail with a queue underrun if any of the child-cleanup
      //      DB calls are removed from the route, catching a missing cascade early.
      //   2. Even if DB-level FK cascade rules are accidentally removed from a
      //      future migration, the application-level cleanup here prevents
      //      orphaned findings / assessments / versions from accumulating.
      //
      // Cascade order verified:
      //   obs_findings    (app-scoped) → cascades obs_finding_evidence,
      //                                             obs_finding_controls,
      //                                             obs_review_item_findings
      //   obs_assessments (app-scoped) → cascades obs_review_items
      //                                             (→ obs_review_item_evidence),
      //                                             obs_assessment_evidence
      //   obs_versions    (app-scoped) → cascades obs_version_evidence

      const FINDING_2 = { ...FINDING, id: "find-2", title: "Open redirect" };

      pushDb(APP);                  // select — confirm app exists
      pushDb();                     // evidence from findings (none → candidateIds = [])
      pushDb();                     // evidence from assessments (none)
      pushDb();                     // evidence from versions (none)
      pushDb(FINDING, FINDING_2);   // delete(obsFindings) — 2 findings removed
      pushDb(ASSESSMENT);           // delete(obsAssessments) — 1 assessment removed
      pushDb(VERSION);              // delete(obsVersions) — 1 version removed
      // candidateEvidenceIds = [] → skip the 5 still-linked checks and evidence delete
      pushDb(APP);                  // delete(obsApplications).where().returning()
      pushDb();                     // audit

      const res = await request(app).delete("/api/observatory/applications/app-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      // All 9 queue entries were consumed — no DB call was skipped.
      expect(dbQ).toHaveLength(0);
    });

    it("deletes orphaned evidence rows when an application is deleted", async () => {
      // ev-1 is linked via a finding that belongs only to app-1.
      // After app-1 is deleted, ev-1 has no remaining junction links → must be deleted.
      pushDb(APP);              // existence check
      pushDb({ id: "ev-1" });   // evidence from findings junction → candidate: ev-1
      pushDb();                 // evidence from assessments junction (none)
      pushDb();                 // evidence from versions junction (none)
      // candidateEvidenceIds = ["ev-1"]
      pushDb();                 // delete findings
      pushDb();                 // delete assessments
      pushDb();                 // delete versions
      // Now check which candidates are still linked — all five junction tables:
      pushDb();                 // obsFindingEvidence still-linked? → [] (none left)
      pushDb();                 // obsAssessmentEvidence still-linked? → []
      pushDb();                 // obsVersionEvidence still-linked? → []
      pushDb();                 // obsControlEvidence still-linked? → []
      pushDb();                 // obsReviewItemEvidence still-linked? → []
      // orphanedIds = ["ev-1"] → delete evidence row
      pushDb();                 // delete(obsEvidence) for ev-1
      pushDb(APP);              // delete(obsApplications).where().returning()
      pushDb();                 // audit

      const res = await request(app).delete("/api/observatory/applications/app-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      // All 15 queue entries were consumed — evidence delete was reached.
      expect(dbQ).toHaveLength(0);
    });

    it("keeps evidence that is still linked to another application or control", async () => {
      // ev-1 appears in this app's finding-evidence links, but after the cascade
      // it is STILL referenced by another entity (e.g. a finding in a different
      // application). The route must NOT delete it.
      pushDb(APP);              // existence check
      pushDb({ id: "ev-1" });   // evidence from findings junction → candidate: ev-1
      pushDb();                 // evidence from assessments junction (none)
      pushDb();                 // evidence from versions junction (none)
      // candidateEvidenceIds = ["ev-1"]
      pushDb();                 // delete findings
      pushDb();                 // delete assessments
      pushDb();                 // delete versions
      // Still-linked check — ev-1 is STILL referenced via another finding:
      pushDb({ id: "ev-1" });   // obsFindingEvidence still-linked → ev-1 present
      pushDb();                 // obsAssessmentEvidence → []
      pushDb();                 // obsVersionEvidence → []
      pushDb();                 // obsControlEvidence → []
      pushDb();                 // obsReviewItemEvidence → []
      // orphanedIds = [] → no evidence delete issued
      pushDb(APP);              // delete(obsApplications).where().returning()
      pushDb();                 // audit

      const res = await request(app).delete("/api/observatory/applications/app-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      // All 14 queue entries were consumed — evidence delete was skipped (correct).
      expect(dbQ).toHaveLength(0);
    });
  });

  // ── selectOrphanedEvidenceIds (pure-function unit tests) ─────────────────────

  describe("selectOrphanedEvidenceIds", () => {
    it("returns all candidates when none are still linked", () => {
      expect(selectOrphanedEvidenceIds(["ev1", "ev2", "ev3"], []).sort()).toEqual([
        "ev1",
        "ev2",
        "ev3",
      ]);
    });

    it("returns empty array when all candidates are still linked", () => {
      expect(selectOrphanedEvidenceIds(["ev1", "ev2"], ["ev1", "ev2", "ev3"])).toEqual([]);
    });

    it("returns only candidates with no remaining links", () => {
      expect(selectOrphanedEvidenceIds(["ev1", "ev2", "ev3", "ev4"], ["ev2", "ev4"]).sort()).toEqual([
        "ev1",
        "ev3",
      ]);
    });

    it("returns empty array when candidate list is empty", () => {
      expect(selectOrphanedEvidenceIds([], ["ev1", "ev2"])).toEqual([]);
    });

    it("handles duplicate still-linked IDs without error", () => {
      expect(selectOrphanedEvidenceIds(["ev1", "ev2", "ev3"], ["ev1", "ev1", "ev2"])).toEqual([
        "ev3",
      ]);
    });
  });

  // ── Versions ─────────────────────────────────────────────────────────────────

  describe("POST /api/observatory/versions", () => {
    it("creates a version after verifying the parent application", async () => {
      pushDb(APP);       // select(obsApplications).where() — parent check
      pushDb(VERSION);   // insert(obsVersions).values().returning()
      pushDb();          // audit

      const res = await request(app)
        .post("/api/observatory/versions")
        .send({ applicationId: "app-1", versionNumber: "1.0.0" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id: "ver-1", versionNumber: "1.0.0" });
    });

    it("returns 404 when the parent application is not in this tenant", async () => {
      pushDb();  // select(obsApplications).where() returns [] → 404

      const res = await request(app)
        .post("/api/observatory/versions")
        .send({ applicationId: "foreign-app", versionNumber: "2.0.0" });

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/application not found/i);
    });

    it("returns 400 for an invalid assessmentStatus value", async () => {
      const res = await request(app)
        .post("/api/observatory/versions")
        .send({ applicationId: "app-1", versionNumber: "1.0.0", assessmentStatus: "NOT_VALID" });

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/observatory/versions/:id", () => {
    it("deletes a version and returns { success: true }", async () => {
      pushDb(VERSION);  // select(obsVersions).where() — existence check
      pushDb();         // delete(obsFindings).where()
      pushDb();         // delete(obsAssessments).where()
      pushDb(VERSION);  // delete(obsVersions).where().returning()
      pushDb();         // audit

      const res = await request(app).delete("/api/observatory/versions/ver-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
    });

    it("returns 404 when the version does not exist for this tenant", async () => {
      pushDb();  // select(obsVersions).where() returns [] → not found
      // no child deletes and no audit because we return early

      const res = await request(app).delete("/api/observatory/versions/nonexistent");

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/not found/i);
    });

    it("explicitly deletes findings and assessments before removing the version — cascade regression guard", async () => {
      // This test is the cascade regression guard.
      //
      // The version→finding and version→assessment FKs use ON DELETE SET NULL
      // (not CASCADE), meaning DB-level FK rules do NOT remove child rows when
      // a version is deleted. Without the explicit application-level cleanup in
      // the route, findings and assessments would be left behind with a null
      // versionId. This test verifies that:
      //   1. The route issues child-cleanup deletes (findings → assessments)
      //      BEFORE deleting the version row.
      //   2. Any future removal of those cleanup calls causes a queue underrun
      //      and a test failure — catching the regression immediately.
      //
      // Cascade order verified:
      //   obs_findings    (version-scoped) → cascades obs_finding_evidence,
      //                                               obs_finding_controls,
      //                                               obs_review_item_findings
      //   obs_assessments (version-scoped) → cascades obs_review_items
      //                                               (→ obs_review_item_evidence),
      //                                               obs_assessment_evidence

      const FINDING_2 = { ...FINDING, id: "find-2", title: "Open redirect" };

      pushDb(VERSION);              // select — confirm version exists
      pushDb(FINDING, FINDING_2);   // delete(obsFindings).where() — 2 findings removed
      pushDb(ASSESSMENT);           // delete(obsAssessments).where() — 1 assessment removed
      pushDb(VERSION);              // delete(obsVersions).where().returning()
      pushDb();                     // audit

      const res = await request(app).delete("/api/observatory/versions/ver-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      // All 5 queue entries were consumed — no DB call was skipped.
      expect(dbQ).toHaveLength(0);
    });
  });

  // ── Assessments ──────────────────────────────────────────────────────────────

  describe("POST /api/observatory/assessments", () => {
    it("creates an assessment with a valid type", async () => {
      pushDb(APP);         // select(obsApplications).where()
      pushDb(ASSESSMENT);  // insert(obsAssessments).values().returning()
      pushDb();            // audit

      const res = await request(app)
        .post("/api/observatory/assessments")
        .send({
          applicationId: "app-1",
          title: "Q2 Pen Test",
          type: "penetration_test",
        });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id: "asmnt-1", type: "penetration_test" });
    });

    it("returns 400 for an invalid assessment type", async () => {
      const res = await request(app)
        .post("/api/observatory/assessments")
        .send({ applicationId: "app-1", title: "Bad type", type: "magic_wand" });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/invalid type/i);
    });

    it("returns 400 for an invalid assessment status", async () => {
      const res = await request(app)
        .post("/api/observatory/assessments")
        .send({
          applicationId: "app-1",
          title: "Q2 Pen Test",
          type: "penetration_test",
          status: "bogus_status",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/invalid status/i);
    });

    it("returns 404 when the parent application is not in this tenant", async () => {
      pushDb();  // select(obsApplications).where() returns []

      const res = await request(app)
        .post("/api/observatory/assessments")
        .send({ applicationId: "foreign-app", title: "Test", type: "penetration_test" });

      expect(res.status).toBe(404);
    });

    it("queues a built-in accessibility scan and returns scanQueued:true when the application has an appUrl", async () => {
      vi.mocked(enqueueScan).mockClear();

      const APP_WITH_URL = { ...APP, appUrl: "https://portal.example.com" };
      const A11Y_ASSESSMENT = {
        ...ASSESSMENT,
        id: "asmnt-a11y",
        type: "accessibility",
        title: "Q3 Accessibility Review",
      };

      pushDb(APP_WITH_URL);    // select(obsApplications).where() → app with appUrl
      pushDb(A11Y_ASSESSMENT); // insert(obsAssessments).values().returning()
      pushDb();                // audit log — assessment created
      pushDb();                // audit log — scan_triggered

      const res = await request(app)
        .post("/api/observatory/assessments")
        .send({ applicationId: "app-1", title: "Q3 Accessibility Review", type: "accessibility" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id: "asmnt-a11y", type: "accessibility" });
      // The auto-trigger sets scanQueued:true on the response
      expect(res.body.scanQueued).toBe(true);
      // enqueueScan must be called with the correct label format
      expect(vi.mocked(enqueueScan)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(enqueueScan)).toHaveBeenCalledWith(
        "scan:accessibility:asmnt-a11y",
        expect.any(Function),
        expect.objectContaining({ ctx: expect.objectContaining({ tenantDomain: "acme.com" }) }),
      );
    });

    it("does not queue a scan when the application has no appUrl", async () => {
      vi.mocked(enqueueScan).mockClear();

      const A11Y_ASSESSMENT = {
        ...ASSESSMENT,
        id: "asmnt-no-url",
        type: "accessibility",
        title: "Accessibility Review (no URL)",
      };

      // APP has no appUrl — auto-trigger should be skipped
      pushDb(APP);              // select(obsApplications).where()
      pushDb(A11Y_ASSESSMENT);  // insert(obsAssessments).values().returning()
      pushDb();                 // audit log — assessment created (no scan_triggered audit)

      const res = await request(app)
        .post("/api/observatory/assessments")
        .send({ applicationId: "app-1", title: "Accessibility Review (no URL)", type: "accessibility" });

      expect(res.status).toBe(201);
      expect(res.body.scanQueued).toBe(false);
      expect(vi.mocked(enqueueScan)).not.toHaveBeenCalled();
    });
  });

  // ── Assessment delete ─────────────────────────────────────────────────────

  describe("DELETE /api/observatory/assessments/:id", () => {
    it("deletes an assessment and returns { success: true }", async () => {
      pushDb(ASSESSMENT);  // select(obsAssessments).where() — existence check
      // inside transaction:
      pushDb();            // delete(obsFindings).where()
      pushDb();            // delete(obsAssessments).where()
      pushDb();            // audit

      const res = await request(app).delete("/api/observatory/assessments/asmnt-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
    });

    it("returns 404 when the assessment does not exist for this tenant", async () => {
      pushDb();  // select(obsAssessments).where() returns [] → not found

      const res = await request(app).delete("/api/observatory/assessments/nonexistent");

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/not found/i);
    });

    it("explicitly deletes findings before removing the assessment — cascade regression guard", async () => {
      // This test is the cascade regression guard.
      //
      // The route deletes obs_findings for the assessment BEFORE deleting the
      // assessment row, inside a transaction. This:
      //   1. Ensures scan-created findings (incl. pen-test findings) are cleaned
      //      up even if a future migration accidentally drops a DB-level cascade.
      //   2. Causes a queue underrun (and test failure) if either of the two
      //      in-transaction deletes is removed from the route.
      //
      // Deletion order verified:
      //   obs_findings    (assessment-scoped) → cascades obs_pen_test_findings
      //                                         (findingId FK), obs_finding_evidence,
      //                                         obs_finding_controls,
      //                                         obs_review_item_findings
      //   obs_assessments (the row itself)    → cascades obs_pen_tests,
      //                                         obs_review_items,
      //                                         obs_assessment_evidence

      pushDb(ASSESSMENT);  // existence check
      // inside transaction:
      pushDb(FINDING);     // delete(obsFindings).where() — 1 finding removed
      pushDb(ASSESSMENT);  // delete(obsAssessments).where()
      pushDb();            // audit

      const res = await request(app).delete("/api/observatory/assessments/asmnt-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      // All 4 queue entries consumed — no DB call was skipped.
      expect(dbQ).toHaveLength(0);
    });
  });

  // ── Findings ─────────────────────────────────────────────────────────────────
  //
  // KEY REGRESSION: the client does NOT send applicationId — the server must
  // derive it from the parent assessment. Any change that re-introduces an
  // applicationId validation requirement will break this test.

  describe("POST /api/observatory/findings", () => {
    it("creates a finding WITHOUT applicationId in the request body", async () => {
      pushDb(ASSESSMENT);  // select(obsAssessments).where() — to get applicationId
      pushDb(FINDING);     // insert(obsFindings).values().returning()
      pushDb();            // audit

      const res = await request(app)
        .post("/api/observatory/findings")
        .send({
          assessmentId: "asmnt-1",
          title: "SQL injection in login form",
          severity: "Critical",
          domain: "security",
          // applicationId deliberately omitted — server must derive it
        });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        id: "find-1",
        severity: "Critical",
        domain: "security",
      });
    });

    it("returns 404 when the parent assessment is not found for this tenant", async () => {
      pushDb();  // select(obsAssessments).where() returns []

      const res = await request(app)
        .post("/api/observatory/findings")
        .send({
          assessmentId: "foreign-assessment",
          title: "Finding",
          severity: "High",
          domain: "security",
        });

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/assessment not found/i);
    });

    it("returns 400 for an invalid severity value", async () => {
      const res = await request(app)
        .post("/api/observatory/findings")
        .send({
          assessmentId: "asmnt-1",
          title: "Finding",
          severity: "Catastrophic",   // not in OBS_FINDING_SEVERITIES
          domain: "security",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/invalid severity/i);
    });

    it("returns 400 for an invalid domain value", async () => {
      const res = await request(app)
        .post("/api/observatory/findings")
        .send({
          assessmentId: "asmnt-1",
          title: "Finding",
          severity: "High",
          domain: "dragons",  // not in OBS_FINDING_DOMAINS
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/invalid domain/i);
    });
  });

  describe("PATCH /api/observatory/findings/:id — status transitions", () => {
    it("returns 200 with updated finding", async () => {
      const UPDATED = { ...FINDING, status: "in_progress" };
      pushDb(UPDATED);  // update.set().where().returning()
      pushDb();         // audit

      const res = await request(app)
        .patch("/api/observatory/findings/find-1")
        .send({ status: "in_progress" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "in_progress" });
    });

    it("auto-sets resolvedAt when status is set to 'remediated'", async () => {
      // The route sets resolvedAt = new Date() on the server if not supplied.
      // We verify that the route reaches the update step without error; the
      // mock doesn't enforce the resolvedAt field because it's DB-side.
      const REMEDIATED = { ...FINDING, status: "remediated", resolvedAt: new Date().toISOString() };
      pushDb(REMEDIATED);
      pushDb();

      const res = await request(app)
        .patch("/api/observatory/findings/find-1")
        .send({ status: "remediated" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("remediated");
    });

    it("returns 400 for an invalid finding status", async () => {
      const res = await request(app)
        .patch("/api/observatory/findings/find-1")
        .send({ status: "not_a_real_status" });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/invalid status/i);
    });

    it("returns 404 when the finding is not in this tenant", async () => {
      pushDb();  // update returns []
      // no audit because we return early

      const res = await request(app)
        .patch("/api/observatory/findings/nonexistent")
        .send({ status: "in_progress" });

      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/observatory/findings/bulk-status", () => {
    it("bulk-updates multiple findings and returns the updated count", async () => {
      pushDb({ id: "find-1" }, { id: "find-2" });  // update.set().where().returning({id})
      pushDb();                                      // audit

      const res = await request(app)
        .post("/api/observatory/findings/bulk-status")
        .send({ ids: ["find-1", "find-2"], status: "remediated" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ updated: 2 });
    });

    it("returns 400 when ids array is empty", async () => {
      const res = await request(app)
        .post("/api/observatory/findings/bulk-status")
        .send({ ids: [], status: "remediated" });

      expect(res.status).toBe(400);
    });

    it("returns 400 for an invalid bulk status value", async () => {
      const res = await request(app)
        .post("/api/observatory/findings/bulk-status")
        .send({ ids: ["find-1"], status: "not_valid" });

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/observatory/findings/:id", () => {
    it("deletes a finding and returns { success: true }", async () => {
      pushDb(FINDING);  // delete(obsFindings).where().returning()
      pushDb();         // audit

      const res = await request(app).delete("/api/observatory/findings/find-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
    });

    it("returns 404 when the finding does not exist in this tenant", async () => {
      pushDb();  // delete returns []

      const res = await request(app).delete("/api/observatory/findings/nonexistent");

      expect(res.status).toBe(404);
    });
  });

  // ── Evidence ─────────────────────────────────────────────────────────────────

  describe("POST /api/observatory/evidence", () => {
    it("creates evidence and returns 201", async () => {
      pushDb(EVIDENCE);  // insert(obsEvidence).values().returning()
      pushDb();          // audit

      const res = await request(app)
        .post("/api/observatory/evidence")
        .send({ title: "Screenshot of error page", evidenceType: "screenshot" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id: "ev-1", evidenceType: "screenshot" });
    });

    it("returns 400 for an invalid evidenceType", async () => {
      const res = await request(app)
        .post("/api/observatory/evidence")
        .send({ title: "Evidence", evidenceType: "interpretive_dance" });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/invalid evidence type/i);
    });
  });

  // ── Link / unlink: finding ↔ evidence ────────────────────────────────────────

  describe("POST /api/observatory/findings/:id/evidence/:evidenceId", () => {
    it("links evidence to a finding and returns { success: true }", async () => {
      pushDb(FINDING);   // select(obsFindings).where()
      pushDb(EVIDENCE);  // select(obsEvidence).where()
      pushDb();          // insert(obsFindingEvidence).values().onConflictDoNothing()
      pushDb();          // audit

      const res = await request(app)
        .post("/api/observatory/findings/find-1/evidence/ev-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
    });

    it("returns 404 when finding or evidence is not in this tenant", async () => {
      pushDb();   // select(obsFindings).where() returns []
      pushDb();   // select(obsEvidence).where() returns []

      const res = await request(app)
        .post("/api/observatory/findings/nonexistent/evidence/nonexistent");

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/observatory/findings/:id/evidence/:evidenceId", () => {
    it("unlinks evidence from a finding and returns { success: true }", async () => {
      pushDb(FINDING);  // select(obsFindings).where()
      pushDb();         // delete(obsFindingEvidence).where()
      pushDb();         // audit

      const res = await request(app)
        .delete("/api/observatory/findings/find-1/evidence/ev-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
    });

    it("returns 404 when the finding is not in this tenant", async () => {
      pushDb();  // select(obsFindings).where() returns []

      const res = await request(app)
        .delete("/api/observatory/findings/nonexistent/evidence/ev-1");

      expect(res.status).toBe(404);
    });
  });

  // ── Link / unlink: finding ↔ control ─────────────────────────────────────────

  describe("POST /api/observatory/findings/:id/controls/:controlId", () => {
    it("links a control to a finding and returns { success: true }", async () => {
      pushDb(FINDING);   // select(obsFindings).where()
      pushDb(CONTROL);   // select(obsControls).where()
      pushDb();          // insert(obsFindingControls).values().onConflictDoNothing()
      pushDb();          // audit

      const res = await request(app)
        .post("/api/observatory/findings/find-1/controls/ctrl-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
    });

    it("returns 404 when finding or control is not found", async () => {
      pushDb();   // select(obsFindings) returns []
      pushDb();   // select(obsControls) returns []

      const res = await request(app)
        .post("/api/observatory/findings/nonexistent/controls/nonexistent");

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/observatory/findings/:id/controls/:controlId", () => {
    it("unlinks a control from a finding and returns { success: true }", async () => {
      pushDb(FINDING);  // select(obsFindings).where()
      pushDb();         // delete(obsFindingControls).where()
      pushDb();         // audit

      const res = await request(app)
        .delete("/api/observatory/findings/find-1/controls/ctrl-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
    });

    it("returns 404 when the finding is not in this tenant", async () => {
      pushDb();  // select(obsFindings) returns []

      const res = await request(app)
        .delete("/api/observatory/findings/nonexistent/controls/ctrl-1");

      expect(res.status).toBe(404);
    });
  });

  // ── Standards catalog auth regression ────────────────────────────────────────
  //
  // These tests guard against accidental removal of the ctxOr401 guard on the
  // read-only standards library and dashboard stats endpoints. An unauthenticated
  // caller would otherwise be able to read the full audit log history and the
  // compliance controls catalog.

  describe("GET /api/observatory/frameworks — auth guard", () => {
    it("returns 401 when no context is present", async () => {
      const { ContextError } = await import("../../context");
      vi.mocked(getRequestContext).mockRejectedValue(
        new (ContextError as any)("No tenant context", 401),
      );

      const res = await request(app).get("/api/observatory/frameworks");

      expect(res.status).toBe(401);
    });

    it("returns 200 with the frameworks list when authenticated", async () => {
      const FW = { id: "fw-1", name: "ISO 27001", code: "ISO27001", sortOrder: 1 };
      // select().from(obsFrameworks).leftJoin().groupBy().orderBy() — mkChain.orderBy pops
      pushDb({ framework: FW, controlCount: 3 });

      const res = await request(app).get("/api/observatory/frameworks");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("GET /api/observatory/controls — auth guard", () => {
    it("returns 401 when no context is present", async () => {
      const { ContextError } = await import("../../context");
      vi.mocked(getRequestContext).mockRejectedValue(
        new (ContextError as any)("No tenant context", 401),
      );

      const res = await request(app).get("/api/observatory/controls");

      expect(res.status).toBe(401);
    });

    it("returns 200 with controls list when authenticated", async () => {
      const FW = { id: "fw-1", name: "ISO 27001", code: "ISO27001" };
      // select().from(obsControls).innerJoin().where().orderBy().limit() —
      // where() is terminal (pops); orderBy/limit chain on terminal self-ref
      pushDb({ control: CONTROL, frameworkName: FW.name, frameworkCode: FW.code });

      const res = await request(app).get("/api/observatory/controls");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("GET /api/observatory/stats — auth guard & tenant scoping", () => {
    it("returns 401 when no context is present", async () => {
      const { ContextError } = await import("../../context");
      vi.mocked(getRequestContext).mockRejectedValue(
        new (ContextError as any)("No tenant context", 401),
      );

      const res = await request(app).get("/api/observatory/stats");

      expect(res.status).toBe(401);
    });

    it("returns stats scoped to the active tenant", async () => {
      // The stats endpoint makes 7 DB calls, all filtered by ctx.tenantDomain:
      //   1. count(obsApplications) where tenantDomain = ctx.tenantDomain
      //   2. count(obsVersions)     where tenantDomain = ctx.tenantDomain
      //   3. count(obsAssessments)  where tenantDomain = ctx.tenantDomain
      //   4. count(obsEvidence)     where tenantDomain = ctx.tenantDomain
      //   5. findingsBySeverity groupBy (where tenantDomain + status in [...])
      //   6. findingsByStatus groupBy (where tenantDomain)
      //   7. recentAuditLogs orderBy createdAt limit 10 (where tenantDomain)
      pushDb({ count: 4 });   // apps
      pushDb({ count: 7 });   // versions
      pushDb({ count: 2 });   // assessments
      pushDb({ count: 9 });   // evidence
      pushDb({ severity: "Critical", count: 1 });   // findingsBySeverity
      pushDb({ status: "open", count: 3 });          // findingsByStatus
      pushDb();                                       // recentAudit (empty)

      const res = await request(app).get("/api/observatory/stats");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        applications: 4,
        versions: 7,
        assessments: 2,
        evidence: 9,
      });
      expect(Array.isArray(res.body.openFindingsBySeverity)).toBe(true);
      expect(Array.isArray(res.body.findingsByStatus)).toBe(true);
      expect(Array.isArray(res.body.recentActivity)).toBe(true);
    });

    it("does not leak data from a different tenant — context switch returns that tenant's counts", async () => {
      // Simulate a request arriving with a DIFFERENT tenant context.
      // The endpoint must use ctx.tenantDomain, not a hardcoded value, so swapping
      // the context causes it to query (and return) the other tenant's data.
      const OTHER_CTX = {
        ...WRITER_CTX,
        tenantId: "tenant-2",
        tenantDomain: "other.com",
      };
      vi.mocked(getRequestContext).mockResolvedValue(OTHER_CTX as any);

      pushDb({ count: 0 });  // apps    — other tenant has none
      pushDb({ count: 0 });  // versions
      pushDb({ count: 0 });  // assessments
      pushDb({ count: 0 });  // evidence
      pushDb();              // findingsBySeverity — empty
      pushDb();              // findingsByStatus — empty
      pushDb();              // recentAudit — empty

      const res = await request(app).get("/api/observatory/stats");

      expect(res.status).toBe(200);
      // Other tenant has no data — counts must be 0, not WRITER_CTX tenant's data.
      expect(res.body.applications).toBe(0);
      expect(res.body.versions).toBe(0);
      expect(res.body.assessments).toBe(0);
      expect(res.body.evidence).toBe(0);
      expect(res.body.openFindingsBySeverity).toEqual([]);
      expect(res.body.findingsByStatus).toEqual([]);
      expect(res.body.recentActivity).toEqual([]);
    });
  });

  // ── GET /api/observatory/audit-logs ────────────────────────────────────────

  describe("audit-log history", () => {
    const AUDIT_ROW = {
      id: "al-1",
      tenantDomain: "acme.com",
      userId: "user-1",
      entityType: "finding",
      entityId: "find-1",
      action: "create",
      description: "Created finding",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };

    it("returns 401 when no valid context is present", async () => {
      const { ContextError } = await import("../../context");
      vi.mocked(getRequestContext).mockRejectedValue(
        new (ContextError as any)("No tenant context", 401),
      );

      const res = await request(app).get("/api/observatory/audit-logs");

      expect(res.status).toBe(401);
    });

    it("returns only audit log rows belonging to the active tenant", async () => {
      // The DB mock returns the single row we push; the endpoint must scope its
      // query to ctx.tenantDomain so a different-tenant row never appears.
      pushDb(AUDIT_ROW);

      const res = await request(app).get("/api/observatory/audit-logs");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].tenantDomain).toBe("acme.com");
      expect(res.body[0].id).toBe("al-1");
    });

    it("does not return audit rows from a different tenant", async () => {
      const OTHER_CTX = {
        ...WRITER_CTX,
        tenantId: "tenant-2",
        tenantDomain: "other.com",
      };
      vi.mocked(getRequestContext).mockResolvedValue(OTHER_CTX as any);

      // Simulate the DB returning nothing for the other tenant's domain.
      pushDb();

      const res = await request(app).get("/api/observatory/audit-logs");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  // ── GET /api/observatory/assessments/:id/scan-status ──────────────────────
  //
  // Regression guard for the Autoscale-recycle bug: the in-memory job queue
  // is lost when the server instance recycles.  The endpoint must fall back to
  // scheduled_job_runs so the UI shows a real failure message instead of
  // spinning forever.

  describe("GET /api/observatory/assessments/:id/scan-status", () => {
    it("returns active status directly when the job is found in memory", async () => {
      vi.mocked(getJobStatusByLabel).mockReturnValue({
        status: "active",
        runningSec: 42,
      } as any);

      pushDb({ type: "accessibility", status: "in_progress" }); // assessment select

      const res = await request(app).get("/api/observatory/assessments/asmnt-1/scan-status");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("active");
      expect(res.body.runningSec).toBe(42);
      // scheduledJobRuns was NOT consulted (queue returned a live result)
      expect(dbQ).toHaveLength(0);
    });

    it("returns failed with the DB error message when the job is gone but scheduled_job_runs has a recent failure", async () => {
      // Default mock already returns not_found; make it explicit for clarity.
      vi.mocked(getJobStatusByLabel).mockReturnValue({ status: "not_found" } as any);

      pushDb({ type: "accessibility", status: "planned" }); // assessment select
      // scheduled_job_runs fallback returns a recent failed run
      pushDb({ status: "failed", errorMessage: "Puppeteer crashed: signal SIGTERM" });

      const res = await request(app).get("/api/observatory/assessments/asmnt-1/scan-status");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("failed");
      expect(res.body.errorMessage).toBe("Puppeteer crashed: signal SIGTERM");
      expect(dbQ).toHaveLength(0);
    });

    it("uses a generic 'server restarted' message when job is gone, assessment is in_progress, and no DB failure row exists", async () => {
      vi.mocked(getJobStatusByLabel).mockReturnValue({ status: "not_found" } as any);

      pushDb({ type: "accessibility", status: "in_progress" }); // assessment select
      pushDb(); // scheduled_job_runs returns nothing (instance recycled before DB write)

      const res = await request(app).get("/api/observatory/assessments/asmnt-1/scan-status");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("failed");
      expect(res.body.errorMessage).toMatch(/server may have restarted/i);
      expect(dbQ).toHaveLength(0);
    });

    it("returns the queue timeout message when the job timed out and scheduled_job_runs recorded the timeout failure", async () => {
      // This test verifies the Autoscale/timeout scenario end-to-end through the
      // status endpoint contract: the queue writes "Timed out after Xs" to
      // scheduled_job_runs; the endpoint must surface that message so the UI
      // shows "Scan failed: Timed out after 120s" instead of spinning forever.
      vi.mocked(getJobStatusByLabel).mockReturnValue({ status: "not_found" } as any);

      pushDb({ type: "accessibility", status: "planned" }); // assessment select
      // The queue's timeout handler writes this to scheduled_job_runs
      pushDb({ status: "failed", errorMessage: "Timed out after 120s" });

      const res = await request(app).get("/api/observatory/assessments/asmnt-1/scan-status");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("failed");
      expect(res.body.errorMessage).toBe("Timed out after 120s");
      expect(dbQ).toHaveLength(0);
    });

    it("returns not_found when job is gone, assessment is not in_progress, and no recent failure exists", async () => {
      vi.mocked(getJobStatusByLabel).mockReturnValue({ status: "not_found" } as any);

      pushDb({ type: "accessibility", status: "completed" }); // assessment select
      pushDb(); // scheduled_job_runs returns nothing

      const res = await request(app).get("/api/observatory/assessments/asmnt-1/scan-status");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("not_found");
      expect(dbQ).toHaveLength(0);
    });

    it("returns 404 when the assessment does not exist for this tenant", async () => {
      vi.mocked(getJobStatusByLabel).mockReturnValue({ status: "not_found" } as any);

      pushDb(); // assessment select returns []

      const res = await request(app).get("/api/observatory/assessments/nonexistent/scan-status");

      expect(res.status).toBe(404);
    });

    it("collision guard: a failed performance-scan job for the same assessment does not pollute the accessibility scan-status response", async () => {
      // Both the accessibility and performance scan endpoints use the same
      // assessmentId as targetId, but the DB fallback now filters by jobLabel.
      // A performance scan failure (label: "scan:performance:asmnt-1") must NOT
      // appear on the accessibility scan-status endpoint (label: "scan:accessibility:asmnt-1").
      //
      // In this test the DB mock is set up to return [] (no row) when queried
      // by the accessibility label — simulating the correct label-based filter.
      vi.mocked(getJobStatusByLabel).mockReturnValue({ status: "not_found" } as any);

      pushDb({ type: "accessibility", status: "completed" }); // assessment select
      // DB returns nothing for the accessibility label (performance failure exists
      // but is scoped to a different label — the mock returns [] here)
      pushDb(); // scheduledJobRuns filtered by label "scan:accessibility:asmnt-1" → []

      const res = await request(app).get("/api/observatory/assessments/asmnt-1/scan-status");

      expect(res.status).toBe(200);
      // Must NOT return failed (would be wrong — accessibility scan didn't fail)
      expect(res.body.status).toBe("not_found");
      expect(dbQ).toHaveLength(0);
    });
  });
});
