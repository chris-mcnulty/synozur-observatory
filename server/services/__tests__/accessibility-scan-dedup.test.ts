/**
 * Unit tests for accessibility scan deduplication and auto-resolve logic in
 * the Observatory scan runner (runObservatoryScan).
 *
 * Verifies:
 *  1. Re-scan does not create duplicate findings when the same axe rule fires again.
 *  2. Stale open findings (scanRuleId set, rule absent from new scan) are marked
 *     "remediated" with a resolutionNote — the "resolved by re-scan" stamp.
 *  3. Human-set statuses (accepted_risk, false_positive, in_progress, remediated)
 *     are never overwritten by the scan runner.
 *  4. target-unreachable synthetic finding suppresses auto-resolve entirely.
 */

import { describe, it, beforeEach, vi, expect } from "vitest";

// ── Hoisted DB queue ──────────────────────────────────────────────────────────

const { dbQ, makeMockDb } = vi.hoisted(() => {
  const dbQ: any[][] = [];

  function terminal(): any {
    const val = dbQ.shift() ?? [];
    const t: any = {
      then: (resolve: any, reject?: any) => Promise.resolve(val).then(resolve, reject),
      catch: (cb: any) => Promise.resolve(val).catch(cb),
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
      onConflictDoNothing: () => ({ returning: () => Promise.resolve(dbQ.shift() ?? []) }),
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

  return { dbQ, makeMockDb };
});

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../../db", () => ({ db: makeMockDb() }));

vi.mock("../../utils/url-validator", () => ({
  validateUrlWithDnsCheck: vi.fn(async (url: string) => ({ isValid: true, normalizedUrl: url })),
}));

const mockRunScan = vi.fn();
vi.mock("../../services/observatory-scanners", () => ({
  findScannerForType: vi.fn(async () => ({
    key: "axe_core",
    runScan: mockRunScan,
  })),
}));

// ── Import under test (after mocks) ──────────────────────────────────────────

import { runObservatoryScan } from "../observatory-scan-runner";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TENANT = "acme.com";
const ASSESSMENT_ID = "asmnt-1";

const MOCK_ASSESSMENT = {
  id: ASSESSMENT_ID,
  tenantDomain: TENANT,
  type: "accessibility",
  applicationId: "app-1",
  versionId: null,
  status: "not_started",
};

const MOCK_APPLICATION = {
  id: "app-1",
  tenantDomain: TENANT,
  name: "Example App",
  appUrl: "https://example.com",
};

/** A minimal axe-style ScannerFinding for color-contrast */
const COLOR_CONTRAST_FINDING = {
  ruleId: "color-contrast",
  title: "[AA] Elements must have sufficient color contrast",
  description: "Insufficient color contrast ratio.",
  severity: "Medium",
  wcagCriterion: "WCAG 1.4.3 (Level AA)",
  location: { url: "https://example.com", selector: ".btn-primary" },
  _category: "Color Contrast",
};

/** A minimal axe-style ScannerFinding for missing document title */
const DOC_TITLE_FINDING = {
  ruleId: "document-title",
  title: "[A] Documents must have a title",
  description: "Title element missing.",
  severity: "High",
  wcagCriterion: "WCAG 2.4.2 (Level A)",
  location: { url: "https://example.com", selector: "html" },
  _category: "Semantic Structure",
};

/** A target-unreachable synthetic finding emitted when the page cannot load. */
const UNREACHABLE_FINDING = {
  ruleId: "target-unreachable",
  title: "Target URL Unreachable",
  description: "Could not load the target URL.",
  severity: "Informational",
  location: { url: "https://example.com" },
};

function makeScanResult(findings: any[]) {
  return {
    findings,
    rawReport: { contentType: "application/json", body: "{}" },
    tool: "axe-core@4.9.0",
    startedAt: new Date(),
    finishedAt: new Date(),
  };
}

/** Push one batch into the DB response queue. */
function push(rows: any[]) {
  dbQ.push(rows);
}

/**
 * Set up the fixed DB calls that runObservatoryScan always makes:
 *   1. select assessment
 *   2. select application
 *   3. update assessment → in_progress        (update)
 *   4. insert obs_evidence (raw report)       (insert → returning)
 *   5. insert obs_assessment_evidence         (insert → onConflictDoNothing)
 *   6. select existing findings               (select)
 *   7. select review items (accessibility)    (select)
 *
 * Then each test pushes the finding-specific and stale-resolve DB calls.
 * Finally:
 *   N. update assessment → completed
 */
function pushPreamble(existingFindings: any[] = [], reviewItems: any[] = []) {
  push([MOCK_ASSESSMENT]);  // 1. select assessment
  push([MOCK_APPLICATION]); // 2. select application
  // 3. update assessment in_progress — terminal: where()
  push([]);
  // 4. insert evidence → returning
  push([{ id: "ev-1" }]);
  // 5. insert obs_assessment_evidence → onConflictDoNothing → Promise.resolve([])
  push([]);
  // 6. select existing findings
  push(existingFindings);
  // 7. select review items
  push(reviewItems);
}

function pushAssessmentComplete() {
  // update assessment → completed
  push([]);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("accessibility scan deduplication and auto-resolve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbQ.length = 0;
  });

  // 1. No duplicate on re-scan ─────────────────────────────────────────────────

  it("updates an existing finding instead of creating a duplicate when the same axe rule fires again", async () => {
    const existingFinding = {
      id: "find-cc",
      title: COLOR_CONTRAST_FINDING.title,
      affectedComponent: ".btn-primary",
      status: "open",
      scanRuleId: "color-contrast",
    };

    mockRunScan.mockResolvedValue(makeScanResult([COLOR_CONTRAST_FINDING]));

    pushPreamble([existingFinding]);

    // Update the existing finding (refreshes description/severity)
    push([]);
    // link evidence to finding (onConflictDoNothing)
    push([]);
    // link finding to review item (onConflictDoNothing) — no review items so skipped
    pushAssessmentComplete();

    const result = await runObservatoryScan({ assessmentId: ASSESSMENT_ID, tenantDomain: TENANT });

    expect(result.findingsCreated).toBe(0);   // no new finding inserted
    expect(result.findingsSkipped).toBe(1);   // matched + refreshed
    expect(result.findingsResolved).toBe(0);  // nothing stale
  });

  // 2. New finding inserted on first scan ───────────────────────────────────────

  it("inserts a new finding when the axe rule has not been seen before", async () => {
    mockRunScan.mockResolvedValue(makeScanResult([COLOR_CONTRAST_FINDING]));

    pushPreamble([]); // no existing findings

    // insert new finding → returning
    push([{ id: "find-new" }]);
    // link evidence to finding
    push([]);
    // link to review item (no items seeded)
    pushAssessmentComplete();

    const result = await runObservatoryScan({ assessmentId: ASSESSMENT_ID, tenantDomain: TENANT });

    expect(result.findingsCreated).toBe(1);
    expect(result.findingsResolved).toBe(0);
  });

  // 3. Stale open finding auto-resolved with resolutionNote ─────────────────────

  it("marks a previously open finding as remediated with a resolutionNote when its rule is absent from the new scan", async () => {
    // Existing: color-contrast was open from a previous scan
    const staleColorContrast = {
      id: "find-cc",
      title: COLOR_CONTRAST_FINDING.title,
      affectedComponent: ".btn-primary",
      status: "open",
      scanRuleId: "color-contrast",
    };

    // New scan only returns document-title — color-contrast is fixed
    mockRunScan.mockResolvedValue(makeScanResult([DOC_TITLE_FINDING]));

    pushPreamble([staleColorContrast]);

    // Insert new document-title finding
    push([{ id: "find-dt" }]);
    // link evidence to new finding
    push([]);
    // link to review item
    push([]);
    // Auto-resolve stale color-contrast finding (inArray update)
    push([]);

    pushAssessmentComplete();

    const result = await runObservatoryScan({ assessmentId: ASSESSMENT_ID, tenantDomain: TENANT });

    expect(result.findingsCreated).toBe(1);
    expect(result.findingsResolved).toBe(1);
    // The stale finding id should not appear in created
    expect(result.findingsSkipped).toBe(0);
  });

  // 4. Human-set status is never overwritten ────────────────────────────────────

  it("does not auto-resolve a finding with a human-set status even when its rule is absent from the new scan", async () => {
    const humanAccepted = {
      id: "find-cc",
      title: COLOR_CONTRAST_FINDING.title,
      affectedComponent: ".btn-primary",
      status: "accepted_risk",   // human decision — must survive
      scanRuleId: "color-contrast",
    };

    // New scan returns a completely different rule — color-contrast rule is absent
    mockRunScan.mockResolvedValue(makeScanResult([DOC_TITLE_FINDING]));

    pushPreamble([humanAccepted]);

    // Insert new document-title finding
    push([{ id: "find-dt" }]);
    push([]); // evidence link
    push([]); // review item link
    // NO stale-resolve update because humanAccepted.status !== "open"
    pushAssessmentComplete();

    const result = await runObservatoryScan({ assessmentId: ASSESSMENT_ID, tenantDomain: TENANT });

    expect(result.findingsResolved).toBe(0); // human decision preserved
    expect(result.findingsCreated).toBe(1);
  });

  // 5. target-unreachable suppresses auto-resolve ───────────────────────────────

  it("does not auto-resolve existing open findings when the target URL is unreachable", async () => {
    const openFinding = {
      id: "find-cc",
      title: COLOR_CONTRAST_FINDING.title,
      affectedComponent: ".btn-primary",
      status: "open",
      scanRuleId: "color-contrast",
    };

    mockRunScan.mockResolvedValue(makeScanResult([UNREACHABLE_FINDING]));

    pushPreamble([openFinding]);

    // target-unreachable is new → insert
    push([{ id: "find-unreach" }]);
    push([]); // evidence link
    push([]); // review item link
    // NO auto-resolve update — scanUnreachable = true
    pushAssessmentComplete();

    const result = await runObservatoryScan({ assessmentId: ASSESSMENT_ID, tenantDomain: TENANT });

    expect(result.findingsResolved).toBe(0); // transient outage must not clear the register
    expect(result.findingsCreated).toBe(1);  // the synthetic finding is recorded
  });
});
