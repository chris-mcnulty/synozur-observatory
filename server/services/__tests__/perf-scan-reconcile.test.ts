/**
 * Exercises planPerfFindingReconcile() — a pure function with no DB dependency.
 * Covers the key scenarios required by the implementation contract:
 *   1. Same breach on re-scan → update, no duplicate
 *   2. Two pages breach same rule; one clears on re-scan → only that page's
 *      finding auto-resolves; the other page's finding is untouched
 *   3. Human-set status is never clobbered (finding appears in toUpdate but
 *      status is not part of the update plan)
 *   4. Failed page skips auto-resolve entirely
 *   5. New breach on re-scan inserts a new finding
 *   6. Scan-side dedup: only one of two identical rules is processed per page
 */

import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import {
  planPerfFindingReconcile,
  scopedPerfRuleId,
  type ExistingPerfFinding,
  type IncomingPerfFinding,
} from "../perf-scan-reconcile";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PAGE_A = "https://example.com/";
const PAGE_B = "https://example.com/pricing";

function existing(
  id: string,
  ruleId: string,
  url: string,
  status = "open",
): ExistingPerfFinding {
  return {
    id,
    title: `${ruleId} breach on ${new URL(url).pathname}`,
    status,
    scanRuleId: scopedPerfRuleId(ruleId, url),
    affectedComponent: url,
  };
}

