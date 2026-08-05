/**
 * scan-reconciliation.test.ts
 *
 * Unit tests for the pen-test security-scan deduplication / reconciliation
 * logic extracted into server/services/scan-reconciliation.ts.
 *
 * These tests exercise computeScanReconciliation() as a pure function — no
 * database, no HTTP — so they are fast, deterministic, and free of
 * infrastructure dependencies.
 *
 * Coverage map
 * ────────────
 * AC1 – Exercise the reconcile/upsert logic twice against the same pen test.
 * AC2 – Second run with same rules does NOT create new finding rows.
 * AC3 – Findings absent from second scan are marked "resolved" (toResolve).
 * AC4 – Previously auto-resolved ("remediated") findings that reappear are
 *        re-opened to "open".  Deliberate human dispositions —
 *        "accepted_risk", "false_positive", "in_progress" — are preserved.
 * AC5a – Human-set statuses (accepted_risk, false_positive, in_progress) are
 *         never touched by auto-resolve when their rule goes absent.
 * AC5b – Auto-resolve is skipped when the target is unreachable (scanFailed).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { computeScanReconciliation } from "../scan-reconciliation";
import type { ExistingFindingRow } from "../scan-reconciliation";
import type { ScannerFinding } from "../observatory-scanners";

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeExisting(
  overrides: Partial<ExistingFindingRow> & Pick<ExistingFindingRow, "findingId" | "scanRuleId" | "title">,
): ExistingFindingRow {
  return {
    penTestFindingId: `ptf-${overrides.findingId}`,
    status: "open",
    ...overrides,
  };
}

function makeFinding(
  ruleId: string,
  title: string,
  overrides: Partial<ScannerFinding> = {},
): ScannerFinding {
  return { ruleId, title, severity: "Medium", ...overrides };
}

// ── AC1 + AC2: second scan with identical rules produces no new insertions ─────

describe("computeScanReconciliation — deduplication", () => {
  it("AC1+AC2: first scan produces all inserts; second scan with same findings produces only updates, no new inserts", () => {
    const hsts = makeFinding("missing-hsts", "Missing HSTS", { severity: "High" });
    const csp  = makeFinding("missing-csp",  "No CSP",       { severity: "Medium" });

    // ── First scan: no existing rows → everything is new ──
    const run1 = computeScanReconciliation([], [hsts, csp], false);

    assert.equal(run1.toInsert.length, 2, "first run should insert both findings");
    assert.equal(run1.toUpdate.length, 0, "first run should have nothing to update");
    assert.equal(run1.toResolve.length, 0, "first run: nothing to resolve");

    // Simulate the DB state after run1: both findings now exist with scanRuleIds
    const existingAfterRun1: ExistingFindingRow[] = [
      makeExisting({ findingId: "f-hsts", scanRuleId: "missing-hsts", title: "Missing HSTS", status: "open" }),
      makeExisting({ findingId: "f-csp",  scanRuleId: "missing-csp",  title: "No CSP",       status: "open" }),
    ];

    // ── Second scan: same findings, same rules → no new inserts ──
    const run2 = computeScanReconciliation(existingAfterRun1, [hsts, csp], false);

    assert.equal(run2.toInsert.length, 0, "second run must not insert duplicates");
    assert.equal(run2.toUpdate.length, 2, "second run should update both existing findings");
    assert.equal(run2.toResolve.length, 0, "second run: nothing to resolve when all rules return");
  });

  it("second scan with one new rule inserts only the genuinely new finding", () => {
    const hsts = makeFinding("missing-hsts", "Missing HSTS");

    const existing: ExistingFindingRow[] = [
      makeExisting({ findingId: "f-hsts", scanRuleId: "missing-hsts", title: "Missing HSTS" }),
    ];

    const xframe = makeFinding("missing-x-frame-options", "Missing X-Frame-Options");

    const run = computeScanReconciliation(existing, [hsts, xframe], false);

    assert.equal(run.toUpdate.length, 1, "existing hsts finding is updated");
    assert.equal(run.toUpdate[0].row.findingId, "f-hsts");
    assert.equal(run.toInsert.length, 1, "x-frame-options is genuinely new");
    assert.equal(run.toInsert[0].ruleId, "missing-x-frame-options");
    assert.equal(run.toResolve.length, 0);
  });

  it("matches existing findings by ruleId, not just title", () => {
    // Two findings with the same title but different ruleIds → two separate rows
    const existing: ExistingFindingRow[] = [
      makeExisting({ findingId: "f-1", scanRuleId: "rule-a", title: "Header Missing" }),
    ];

    // Scan returns a different ruleId (even though title is identical)
    const scan = [makeFinding("rule-b", "Header Missing")];
    const plan = computeScanReconciliation(existing, scan, false);

    assert.equal(plan.toInsert.length, 1, "different ruleId → new insert even if title matches");
    assert.equal(plan.toUpdate.length, 0);
  });
});

// ── AC3: findings absent from second scan are resolved ────────────────────────

describe("computeScanReconciliation — auto-resolve stale findings", () => {
  it("AC3: finding absent from second scan (open status) is placed in toResolve", () => {
    const existing: ExistingFindingRow[] = [
      makeExisting({ findingId: "f-hsts", scanRuleId: "missing-hsts", title: "Missing HSTS", status: "open" }),
      makeExisting({ findingId: "f-csp",  scanRuleId: "missing-csp",  title: "No CSP",       status: "open" }),
    ];

    // Second scan only returns HSTS — CSP rule is no longer flagged (fixed)
    const plan = computeScanReconciliation(
      existing,
      [makeFinding("missing-hsts", "Missing HSTS")],
      false,
    );

    assert.equal(plan.toResolve.length, 1, "absent CSP finding should be resolved");
    assert.equal(plan.toResolve[0].findingId, "f-csp");
    assert.equal(plan.toUpdate.length, 1, "HSTS finding should be updated");
    assert.equal(plan.toInsert.length, 0);
  });

  it("resolves multiple stale open findings in one pass", () => {
    const existing: ExistingFindingRow[] = [
      makeExisting({ findingId: "f-a", scanRuleId: "rule-a", title: "A", status: "open" }),
      makeExisting({ findingId: "f-b", scanRuleId: "rule-b", title: "B", status: "open" }),
      makeExisting({ findingId: "f-c", scanRuleId: "rule-c", title: "C", status: "open" }),
    ];

    // Empty scan result (all rules fixed)
    const plan = computeScanReconciliation(existing, [], false);

    assert.equal(plan.toResolve.length, 3);
    const resolvedIds = plan.toResolve.map((r) => r.findingId).sort();
    assert.deepEqual(resolvedIds, ["f-a", "f-b", "f-c"]);
    assert.equal(plan.toInsert.length, 0);
    assert.equal(plan.toUpdate.length, 0);
  });
});

// ── AC4: re-open behaviour ────────────────────────────────────────────────────

describe("computeScanReconciliation — reappearing findings: re-open vs preserve (AC4)", () => {
  it("AC4: a 'remediated' finding that reappears is re-opened to 'open'", () => {
    // Auto-resolve previously set this to "remediated"; the rule fires again.
    const existing: ExistingFindingRow[] = [
      makeExisting({
        findingId: "f-hsts",
        scanRuleId: "missing-hsts",
        title: "Missing HSTS",
        status: "remediated",
      }),
    ];

    const plan = computeScanReconciliation(
      existing,
      [makeFinding("missing-hsts", "Missing HSTS")],
      false,
    );

    assert.equal(plan.toInsert.length, 0, "no duplicate row inserted");
    assert.equal(plan.toUpdate.length, 1, "existing row updated with fresh metadata");
    assert.equal(plan.toUpdate[0].newStatus, "open", "remediated → open on reappearance");
    assert.equal(plan.toResolve.length, 0, "reappearing finding must not also be in toResolve");
  });

  it("a finding already 'open' and re-found stays 'open'", () => {
    const existing: ExistingFindingRow[] = [
      makeExisting({ findingId: "f-csp", scanRuleId: "missing-csp", title: "No CSP", status: "open" }),
    ];
    const plan = computeScanReconciliation(existing, [makeFinding("missing-csp", "No CSP")], false);
    assert.equal(plan.toUpdate[0].newStatus, "open");
  });

  it("'accepted_risk' is preserved when the rule reappears (human decision)", () => {
    const existing: ExistingFindingRow[] = [
      makeExisting({ findingId: "f-x", scanRuleId: "rule-x", title: "X", status: "accepted_risk" }),
    ];
    const plan = computeScanReconciliation(existing, [makeFinding("rule-x", "X")], false);
    assert.equal(plan.toUpdate[0].newStatus, "accepted_risk", "accepted_risk must not be overridden");
  });

  it("'false_positive' is preserved when the rule reappears (human decision)", () => {
    const existing: ExistingFindingRow[] = [
      makeExisting({ findingId: "f-x", scanRuleId: "rule-x", title: "X", status: "false_positive" }),
    ];
    const plan = computeScanReconciliation(existing, [makeFinding("rule-x", "X")], false);
    assert.equal(plan.toUpdate[0].newStatus, "false_positive", "false_positive must not be overridden");
  });

  it("'in_progress' is preserved when the rule reappears (work underway)", () => {
    const existing: ExistingFindingRow[] = [
      makeExisting({ findingId: "f-x", scanRuleId: "rule-x", title: "X", status: "in_progress" }),
    ];
    const plan = computeScanReconciliation(existing, [makeFinding("rule-x", "X")], false);
    assert.equal(plan.toUpdate[0].newStatus, "in_progress", "in_progress must not be overridden");
  });
});

// ── AC5a: human statuses are never touched by auto-resolve ────────────────────

describe("computeScanReconciliation — human status preservation (AC5a)", () => {
  const humanStatuses = ["remediated", "accepted_risk", "false_positive", "in_progress"] as const;

  for (const status of humanStatuses) {
    it(`findings with status "${status}" are excluded from toResolve even when their rule is absent`, () => {
      const existing: ExistingFindingRow[] = [
        makeExisting({ findingId: "f-x", scanRuleId: "rule-x", title: "Some Finding", status }),
      ];

      // Scan returns nothing → rule-x is "stale"
      const plan = computeScanReconciliation(existing, [], false);

      assert.equal(
        plan.toResolve.length,
        0,
        `human status "${status}" must not be auto-resolved`,
      );
    });
  }

  it("only open findings are included in toResolve when multiple statuses coexist", () => {
    const existing: ExistingFindingRow[] = [
      makeExisting({ findingId: "f-open",        scanRuleId: "rule-open",        title: "Open",         status: "open" }),
      makeExisting({ findingId: "f-remediated",  scanRuleId: "rule-remediated",  title: "Remediated",   status: "remediated" }),
      makeExisting({ findingId: "f-accepted",    scanRuleId: "rule-accepted",    title: "Accepted",     status: "accepted_risk" }),
      makeExisting({ findingId: "f-fp",          scanRuleId: "rule-fp",          title: "False Pos",    status: "false_positive" }),
      makeExisting({ findingId: "f-inprogress",  scanRuleId: "rule-inprogress",  title: "In Progress",  status: "in_progress" }),
    ];

    // Scan returns nothing → all rules are stale
    const plan = computeScanReconciliation(existing, [], false);

    assert.equal(plan.toResolve.length, 1, "only the open finding should be resolved");
    assert.equal(plan.toResolve[0].findingId, "f-open");
  });
});

// ── AC5b: auto-resolve suppressed when target is unreachable ──────────────────

describe("computeScanReconciliation — target-unreachable suppresses auto-resolve (AC5b)", () => {
  it("AC5b: when scanFailed=true, no findings are auto-resolved even if rules are absent", () => {
    const existing: ExistingFindingRow[] = [
      makeExisting({ findingId: "f-hsts", scanRuleId: "missing-hsts", title: "Missing HSTS", status: "open" }),
      makeExisting({ findingId: "f-csp",  scanRuleId: "missing-csp",  title: "No CSP",       status: "open" }),
    ];

    // Scan failed — only target-unreachable finding returned
    const unreachableFinding = makeFinding("target-unreachable", "Target Unreachable");
    const plan = computeScanReconciliation(existing, [unreachableFinding], true);

    assert.equal(plan.toResolve.length, 0, "scanFailed=true must suppress all auto-resolution");
    // The unreachable finding itself is new (no existing row for it) → inserted
    assert.equal(plan.toInsert.length, 1);
    assert.equal(plan.toInsert[0].ruleId, "target-unreachable");
  });

  it("scanFailed=false with all rules present → nothing resolved", () => {
    const finding = makeFinding("missing-hsts", "Missing HSTS");
    const existing: ExistingFindingRow[] = [
      makeExisting({ findingId: "f-hsts", scanRuleId: "missing-hsts", title: "Missing HSTS", status: "open" }),
    ];
    const plan = computeScanReconciliation(existing, [finding], false);
    assert.equal(plan.toResolve.length, 0);
    assert.equal(plan.toUpdate.length, 1);
  });

  it("scanFailed=true with zero scan findings → no auto-resolve, no inserts, no updates", () => {
    const existing: ExistingFindingRow[] = [
      makeExisting({ findingId: "f-hsts", scanRuleId: "missing-hsts", title: "Missing HSTS", status: "open" }),
    ];
    const plan = computeScanReconciliation(existing, [], true);
    assert.equal(plan.toResolve.length, 0, "failed scan with empty results must not resolve anything");
    assert.equal(plan.toInsert.length, 0);
    assert.equal(plan.toUpdate.length, 0);
  });
});

// ── Legacy title-based matching ───────────────────────────────────────────────

describe("computeScanReconciliation — legacy title-based fallback", () => {
  it("matches a legacy row (scanRuleId=null) by title and backfills ruleId via toUpdate", () => {
    const existing: ExistingFindingRow[] = [
      makeExisting({ findingId: "f-legacy", scanRuleId: null, title: "Missing HSTS", status: "open" }),
    ];
    const scan = [makeFinding("missing-hsts", "Missing HSTS")];
    const plan = computeScanReconciliation(existing, scan, false);

    assert.equal(plan.toUpdate.length, 1, "legacy row matched by title → update, not insert");
    assert.equal(plan.toInsert.length, 0, "must not insert a duplicate");
    assert.equal(plan.toResolve.length, 0);
    // The update op carries the new ruleId so the route can backfill scanRuleId
    assert.equal(plan.toUpdate[0].finding.ruleId, "missing-hsts");
  });

  it("legacy row absent from second scan is resolved", () => {
    // Legacy row (no scanRuleId) was matched by title in run1 and acquired a ruleId.
    // In a subsequent call the function receives the updated row with scanRuleId set.
    const existingWithRuleId: ExistingFindingRow[] = [
      makeExisting({ findingId: "f-legacy", scanRuleId: "missing-hsts", title: "Missing HSTS", status: "open" }),
    ];
    // New scan returns nothing → stale
    const plan = computeScanReconciliation(existingWithRuleId, [], false);
    assert.equal(plan.toResolve.length, 1);
    assert.equal(plan.toResolve[0].findingId, "f-legacy");
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("computeScanReconciliation — edge cases", () => {
  it("empty existing + empty scan → empty plan", () => {
    const plan = computeScanReconciliation([], [], false);
    assert.equal(plan.toInsert.length, 0);
    assert.equal(plan.toUpdate.length, 0);
    assert.equal(plan.toResolve.length, 0);
  });

  it("empty existing + N findings → N inserts", () => {
    const findings = [
      makeFinding("r-a", "A"),
      makeFinding("r-b", "B"),
      makeFinding("r-c", "C"),
    ];
    const plan = computeScanReconciliation([], findings, false);
    assert.equal(plan.toInsert.length, 3);
    assert.equal(plan.toUpdate.length, 0);
    assert.equal(plan.toResolve.length, 0);
  });

  it("severity and description from scanner overwrite existing values in toUpdate", () => {
    const existing: ExistingFindingRow[] = [
      makeExisting({ findingId: "f-hsts", scanRuleId: "missing-hsts", title: "Missing HSTS", status: "open" }),
    ];
    const updatedFinding = makeFinding("missing-hsts", "Missing HSTS", {
      severity: "Critical",
      description: "Updated description from re-scan",
    });
    const plan = computeScanReconciliation(existing, [updatedFinding], false);
    assert.equal(plan.toUpdate[0].finding.severity, "Critical");
    assert.equal(plan.toUpdate[0].finding.description, "Updated description from re-scan");
  });
});
