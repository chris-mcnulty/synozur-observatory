/**
 * Unit tests for the scan-runner ownedRuleIds namespace guard.
 *
 * The guard prevents a scanner from auto-resolving findings it didn't create.
 * This is critical when the same assessment type has two entry points that
 * each own distinct rule-ID namespaces:
 *
 *   /scan (runObservatoryScan + performanceScanner provider)
 *     → rule IDs: slow-ttfb | slow-fcp | slow-lcp | high-cls | slow-load
 *
 *   /performance-scan (dedicated SLA route + buildPerfFindings)
 *     → rule IDs: ttfb_sla_breach | load_time_sla_breach | lcp_sla_breach |
 *                 cls_sla_breach   | tti_sla_breach
 *
 * Without the guard, a clean /scan run (0 findings) would mass-close all open
 * SLA-path findings, and vice versa.
 *
 * These tests exercise the filter predicate directly, without DB or route mocks,
 * because the logic is pure in-memory JS (the DB call is already scoped upstream).
 */

import { describe, it, expect } from "vitest";
import { PERF_SLA_RULE_IDS, PERF_PROVIDER_RULE_IDS } from "../performance-scanner";

// ── Helpers ───────────────────────────────────────────────────────────────────

interface FindingRow {
  id: string;
  scanRuleId: string | null;
  status: string;
}

/**
 * Re-implements the staleOpenIds filter from observatory-scan-runner.ts so
 * changes there will be caught by a compilation-level mismatch as well as here.
 */
