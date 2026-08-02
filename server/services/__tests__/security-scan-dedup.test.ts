/**
 * Unit tests for security scan deduplication logic in the Observatory
 * pen-test workbench.
 *
 * Verifies that repeated scans upsert by scanRuleId rather than inserting
 * duplicates, legacy (pre-migration) findings are matched by title, stale
 * findings are auto-remediated only on a successful scan, and that a
 * target-unreachable result never clears the existing findings register.
 */

import { describe, it, beforeEach, vi, expect } from "vitest";
import express from "express";
import request from "supertest";

// ── Queue-based DB mock ───────────────────────────────────────────────────────
//
// vi.hoisted() executes before vi.mock() so the queue and factory can be
// referenced inside mock factories (which are also hoisted).

const { dbQ, makeMockDb, capturedJob } = vi.hoisted(() => {
  /** Each entry is the result the next terminal DB call will resolve with. */
  const dbQ: any[][] = [];

  /** Holder for the async job fn captured by the enqueue mock. */
  const capturedJob: { fn: null | (() => Promise<any>) } = { fn: null };

  function terminal(): any {
    const val = dbQ.shift() ?? [];
    // Self-referential so chaining (.returning(), .orderBy(), etc.) stays thenable.
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
    return { where: terminal };
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

  return { dbQ, makeMockDb, capturedJob };
});

// ── Mock all I/O ──────────────────────────────────────────────────────────────

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

// Capture the async job fn so tests can run it explicitly and verify DB effects.
vi.mock("../../services/job-queue", () => ({
  enqueueScan: vi.fn((_label: any, fn: any) => {
    capturedJob.fn = fn;
  }),
  getJobStatusByLabel: vi.fn(() => ({ status: "not_found" })),
}));

vi.mock("../../services/security-scanner", () => ({
  securityScanner: {
    runScan: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
  },
}));

// Not used in the scan path but imported by the route file
vi.mock("../../services/ai-provider", () => ({ completeForFeature: vi.fn() }));

// ── Import under test AFTER mocks ─────────────────────────────────────────────

import { registerObservatoryModuleRoutes } from "../../routes/observatory-modules";
import { getRequestContext } from "../../context";
import { securityScanner } from "../../services/security-scanner";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const WRITER_CTX = {
  userId: "user-1",
  tenantId: "tenant-1",
  marketId: "market-1",
  userRole: "Domain Admin",
  tenantDomain: "acme.com",
  isDefaultMarket: true,
};

const PEN_TEST_ROW = {
  id: "pt-1",
  tenantDomain: "acme.com",
  assessmentId: "asmnt-1",
  assessment: { id: "asmnt-1", applicationId: "app-1", versionId: "ver-1" },
  appUrl: "https://example.com",
  applicationId: "app-1",
  applicationName: "Example App",
};

/** A scanner finding that the built-in security scanner could return. */
const HSTS_FINDING = {
  ruleId: "missing-hsts",
  title: "Missing HTTP Strict Transport Security (HSTS)",
  description: "HSTS header absent.",
  severity: "High",
  cweId: "CWE-319",
  location: { url: "https://example.com" },
};

/** Minimal row shape returned by the existing-automated-findings query. */
function existingDbRow(overrides: Record<string, any> = {}) {
  return {
    penTestFindingId: "ptf-1",
    findingId: "find-1",
    scanRuleId: "missing-hsts",
    title: "Missing HTTP Strict Transport Security (HSTS)",
    status: "open",
    ...overrides,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  registerObservatoryModuleRoutes(app);
  return app;
}

/** Push one result into the DB queue (consumed by the next terminal() call). */
function push(rows: any[]) {
  dbQ.push(rows);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("security scan deduplication", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    dbQ.length = 0;
    capturedJob.fn = null;
    vi.mocked(getRequestContext).mockResolvedValue(WRITER_CTX as any);
    app = buildApp();
  });

  /**
   * Hit the POST /security-scan route to enqueue the scan job, then return
   * the captured async job function ready for explicit execution.
   *
   * Phase-1 DB pops (route handler):
   *   1. select pen test row
   *   2. insert route-level audit log
   */
  async function triggerScan(): Promise<() => Promise<any>> {
    push([PEN_TEST_ROW]); // pen test + assessment + application JOIN result
    push([]);             // route-level audit insert

    const res = await request(app)
      .post("/api/observatory/pen-tests/pt-1/security-scan")
      .set("x-active-tenant-id", "acme.com");

    expect(res.status).toBe(202);
    expect(capturedJob.fn).not.toBeNull();
    return capturedJob.fn!;
  }

  // ── 1. No duplicate on re-scan ─────────────────────────────────────────────

  it("updates an existing finding instead of inserting a duplicate when the same rule is found again", async () => {
    vi.mocked(securityScanner.runScan).mockResolvedValue({
      findings: [HSTS_FINDING],
      tool: "builtin_security@1.0",
      startedAt: new Date(),
      finishedAt: new Date(),
    } as any);

    const runJob = await triggerScan();

    // Phase-2 DB pops (job fn):
    push([existingDbRow()]);  // existing automated findings query → match by ruleId
    push([]);                  // db.update existing finding
    push([]);                  // db.insert job-level audit log

    const result = await runJob();

    expect(result).toEqual({ inserted: 0, updated: 1, resolved: 0 });
  });

  // ── 2. Legacy title backfill ───────────────────────────────────────────────

  it("matches a pre-migration finding by title and backfills its scanRuleId rather than inserting a duplicate", async () => {
    vi.mocked(securityScanner.runScan).mockResolvedValue({
      findings: [HSTS_FINDING],
      tool: "builtin_security@1.0",
      startedAt: new Date(),
      finishedAt: new Date(),
    } as any);

    const runJob = await triggerScan();

    // Legacy row: scan_rule_id was NULL before the migration, title matches
    push([existingDbRow({ scanRuleId: null })]);
    push([]);  // db.update (backfills scanRuleId, no insert)
    push([]);  // job audit

    const result = await runJob();

    expect(result).toEqual({ inserted: 0, updated: 1, resolved: 0 });
  });

  // ── 3. Stale rule auto-remediated on successful scan ──────────────────────

  it("marks a previously open finding as remediated when its rule is no longer returned by a successful scan", async () => {
    const CSP_FINDING = {
      ruleId: "missing-csp",
      title: "No Content Security Policy (CSP)",
      severity: "Medium",
      description: "CSP header absent.",
    };

    vi.mocked(securityScanner.runScan).mockResolvedValue({
      findings: [CSP_FINDING],   // only CSP this time — HSTS is gone
      tool: "builtin_security@1.0",
      startedAt: new Date(),
      finishedAt: new Date(),
    } as any);

    const runJob = await triggerScan();

    // Existing: HSTS was found in a previous scan
    push([existingDbRow({ scanRuleId: "missing-hsts", status: "open", findingId: "find-hsts" })]);
    // CSP is new → insert finding + link
    push([{ id: "find-csp" }]);  // obsFindings insert (.values().returning())
    push([]);                     // obsPenTestFindings insert
    // Stale HSTS → auto-remediate
    push([]);                     // db.update(inArray) for stale findings
    push([]);                     // job audit

    const result = await runJob();

    expect(result).toEqual({ inserted: 1, updated: 0, resolved: 1 });
  });

  // ── 4. Target-unreachable must not clear the register ─────────────────────

  it("does not auto-remediate existing findings when the target URL is unreachable", async () => {
    const UNREACHABLE = {
      ruleId: "target-unreachable",
      title: "Target URL Unreachable",
      severity: "Informational",
      description: "Could not connect.",
    };

    vi.mocked(securityScanner.runScan).mockResolvedValue({
      findings: [UNREACHABLE],
      tool: "builtin_security@1.0",
      startedAt: new Date(),
      finishedAt: new Date(),
    } as any);

    const runJob = await triggerScan();

    // Pre-existing HSTS finding that must be preserved
    push([existingDbRow({ scanRuleId: "missing-hsts", status: "open" })]);
    // target-unreachable is a new rule → insert + link
    push([{ id: "find-unreachable" }]);
    push([]);                            // obsPenTestFindings insert
    // NO stale-resolution update (scanFailed = true)
    push([]);                            // job audit

    const result = await runJob();

    // resolved must be 0 — transient failure must not clear existing findings
    expect(result).toEqual({ inserted: 1, updated: 0, resolved: 0 });
  });

  // ── 5. Re-open auto-remediated finding when rule reappears ────────────────

  it("re-opens a previously auto-remediated finding when the same rule is found again", async () => {
    vi.mocked(securityScanner.runScan).mockResolvedValue({
      findings: [HSTS_FINDING],
      tool: "builtin_security@1.0",
      startedAt: new Date(),
      finishedAt: new Date(),
    } as any);

    const runJob = await triggerScan();

    // Finding was previously auto-remediated by the scanner
    push([existingDbRow({ status: "remediated" })]);
    push([]);   // db.update (reopens to "open", clears resolvedAt)
    push([]);   // job audit

    const result = await runJob();

    // Reopened, not inserted as a duplicate
    expect(result).toEqual({ inserted: 0, updated: 1, resolved: 0 });
  });
});
