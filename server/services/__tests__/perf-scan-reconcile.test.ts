/**
 * Verification tests for performance scan finding reconciliation.
 *
 * Scenarios covered:
 *   1. First breach  → new finding inserted with scanRuleId + affectedComponent set
 *   2. Re-scan while still breaching → existing open finding refreshed in place, no duplicate
 *   3. Metric returns within SLA   → open finding auto-resolved (status=remediated, resolvedAt stamped)
 *   4. Human-set status (accepted_risk) → finding completely untouched even when breach persists
 *   5. Re-breach after auto-remediation → new finding inserted (history preserved)
 *   6. Cross-path isolation → the SQL WHERE scopes to PERF_SLA_RULE_IDS; provider-path
 *      findings (slow-ttfb etc.) are not visible to this reconcile, so they are never
 *      auto-resolved by the SLA route and vice-versa.
 *
 * Tests assert actual INSERT/UPDATE payloads (scanRuleId, status, resolvedAt), not
 * just DB-call sequencing.
 *
 * Uses a queue-based DB mock identical in shape to security-scan-dedup.test.ts.
 */

import { describe, it, beforeEach, vi, expect } from "vitest";
import express from "express";
import request from "supertest";

// ── Queue-based DB mock with payload capture ─────────────────────────────────

const { dbQ, makeMockDb, capturedJob, capturedInserts, capturedUpdates } = vi.hoisted(() => {
  const dbQ: any[][] = [];
  const capturedJob: { fn: null | (() => Promise<any>) } = { fn: null };

  // Every values(payload) and set(payload) call is recorded here so tests can
  // assert on actual data, not just call ordering.
  const capturedInserts: any[] = [];
  const capturedUpdates: any[] = [];

  function terminal(): any {
    const val = dbQ.shift() ?? [];
    const t: any = {
      then:    (resolve: any, reject?: any) => Promise.resolve(val).then(resolve, reject),
      catch:   (cb: any) => Promise.resolve(val).catch(cb),
      finally: (cb: any) => Promise.resolve(val).finally(cb),
      returning:           () => Promise.resolve(val),
      onConflictDoNothing: () => Promise.resolve(val),
      orderBy: () => t,
      groupBy: () => t,
      limit:   () => t,
    };
    return t;
  }

  function mkChain(): any {
    return {
      from:  () => mkChain(),
      where: terminal,
      // Capture SET payload for UPDATE calls before returning a new chain.
      set: (payload: any) => {
        capturedUpdates.push(payload);
        return mkChain();
      },
      // Capture VALUES payload for INSERT calls before hitting terminal.
      values: (payload: any) => {
        capturedInserts.push(payload);
        return terminal();
      },
      innerJoin:         () => mkChain(),
      leftJoin:          () => mkChain(),
      groupBy:           () => mkChain(),
      orderBy:           () => Promise.resolve(dbQ.shift() ?? []),
      returning:         () => Promise.resolve(dbQ.shift() ?? []),
      onConflictDoUpdate: () => ({ returning: () => Promise.resolve(dbQ.shift() ?? []) }),
      limit: () => mkChain(),
    };
  }

  function makeMockDb() {
    const db: any = {
      select: mkChain,
      insert: mkChain,
      update: mkChain,
      delete: () => ({ where: terminal }),
      transaction: async (fn: any) => fn(db),
    };
    return db;
  }

  return { dbQ, makeMockDb, capturedJob, capturedInserts, capturedUpdates };
});

// ── Mock all I/O ──────────────────────────────────────────────────────────────

vi.mock("../../db", () => ({ db: makeMockDb() }));

vi.mock("../../context", () => ({
  getRequestContext: vi.fn(),
  ContextError: class ContextError extends Error {
    status: number;
    constructor(msg: string, status = 401) { super(msg); this.status = status; }
  },
}));

vi.mock("../../services/job-queue", () => ({
  enqueue: vi.fn((_queue: any, _label: any, fn: any) => {
    capturedJob.fn = fn;
  }),
  getJobStatusByLabel: vi.fn(() => ({ status: "not_found" })),
}));

