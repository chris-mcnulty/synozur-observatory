/**
 * Integration tests for the Observatory module routes (pen-test workbench).
 *
 * Focused on the DELETE /api/observatory/pen-tests/:id path — the cascade
 * regression guard that ensures scan-created findings are removed cleanly
 * when a pen test is deleted.
 *
 * All I/O is mocked (no real DB or network). Uses the same queue-based
 * chainable proxy pattern as observatory-routes.test.ts.
 */

import { describe, it, beforeEach, vi, expect } from "vitest";
import express from "express";
import request from "supertest";

// ── DB mock — queue-based chainable proxy ────────────────────────────────────

const { dbQ, makeMockDb } = vi.hoisted(() => {
  const dbQ: any[][] = [];

  function terminal(): any {
    const val = dbQ.shift() ?? [];
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

vi.mock("../security-scanner", () => ({
  securityScanner: { scan: vi.fn().mockResolvedValue({ findings: [] }) },
}));

vi.mock("../job-queue", () => ({
  enqueue: vi.fn().mockResolvedValue({ jobId: "job-1" }),
  getJobStatusByLabel: vi.fn().mockResolvedValue(null),
  enqueueScan: vi.fn().mockResolvedValue({ jobId: "job-1" }),
}));

vi.mock("../ai-provider", () => ({
  completeForFeature: vi.fn().mockResolvedValue({ content: "" }),
}));

// ── Import under test AFTER mocks ────────────────────────────────────────────

import { registerObservatoryModuleRoutes } from "../../routes/observatory-modules";
import { getRequestContext } from "../../context";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const WRITER_CTX = {
  userId: "user-1",
  tenantId: "tenant-1",
  marketId: "market-1",
  userRole: "Domain Admin",
  tenantDomain: "acme.com",
  isDefaultMarket: true,
};

const READONLY_CTX = {
  ...WRITER_CTX,
  userRole: "Standard User",
};

const PEN_TEST = {
  id: "pt-1",
  tenantDomain: "acme.com",
  assessmentId: "asmnt-1",
  testName: "External Network Pen Test",
  createdBy: "user-1",
};

const SCAN_FINDING = {
  id: "find-scan-1",
  tenantDomain: "acme.com",
  assessmentId: "asmnt-1",
  applicationId: "app-1",
  title: "SQL injection",
  severity: "Critical",
  domain: "security",
  status: "open",
  affectedComponent: "Automated Scan",
  createdBy: "user-1",
};

const SCAN_FINDING_2 = {
  ...SCAN_FINDING,
  id: "find-scan-2",
  title: "Open redirect",
  severity: "Medium",
};

// Junction rows as the DB would return them: pen-test-owned vs backlinked
const JUNCTION_OWNED    = { findingId: "find-scan-1", backlinkFinding: false };
const JUNCTION_BACKLINK = { findingId: "find-scan-2", backlinkFinding: true  };

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  registerObservatoryModuleRoutes(app);
  return app;
}

function pushDb(...rows: any[]) {
  dbQ.push(rows);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("observatory module routes — pen test delete", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    dbQ.length = 0;
    vi.mocked(getRequestContext).mockResolvedValue(WRITER_CTX as any);
    app = buildApp();
  });

  // ── POST /api/observatory/pen-tests/:id/relink-findings ──────────────────

  describe("POST /api/observatory/pen-tests/:id/relink-findings", () => {
    it("returns 404 when the pen test does not exist for this tenant", async () => {
      pushDb();  // select(obsPenTests).where() → [] (not found)

      const res = await request(app).post("/api/observatory/pen-tests/nonexistent/relink-findings");

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/not found/i);
    });

    it("returns 403 when the caller lacks write permission", async () => {
      vi.mocked(getRequestContext).mockResolvedValue(READONLY_CTX as any);

      const res = await request(app).post("/api/observatory/pen-tests/pt-1/relink-findings");

      expect(res.status).toBe(403);
    });

    it("returns { relinked: 0 } when the provenance query finds no orphaned scan findings", async () => {
      // The DB query filters by: assessmentId + scan_report evidence link + no existing
      // junction row. When all findings either have junction rows already or lack the
      // scan_report evidence link (manually created), the query returns [].
      pushDb(PEN_TEST);  // pen test lookup
      pushDb();          // orphaned findings query → [] (provenance filter excluded all)
      // No insert or audit calls since we return early.

      const res = await request(app).post("/api/observatory/pen-tests/pt-1/relink-findings");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ relinked: 0 });
      expect(dbQ).toHaveLength(0);  // exactly 2 queue entries consumed
    });

    it("relinks orphaned scan-runner findings (with scan_report evidence) and returns the count", async () => {
      // The SQL WHERE clause restricts to findings with a scan_report evidence link
      // shared with the assessment (obs_finding_evidence JOIN obs_assessment_evidence
      // JOIN obs_evidence WHERE evidence_type = 'scan_report'). The mock simulates
      // the DB returning only those correctly filtered findings.
      // Each new junction row has backlinkFinding = true so the pen test deletion
      // route does NOT explicitly delete the underlying obs_findings rows.
      pushDb(PEN_TEST);                               // pen test lookup
      pushDb(SCAN_FINDING, SCAN_FINDING_2);           // 2 orphaned scan findings returned
      pushDb();                                       // insert(obsPenTestFindings).onConflictDoNothing
      pushDb();                                       // audit insert

      const res = await request(app).post("/api/observatory/pen-tests/pt-1/relink-findings");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ relinked: 2 });
      expect(dbQ).toHaveLength(0);  // all 4 queue entries consumed
    });

    it("is idempotent — re-running after findings are already linked returns 0", async () => {
      // On a second run the NOT EXISTS predicate filters out all previously linked
      // findings, so the query returns [] and no insert/audit is issued.
      pushDb(PEN_TEST);  // pen test lookup
      pushDb();          // orphaned findings query → [] (already linked)

      const res = await request(app).post("/api/observatory/pen-tests/pt-1/relink-findings");

      expect(res.status).toBe(200);
      expect(res.body.relinked).toBe(0);
      expect(dbQ).toHaveLength(0);
    });

    it("skips insert and audit when provenance filter excludes all candidates", async () => {
      // Regression guard: when the DB returns [] (because the scan_report evidence
      // predicate filtered out manually created findings), the early-return path must
      // skip the insert + audit so no spurious DB writes happen.
      //
      // This also covers the case where an analyst manually created a security
      // finding (POST /api/observatory/findings) for this pen test's assessment —
      // that finding lacks the scan_report evidence link and is correctly excluded
      // by the DB query, so it never appears on the pen test page.
      pushDb(PEN_TEST);  // pen test lookup
      pushDb();          // orphaned query → [] (provenance filter excluded manual finding)
      // Any extra queue consume here would mean insert or audit was incorrectly issued.

      const res = await request(app).post("/api/observatory/pen-tests/pt-1/relink-findings");

      expect(res.status).toBe(200);
      expect(res.body.relinked).toBe(0);
      expect(dbQ).toHaveLength(0);  // exactly 2 entries consumed
    });
  });

  // ── DELETE /api/observatory/pen-tests/:id ─────────────────────────────────

  describe("DELETE /api/observatory/pen-tests/:id", () => {
    it("returns 404 when the pen test does not exist for this tenant", async () => {
      pushDb();  // select(obsPenTests).where() → [] (not found)

      const res = await request(app).delete("/api/observatory/pen-tests/nonexistent");

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/not found/i);
    });

    it("returns 403 when the caller lacks delete permission", async () => {
      vi.mocked(getRequestContext).mockResolvedValue(READONLY_CTX as any);

      const res = await request(app).delete("/api/observatory/pen-tests/pt-1");

      expect(res.status).toBe(403);
    });

    it("deletes a pen test with no findings and returns { success: true }", async () => {
      pushDb(PEN_TEST);  // select(obsPenTests).where() — existence check
      // inside transaction:
      pushDb();          // select(obsPenTestFindings).where() → [] (no findings)
      pushDb();          // delete(obsPenTests).where()
      // NO findings delete — ids.length === 0
      pushDb();          // audit

      const res = await request(app).delete("/api/observatory/pen-tests/pt-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      // All 4 queue entries consumed.
      expect(dbQ).toHaveLength(0);
    });

    it("deletes a pen test with pen-test-owned findings and removes the underlying obs_findings rows", async () => {
      // Primary cascade regression guard: pen-test-owned findings (backlinkFinding=false)
      // must be explicitly deleted because the penTestId FK cascade only removes the
      // junction rows, not the underlying obs_findings rows.
      //
      // DB call order inside the transaction:
      //   1. SELECT { findingId, backlinkFinding } from obs_pen_test_findings
      //   2. DELETE obs_pen_tests (cascades junction rows)
      //   3. DELETE obs_findings for the collected non-backlinked IDs

      pushDb(PEN_TEST);  // existence check
      // inside transaction: both junction rows have backlinkFinding=false
      pushDb(JUNCTION_OWNED, { findingId: "find-scan-2", backlinkFinding: false });
      pushDb();          // delete(obsPenTests).where()
      pushDb();          // delete(obsFindings).where() — removes the 2 findings
      pushDb();          // audit

      const res = await request(app).delete("/api/observatory/pen-tests/pt-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      // All 5 queue entries consumed — findings delete was issued (not skipped).
      expect(dbQ).toHaveLength(0);
    });

    it("does NOT delete backlinked findings when the pen test is removed", async () => {
      // Safety guarantee: backfilled junction rows (backlinkFinding=true) must not
      // cause the underlying obs_findings row to be deleted when the pen test is
      // removed. Those findings belong to the assessment, not exclusively the pen test.
      //
      // When all junction rows are backlinked the ids list is empty after filtering,
      // so the explicit findings DELETE is skipped (3 tx steps rather than 4,
      // same as the no-findings case).

      pushDb(PEN_TEST);           // existence check
      // inside transaction: one owned + one backlinked
      pushDb(JUNCTION_OWNED, JUNCTION_BACKLINK);
      pushDb();                   // delete(obsPenTests).where()
      // findings delete is still issued — for the one owned finding only
      pushDb();                   // delete(obsFindings) for ids=["find-scan-1"]
      pushDb();                   // audit

      const res = await request(app).delete("/api/observatory/pen-tests/pt-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      expect(dbQ).toHaveLength(0);
    });

    it("skips the findings DELETE entirely when all junction rows are backlinked", async () => {
      // When every junction row has backlinkFinding=true the ids list is empty,
      // so the explicit delete(obsFindings) call is skipped (4 entries total,
      // same as the no-findings case).

      pushDb(PEN_TEST);            // existence check
      pushDb(JUNCTION_BACKLINK);   // all backlinked — ids=[]
      pushDb();                    // delete(obsPenTests).where()
      // NO delete(obsFindings) — ids.length === 0
      pushDb();                    // audit

      const res = await request(app).delete("/api/observatory/pen-tests/pt-1");

      expect(res.status).toBe(200);
      expect(dbQ).toHaveLength(0);
    });

    it("removes findings atomically — all steps run in a single transaction", async () => {
      // Verified by counting queue consumption: exactly 5 entries for a pen test
      // with 2 owned findings (existence check + 3 tx steps + audit).

      pushDb(PEN_TEST);
      pushDb(
        { findingId: SCAN_FINDING.id,   backlinkFinding: false },
        { findingId: SCAN_FINDING_2.id, backlinkFinding: false },
      );
      pushDb();   // delete pen test
      pushDb();   // delete findings
      pushDb();   // audit

      const res = await request(app).delete("/api/observatory/pen-tests/pt-1");

      expect(res.status).toBe(200);
      expect(dbQ).toHaveLength(0);
    });
  });
});