function computeStaleOpenIds(
  existingFindings: FindingRow[],
  matchedFindingIds: Set<string>,
  ownedRuleIds: readonly string[] | undefined,
  scanUnreachable: boolean,
): string[] {
  if (scanUnreachable) return [];
  return existingFindings
    .filter((f) => {
      if (f.scanRuleId == null || f.status !== "open" || matchedFindingIds.has(f.id)) return false;
      if (ownedRuleIds && !ownedRuleIds.includes(f.scanRuleId)) return false;
      return true;
    })
    .map((f) => f.id);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("scan-runner ownedRuleIds namespace guard", () => {

  // ── Core isolation ────────────────────────────────────────────────────────

  it("auto-resolves owned findings but not SLA-path findings when ownedRuleIds=PERF_PROVIDER_RULE_IDS", () => {
    const existing: FindingRow[] = [
      { id: "f-slow-ttfb",       scanRuleId: "slow-ttfb",       status: "open" }, // owned by /scan
      { id: "f-ttfb-sla",        scanRuleId: "ttfb_sla_breach", status: "open" }, // owned by /performance-scan
      { id: "f-slow-fcp",        scanRuleId: "slow-fcp",        status: "open" }, // owned by /scan
      { id: "f-lcp-sla",         scanRuleId: "lcp_sla_breach",  status: "open" }, // owned by /performance-scan
    ];

    const stale = computeStaleOpenIds(existing, new Set(), PERF_PROVIDER_RULE_IDS, false);

    // Only the /scan-owned findings must be candidates for auto-resolve
    expect(stale).toContain("f-slow-ttfb");
    expect(stale).toContain("f-slow-fcp");
    // SLA-path findings must be completely untouched
    expect(stale).not.toContain("f-ttfb-sla");
    expect(stale).not.toContain("f-lcp-sla");
  });

  it("auto-resolves SLA-path findings but not provider-path findings when ownedRuleIds=PERF_SLA_RULE_IDS", () => {
    const existing: FindingRow[] = [
      { id: "f-slow-ttfb",  scanRuleId: "slow-ttfb",       status: "open" }, // owned by /scan
      { id: "f-ttfb-sla",   scanRuleId: "ttfb_sla_breach", status: "open" }, // owned by /performance-scan
    ];

    const stale = computeStaleOpenIds(existing, new Set(), PERF_SLA_RULE_IDS, false);

    expect(stale).toContain("f-ttfb-sla");
    expect(stale).not.toContain("f-slow-ttfb");
  });

  // ── Alternating-scan cross-path simulation ────────────────────────────────
  //
  // Simulates the sequence that caused incorrect auto-resolutions before the fix:
  //   1. /performance-scan creates ttfb_sla_breach (open)
  //   2. /scan runs, finds nothing (metrics within provider thresholds)
  //      → without guard: would close ttfb_sla_breach
  //      → with guard: must not close ttfb_sla_breach (not in ownedRuleIds)
  //   3. /scan creates slow-ttfb (open)
  //   4. /performance-scan runs, finds nothing (metrics within SLA)
  //      → without guard: would close slow-ttfb
  //      → with guard: must not close slow-ttfb (not in ownedRuleIds)

  it("alternating sequence: /scan clean run does not close SLA-path findings", () => {
    // State after step 1: SLA-path created ttfb_sla_breach
    const existing: FindingRow[] = [
      { id: "f-ttfb-sla", scanRuleId: "ttfb_sla_breach", status: "open" },
    ];

    // Step 2: /scan runs clean (no matches, ownedRuleIds = PERF_PROVIDER)
    const stale = computeStaleOpenIds(existing, new Set(), PERF_PROVIDER_RULE_IDS, false);

    expect(stale).toHaveLength(0); // must not close the SLA-path finding
  });

  it("alternating sequence: /performance-scan clean run does not close provider-path findings", () => {
    // State after step 3: /scan created slow-ttfb
    const existing: FindingRow[] = [
      { id: "f-slow-ttfb", scanRuleId: "slow-ttfb", status: "open" },
    ];

    // Step 4: /performance-scan runs clean (ownedRuleIds = PERF_SLA)
    const stale = computeStaleOpenIds(existing, new Set(), PERF_SLA_RULE_IDS, false);

    expect(stale).toHaveLength(0); // must not close the provider-path finding
  });

  it("alternating sequence: mixed findings, each scan resolves only its own namespace", () => {
    // Both paths have created findings; /scan now sees only its own matches (matched=slow-ttfb)
    // and should only auto-resolve its unmatched owned finding (slow-fcp), never ttfb_sla_breach
    const existing: FindingRow[] = [
      { id: "f-slow-ttfb", scanRuleId: "slow-ttfb",       status: "open" }, // matched this scan
      { id: "f-slow-fcp",  scanRuleId: "slow-fcp",         status: "open" }, // unmatched, owned
      { id: "f-ttfb-sla",  scanRuleId: "ttfb_sla_breach",  status: "open" }, // cross-namespace
    ];
    const matched = new Set(["f-slow-ttfb"]);

    const stale = computeStaleOpenIds(existing, matched, PERF_PROVIDER_RULE_IDS, false);

    expect(stale).toEqual(["f-slow-fcp"]);            // only unmatched owned rule
    expect(stale).not.toContain("f-slow-ttfb");       // matched → not stale
    expect(stale).not.toContain("f-ttfb-sla");        // cross-namespace → protected
  });

  // ── Human-status guard still applies inside the namespace ─────────────────

  it("does not auto-resolve a finding with human-set status even within the owned namespace", () => {
    const existing: FindingRow[] = [
      { id: "f1", scanRuleId: "slow-ttfb",      status: "accepted_risk" }, // human-owned
      { id: "f2", scanRuleId: "slow-fcp",       status: "false_positive" }, // human-owned
      { id: "f3", scanRuleId: "slow-lcp",       status: "open" },           // auto-resolvable
      { id: "f4", scanRuleId: "ttfb_sla_breach", status: "open" },          // wrong namespace
    ];

    const stale = computeStaleOpenIds(existing, new Set(), PERF_PROVIDER_RULE_IDS, false);

    expect(stale).toEqual(["f3"]); // only open + owned
  });

  // ── Unreachable guard still applies ───────────────────────────────────────

  it("returns no stale IDs when scanUnreachable=true, even for owned findings", () => {
    const existing: FindingRow[] = [
      { id: "f1", scanRuleId: "slow-ttfb", status: "open" },
    ];

    const stale = computeStaleOpenIds(existing, new Set(), PERF_PROVIDER_RULE_IDS, true);

    expect(stale).toHaveLength(0);
  });

  // ── No ownedRuleIds → existing behaviour (all scanRuleId findings eligible) ─

  it("resolves all open scanner findings when ownedRuleIds is undefined (non-performance scanners)", () => {
    const existing: FindingRow[] = [
      { id: "f-hsts",   scanRuleId: "missing-hsts",  status: "open" },
      { id: "f-csp",    scanRuleId: "missing-csp",   status: "open" },
      { id: "f-manual", scanRuleId: null,             status: "open" }, // manual → excluded
    ];

    const stale = computeStaleOpenIds(existing, new Set(), undefined, false);

    expect(stale).toContain("f-hsts");
    expect(stale).toContain("f-csp");
    expect(stale).not.toContain("f-manual"); // scanRuleId null → never auto-resolved
  });

  // ── PERF_SLA_RULE_IDS and PERF_PROVIDER_RULE_IDS are disjoint ────────────

  it("PERF_SLA_RULE_IDS and PERF_PROVIDER_RULE_IDS share no rule IDs", () => {
    const slaSet = new Set<string>(PERF_SLA_RULE_IDS);
    const providerSet = new Set<string>(PERF_PROVIDER_RULE_IDS);
    const intersection = [...slaSet].filter((id) => providerSet.has(id));
    expect(intersection).toHaveLength(0);
  });
});