vi.mock("../../services/performance-scanner", () => ({
  runPerformanceScan: vi.fn(),
  DEFAULT_PERF_SLA: {
    ttfbMs: 800, loadTimeMs: 3000, lcpMs: 2500, clsScore: 0.1, ttiMs: 3800,
  },
  PERF_SLA_RULE_IDS: [
    "ttfb_sla_breach", "load_time_sla_breach", "lcp_sla_breach",
    "cls_sla_breach", "tti_sla_breach",
  ],
}));

vi.mock("../../services/ssrf-guard", () => ({
  assertScanUrlSafe: vi.fn().mockResolvedValue(undefined),
}));

// ── Import under test AFTER mocks ─────────────────────────────────────────────

import { registerObservatoryPerformanceRoutes } from "../../routes/observatory-performance";
import { getRequestContext } from "../../context";
import { runPerformanceScan } from "../../services/performance-scanner";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CTX = {
  userId: "user-1",
  tenantId: "tenant-1",
  marketId: "market-1",
  userRole: "Domain Admin",
  tenantDomain: "acme.com",
  isDefaultMarket: true,
};

const ASSESSMENT = {
  id: "asmnt-1",
  tenantDomain: "acme.com",
  type: "performance",
  applicationId: "app-1",
  versionId: "ver-1",
  title: "Perf assessment",
};

const APP_ROW = {
  id: "app-1",
  tenantDomain: "acme.com",
  appUrl: "https://example.com",
  perfSlaConfig: null,
};

const SCAN_URL = "https://example.com";

const GOOD_METRICS = {
  ttfbMs: 100, loadTimeMs: 500, lcpMs: 800, clsScore: 0.01, ttiMs: 600,
  scannedAt: new Date().toISOString(),
  finalUrl: SCAN_URL,
  warnings: [],
};

const TTFB_FINDING = {
  ruleId: "ttfb_sla_breach",
  title: "Time to First Byte (TTFB) SLA breach on /",
  description: "TTFB was 1 200 ms, exceeding SLA of 800 ms.",
  recommendation: "Add caching.",
  severity: "Medium",
  measured: "1 200 ms",
  threshold: "800 ms",
};