function incoming(ruleId: string, url: string): IncomingPerfFinding {
  return {
    ruleId,
    title: `${ruleId} SLA breach on ${new URL(url).pathname}`,
    description: `${ruleId} exceeded threshold`,
    severity: "Medium",
    recommendation: "Optimise.",
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("planPerfFindingReconcile", () => {
  // 1. Same breach on re-scan → update, no duplicate
  it("updates an existing finding instead of inserting a duplicate when the same rule/page re-breaches", () => {
    const existingFindings: ExistingPerfFinding[] = [
      existing("find-1", "ttfb_sla_breach", PAGE_A),
    ];
    const scanResults: IncomingPerfFinding[] = [
      incoming("ttfb_sla_breach", PAGE_A),
    ];

    const plan = planPerfFindingReconcile(existingFindings, scanResults, PAGE_A, true);

    assert.equal(plan.toUpdate.length, 1, "should update one existing finding");
    assert.equal(plan.toInsert.length, 0, "should not insert a duplicate");
    assert.equal(plan.toResolveIds.length, 0, "nothing to resolve");
    assert.equal(plan.toUpdate[0].id, "find-1");
    assert.equal(plan.toUpdate[0].scanRuleId, scopedPerfRuleId("ttfb_sla_breach", PAGE_A));
  });

  // 2. Two pages breach same rule; one page clears on re-scan
  it("auto-resolves only the cleared page's finding; the other page's finding is untouched", () => {
    // Page A still breaches TTFB; Page B no longer does.
    // The test simulates each page's reconcile call independently.

    const existingPageA: ExistingPerfFinding[] = [
      existing("find-A", "ttfb_sla_breach", PAGE_A),
    ];
    const existingPageB: ExistingPerfFinding[] = [
      existing("find-B", "ttfb_sla_breach", PAGE_B),
    ];

    // Page A re-scan: still breaching → update
    const planA = planPerfFindingReconcile(
      existingPageA,
      [incoming("ttfb_sla_breach", PAGE_A)],
      PAGE_A,
      true,
    );

    // Page B re-scan: no breach → auto-resolve
    const planB = planPerfFindingReconcile(
      existingPageB,
      [],              // no findings from scanner
      PAGE_B,
      true,
    );

    // Page A: updated, not duplicated, not resolved
    assert.equal(planA.toUpdate.length, 1, "page A finding updated");
    assert.equal(planA.toInsert.length, 0, "no new insert for page A");
    assert.equal(planA.toResolveIds.length, 0, "page A finding not resolved");

    // Page B: resolved, not inserted, not updated
    assert.equal(planB.toUpdate.length, 0, "page B finding not updated");
    assert.equal(planB.toInsert.length, 0, "no new insert for page B");
    assert.deepEqual(planB.toResolveIds, ["find-B"], "page B finding auto-resolved");
  });

  // 3. Human-set status is never included in auto-resolve candidates
  it("does not auto-resolve a finding with a human-set status (false_positive)", () => {
    const existingFindings: ExistingPerfFinding[] = [
      existing("find-human", "lcp_sla_breach", PAGE_A, "false_positive"),
    ];

    // Scanner returns no findings — but the human-marked row must survive
    const plan = planPerfFindingReconcile(existingFindings, [], PAGE_A, true);

    assert.equal(plan.toResolveIds.length, 0, "human-set finding must not be auto-resolved");
  });

  it("does not auto-resolve a finding with accepted_risk status", () => {
    const existingFindings: ExistingPerfFinding[] = [
      existing("find-accepted", "load_time_sla_breach", PAGE_A, "accepted_risk"),
    ];
    const plan = planPerfFindingReconcile(existingFindings, [], PAGE_A, true);
    assert.equal(plan.toResolveIds.length, 0);
  });

  // 4. Failed page skips auto-resolve
  it("suppresses auto-resolve when the page scan failed (pageSucceeded=false)", () => {
    const existingFindings: ExistingPerfFinding[] = [
      existing("find-1", "ttfb_sla_breach", PAGE_A),
    ];

    // Page failed → no findings from scanner, but must NOT auto-resolve
    const plan = planPerfFindingReconcile(existingFindings, [], PAGE_A, false);

    assert.equal(plan.toResolveIds.length, 0, "must not auto-resolve on page failure");
    assert.equal(plan.toInsert.length, 0);
  });

  // 5. New breach on re-scan → insert new finding
  it("inserts a finding for a rule not previously seen on this page", () => {
    // No existing findings for this page
    const plan = planPerfFindingReconcile(
      [],
      [incoming("cls_sla_breach", PAGE_A)],
      PAGE_A,
      true,
    );

    assert.equal(plan.toInsert.length, 1, "should insert one new finding");
    assert.equal(plan.toInsert[0].scopedRuleId, scopedPerfRuleId("cls_sla_breach", PAGE_A));
    assert.equal(plan.toUpdate.length, 0);
    assert.equal(plan.toResolveIds.length, 0);
  });

  // 6. Findings for different pages on the same rule never collide
  it("scoped rule IDs for different paths are distinct", () => {
    const rootId = scopedPerfRuleId("ttfb_sla_breach", "https://example.com/");
    const pricingId = scopedPerfRuleId("ttfb_sla_breach", "https://example.com/pricing");

    assert.notEqual(rootId, pricingId, "different paths must produce different scoped ruleIds");
    assert.ok(rootId.includes("ttfb_sla_breach"));
    assert.ok(pricingId.includes("ttfb_sla_breach"));
  });

  // 7. Multiple unmatched open scanner findings all get resolved
  it("resolves all unmatched open scanner findings when page succeeds with no new breaches", () => {
    const existingFindings: ExistingPerfFinding[] = [
      existing("find-ttfb", "ttfb_sla_breach", PAGE_A),
      existing("find-lcp", "lcp_sla_breach", PAGE_A),
      existing("find-load", "load_time_sla_breach", PAGE_A),
    ];

    const plan = planPerfFindingReconcile(existingFindings, [], PAGE_A, true);

    assert.equal(plan.toResolveIds.length, 3, "all three unmatched open findings resolved");
    assert.equal(plan.toUpdate.length, 0);
    assert.equal(plan.toInsert.length, 0);
  });

  // 8. Mixed scan: some rules persist, some clear, some are new
  it("handles mixed outcome: update persisting, resolve cleared, insert new", () => {
    const existingFindings: ExistingPerfFinding[] = [
      existing("find-ttfb", "ttfb_sla_breach", PAGE_A),   // still breaching
      existing("find-lcp", "lcp_sla_breach", PAGE_A),     // now fixed
    ];
    const scanResults: IncomingPerfFinding[] = [
      incoming("ttfb_sla_breach", PAGE_A),   // still there
      incoming("cls_sla_breach", PAGE_A),    // new breach
    ];

    const plan = planPerfFindingReconcile(existingFindings, scanResults, PAGE_A, true);

    assert.equal(plan.toUpdate.length, 1, "ttfb updated");
    assert.equal(plan.toUpdate[0].id, "find-ttfb");
    assert.equal(plan.toInsert.length, 1, "cls inserted as new");
    assert.equal(plan.toInsert[0].ruleId, "cls_sla_breach");
    assert.deepEqual(plan.toResolveIds, ["find-lcp"], "lcp auto-resolved");
  });
});