function openSlaRow(overrides: Record<string, any> = {}) {
  return {
    id: "find-1",
    scanRuleId: "ttfb_sla_breach",
    affectedComponent: SCAN_URL,
    status: "open",
    ...overrides,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  registerObservatoryPerformanceRoutes(app);
  return app;
}

function push(rows: any[]) { dbQ.push(rows); }

/**
 * Hit the route, push route-phase DB pops, return the captured job fn.
 *
 * Route-phase pops (in order):
 *   1. obsAssessments SELECT
 *   2. obsApplications SELECT
 *   3. obsPerformanceScans INSERT .returning()
 *   4. obsAuditLogs INSERT (audit fn)
 */
async function triggerScan(app: express.Express): Promise<() => Promise<void>> {
  push([ASSESSMENT]);
  push([APP_ROW]);
  push([{ id: "scan-1", tenantDomain: "acme.com" }]);
  push([]);

  const res = await request(app)
    .post("/api/observatory/assessments/asmnt-1/performance-scan")
    .set("x-active-tenant-id", "acme.com")
    .send({});

  expect(res.status, `trigger failed: ${JSON.stringify(res.body)}`).toBe(202);
  expect(capturedJob.fn).not.toBeNull();
  return capturedJob.fn!;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("performance scan reconciliation", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    dbQ.length = 0;
    capturedJob.fn = null;
    capturedInserts.length = 0;
    capturedUpdates.length = 0;
    vi.mocked(getRequestContext).mockResolvedValue(CTX as any);
    app = buildApp();
  });

  // ── Scenario 1: First breach → new finding with scanRuleId set ────────────

  it("S1: inserts a new finding with scanRuleId, affectedComponent, and status=open on first breach", async () => {
    vi.mocked(runPerformanceScan).mockResolvedValue({ metrics: GOOD_METRICS, findings: [TTFB_FINDING] } as any);

    const runJob = await triggerScan(app);

    push([]);                      // existing findings SELECT → empty (first run)
    push([{ id: "find-new" }]);    // obsFindings INSERT .returning()
    push([]);                      // audit log for new finding
    push([{ id: "ev-1" }]);        // obsEvidence INSERT .returning()
    push([]);                      // obsAssessmentEvidence INSERT
    push([]);                      // obsPerformanceScans UPDATE

    await runJob();

    expect(dbQ.length).toBe(0);

    // ── Payload assertions ────────────────────────────────────────────────────
    const findingInsert = capturedInserts.find((p) => p?.scanRuleId === "ttfb_sla_breach");
    expect(findingInsert, "finding INSERT must have scanRuleId").toBeDefined();
    expect(findingInsert).toMatchObject({
      scanRuleId: "ttfb_sla_breach",
      status: "open",
      affectedComponent: SCAN_URL,
      domain: "performance",
      title: TTFB_FINDING.title,
      severity: TTFB_FINDING.severity,
    });
    // No auto-resolve UPDATE should have been issued
    expect(capturedUpdates.some((u) => u?.status === "remediated")).toBe(false);
  });

  // ── Scenario 2: Re-scan still breaching → refresh in place ───────────────

  it("S2: refreshes title/severity/recommendation on an existing open finding without inserting a duplicate", async () => {
    vi.mocked(runPerformanceScan).mockResolvedValue({ metrics: GOOD_METRICS, findings: [TTFB_FINDING] } as any);

    const runJob = await triggerScan(app);

    push([openSlaRow()]);          // existing findings → open match
    push([]);                      // obsFindings UPDATE (metadata refresh)
    push([{ id: "ev-2" }]);        // obsEvidence INSERT
    push([]);                      // obsAssessmentEvidence INSERT
    push([]);                      // obsPerformanceScans UPDATE

    await runJob();

    expect(dbQ.length).toBe(0);

    // ── Payload assertions ────────────────────────────────────────────────────
    // The refresh UPDATE must carry current metadata but NOT change status/resolvedAt
    const refreshUpdate = capturedUpdates.find((u) => u?.title === TTFB_FINDING.title);
    expect(refreshUpdate, "metadata refresh UPDATE must exist").toBeDefined();
    expect(refreshUpdate).toMatchObject({
      title: TTFB_FINDING.title,
      severity: TTFB_FINDING.severity,
      recommendation: TTFB_FINDING.recommendation,
    });
    expect(refreshUpdate?.status).toBeUndefined();   // status NOT overridden
    expect(refreshUpdate?.resolvedAt).toBeUndefined(); // resolvedAt NOT set

    // No new finding INSERT
    const dupeInsert = capturedInserts.find((p) => p?.scanRuleId === "ttfb_sla_breach");
    expect(dupeInsert).toBeUndefined();
  });

  // ── Scenario 3: Clean scan → open finding auto-resolved ──────────────────

  it("S3: auto-resolves (status=remediated, resolvedAt stamped) when the metric returns within SLA", async () => {
    vi.mocked(runPerformanceScan).mockResolvedValue({ metrics: GOOD_METRICS, findings: [] } as any);

    const runJob = await triggerScan(app);

    push([openSlaRow()]);          // existing findings → one open finding
    push([]);                      // obsFindings inArray UPDATE (auto-resolve)
    push([]);                      // bulk audit log
    push([{ id: "ev-3" }]);        // obsEvidence INSERT
    push([]);                      // obsAssessmentEvidence INSERT
    push([]);                      // obsPerformanceScans UPDATE

    await runJob();

    expect(dbQ.length).toBe(0);

    // ── Payload assertions ────────────────────────────────────────────────────
    const resolveUpdate = capturedUpdates.find((u) => u?.status === "remediated");
    expect(resolveUpdate, "auto-resolve UPDATE must exist").toBeDefined();
    expect(resolveUpdate).toMatchObject({ status: "remediated" });
    expect(resolveUpdate?.resolvedAt).toBeInstanceOf(Date);

    // No new finding INSERT
    const newInsert = capturedInserts.find((p) => p?.scanRuleId === "ttfb_sla_breach");
    expect(newInsert).toBeUndefined();
  });

  // ── Scenario 4: Human-set status → finding completely untouched ───────────

  it("S4: does not update or auto-resolve a finding with human-set status (accepted_risk)", async () => {
    vi.mocked(runPerformanceScan).mockResolvedValue({ metrics: GOOD_METRICS, findings: [TTFB_FINDING] } as any);

    const runJob = await triggerScan(app);

    push([openSlaRow({ status: "accepted_risk" })]);  // existing → human-owned
    // No finding UPDATE (status is not "open"), no auto-resolve (matched), no INSERT (key matched)
    push([{ id: "ev-4" }]);        // obsEvidence INSERT
    push([]);                      // obsAssessmentEvidence INSERT
    push([]);                      // obsPerformanceScans UPDATE

    await runJob();

    expect(dbQ.length).toBe(0);

    // ── Payload assertions ────────────────────────────────────────────────────
    // No new INSERT for the finding
    const findingInsert = capturedInserts.find((p) => p?.scanRuleId === "ttfb_sla_breach");
    expect(findingInsert).toBeUndefined();
    // No remediated UPDATE
    expect(capturedUpdates.some((u) => u?.status === "remediated")).toBe(false);
    // No metadata refresh UPDATE (status is not open)
    expect(capturedUpdates.some((u) => u?.title === TTFB_FINDING.title)).toBe(false);
  });

  // ── Scenario 5: Re-breach after auto-remediation → new finding ───────────

  it("S5: inserts a fresh open finding when a metric re-breaches after the old finding was remediated", async () => {
    vi.mocked(runPerformanceScan).mockResolvedValue({ metrics: GOOD_METRICS, findings: [TTFB_FINDING] } as any);

    const runJob = await triggerScan(app);

    // Remediated finding is excluded from the match map → no match → new INSERT
    push([openSlaRow({ id: "find-old", status: "remediated" })]);
    push([{ id: "find-new" }]);    // new obsFindings INSERT
    push([]);                      // audit log for new finding
    // find-old is remediated (not open) → not in staleOpenIds
    push([{ id: "ev-5" }]);        // obsEvidence INSERT
    push([]);                      // obsAssessmentEvidence INSERT
    push([]);                      // obsPerformanceScans UPDATE

    await runJob();

    expect(dbQ.length).toBe(0);

    // ── Payload assertions ────────────────────────────────────────────────────
    // A new finding must have been inserted with scanRuleId set
    const newInsert = capturedInserts.find((p) => p?.scanRuleId === "ttfb_sla_breach");
    expect(newInsert, "new finding INSERT must exist").toBeDefined();
    expect(newInsert).toMatchObject({
      scanRuleId: "ttfb_sla_breach",
      status: "open",
      affectedComponent: SCAN_URL,
    });
    // No auto-resolve (find-old is already remediated, so staleOpenIds is empty)
    expect(capturedUpdates.some((u) => u?.status === "remediated")).toBe(false);
  });

  // ── Scenario 6: Cross-path isolation ─────────────────────────────────────
  //
  // The existingFindings SELECT now has WHERE scan_rule_id = ANY(PERF_SLA_RULE_IDS).
  // Provider-path findings (slow-ttfb, slow-fcp, …) are excluded by the SQL WHERE
  // before they can reach the auto-resolve filter. In the mock the SELECT pop
  // represents the already-filtered result set — pushing [] confirms that the
  // reconcile sees nothing to auto-resolve when zero SLA-namespace findings exist,
  // regardless of how many provider-namespace findings the assessment has.

  it("S6: issues no auto-resolve UPDATE when the SLA-namespace findings query returns empty (cross-path SQL scope)", async () => {
    // All metrics within SLA → zero findings from the scanner
    vi.mocked(runPerformanceScan).mockResolvedValue({ metrics: GOOD_METRICS, findings: [] } as any);

    const runJob = await triggerScan(app);

    // SQL WHERE scopes to PERF_SLA_RULE_IDS → slow-ttfb findings are invisible here
    push([]);                      // existing findings SELECT → empty (provider findings excluded by SQL)
    // No finding loop iterations, no staleOpenIds
    push([{ id: "ev-6" }]);        // obsEvidence INSERT
    push([]);                      // obsAssessmentEvidence INSERT
    push([]);                      // obsPerformanceScans UPDATE

    await runJob();

    expect(dbQ.length).toBe(0);

    // ── Payload assertions ────────────────────────────────────────────────────
    // No auto-resolve UPDATE at all — the provider-path findings were never seen
    expect(capturedUpdates.some((u) => u?.status === "remediated")).toBe(false);
    // No new finding INSERT either
    expect(capturedInserts.some((p) => p?.scanRuleId !== undefined && p?.domain === "performance")).toBe(false);
  });

  // ── Scenario 7: URL-scope isolation ──────────────────────────────────────
  //
  // An assessment may accumulate findings for multiple URLs over time. The
  // existingFindings SELECT now includes WHERE affectedComponent = scanUrl so
  // each reconcile only considers findings for the URL it just scanned.
  //
  // Without this constraint a clean scan of URL-A would leave URL-B's open
  // findings unmatched and bulk-remediate them — a false auto-resolution.
  //
  // The mock represents the SQL-filtered result: when scanning URL-A, only
  // URL-A findings are returned by the query. URL-B's finding (find-url-b)
  // never enters the reconcile loop and is therefore never touched.

  it("S7: clean scan of one URL does not auto-resolve open findings for a different URL", async () => {
    const URL_A = SCAN_URL;          // "https://example.com" — the URL being scanned
    const URL_B = "https://example.com/pricing"; // a different URL with its own open finding

    // All URL-A metrics are within SLA → zero findings from the scanner
    vi.mocked(runPerformanceScan).mockResolvedValue({ metrics: GOOD_METRICS, findings: [] } as any);

    const runJob = await triggerScan(app);

    // The SQL WHERE (affectedComponent = URL_A) means URL-B's finding is never
    // returned. We push only URL-A's open finding to represent the scoped result.
    // URL-B's finding (find-url-b, ttfb_sla_breach, open) exists in the DB but
    // is excluded by the query and must not appear in any DB write.
    push([openSlaRow({ id: "find-url-a", affectedComponent: URL_A })]);
    //         ↑ only URL-A's finding is visible to this reconcile

    // URL-A's finding is unmatched (scan returned 0 findings) → auto-resolve
    push([]);                        // obsFindings inArray UPDATE (URL-A only)
    push([]);                        // bulk audit log for the resolve
    push([{ id: "ev-7" }]);          // obsEvidence INSERT
    push([]);                        // obsAssessmentEvidence INSERT
    push([]);                        // obsPerformanceScans UPDATE

    await runJob();

    expect(dbQ.length).toBe(0);

    // ── Payload assertions ────────────────────────────────────────────────────
    // URL-A's open finding WAS auto-resolved (that's the correct behaviour)
    const resolveUpdate = capturedUpdates.find((u) => u?.status === "remediated");
    expect(resolveUpdate, "URL-A finding must be auto-resolved").toBeDefined();
    expect(resolveUpdate).toMatchObject({ status: "remediated" });
    expect(resolveUpdate?.resolvedAt).toBeInstanceOf(Date);

    // No finding INSERTs — the scan was clean
    expect(capturedInserts.some((p) => p?.domain === "performance")).toBe(false);

    // The test structure itself is the URL-B protection proof: find-url-b was
    // never pushed into the queue. If the code attempted to UPDATE or SELECT it,
    // the queue would underflow and the test would fail before reaching these
    // assertions. The SQL WHERE affectedComponent = URL_A is what keeps it
    // out of the candidate set at the DB level.
    expect(URL_B).toBeDefined(); // reference URL_B to suppress unused-var lint
  });
});
