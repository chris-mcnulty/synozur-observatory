/**
 * scan-reconciliation.ts
 *
 * Pure-function core of the security-scan deduplication/reconciliation logic.
 * Extracted from the `enqueueScan` callback in
 * server/routes/observatory-modules.ts so it can be unit-tested without a
 * live database.
 *
 * The route handler calls `computeScanReconciliation`, then applies the
 * returned plan via DB statements — keeping side-effects out of this module.
 */

import type { ScannerFinding } from "./observatory-scanners";

// ── Input types ──────────────────────────────────────────────────────────────

/** One row from the joined obsPenTestFindings + obsFindings query. */
export interface ExistingFindingRow {
  penTestFindingId: string;
  findingId: string;
  /** scanRuleId is null for legacy rows created before the column was added. */
  scanRuleId: string | null;
  title: string;
  /**
   * Current status on the obs_findings row.
   * Relevant values: "open" | "remediated" | "accepted_risk" |
   *                  "false_positive" | "in_progress"
   */
  status: string;
}

// ── Output types ─────────────────────────────────────────────────────────────

export interface UpdateOp {
  row: ExistingFindingRow;
  finding: ScannerFinding;
  /**
   * Status to write back.
   *
   * Re-open rule: when a finding reappears in a scan, it is re-opened to
   * "open" if and only if its current status is "open" or "remediated"
   * (the auto-resolve state).  Deliberate human dispositions —
   * "accepted_risk", "false_positive", and "in_progress" — are always
   * preserved; scans never override conscious human decisions.
   */
  newStatus: string;
}

export interface ReconciliationPlan {
  /** Existing findings whose ruleId (or legacy title) matched a scan result — update metadata. */
  toUpdate: UpdateOp[];
  /** Scanner findings with no matching existing row — insert as new findings. */
  toInsert: ScannerFinding[];
  /**
   * Finding IDs that were present in the previous scan but absent from this
   * one, AND whose status is still "open".  These should be marked "remediated".
   *
   * Empty when `scanFailed` is true — a transient outage must never clear the
   * existing finding register.
   */
  toResolve: Array<{ findingId: string }>;
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Compute the set of DB operations needed to reconcile a new scan result
 * against the existing findings for a pen test.
 *
 * @param existingRows - All finding rows currently linked to the pen test.
 * @param scanFindings - Findings produced by the latest scan run.
 * @param scanFailed   - True when the scan contained a "target-unreachable"
 *                       finding (hard failure); suppresses auto-resolution.
 */
export function computeScanReconciliation(
  existingRows: ExistingFindingRow[],
  scanFindings: ScannerFinding[],
  scanFailed: boolean,
): ReconciliationPlan {
  // Primary lookup: scanRuleId → row (for findings that already have one)
  const existingByRuleId = new Map<string, ExistingFindingRow>(
    existingRows
      .filter((r) => r.scanRuleId != null)
      .map((r) => [r.scanRuleId as string, r]),
  );

  // Fallback lookup: title → row for legacy findings without a scanRuleId.
  // Use the first match per title; duplicates from before this fix are handled
  // naturally (only the matched row is updated; extras remain open and can be
  // cleaned up manually or via the delete UI).
  const legacyByTitle = new Map<string, ExistingFindingRow>(
    existingRows
      .filter((r) => r.scanRuleId == null)
      .map((r) => [r.title, r]),
  );

  // Track which ruleIds the current scan returned (for stale-resolution)
  const returnedRuleIds = new Set(scanFindings.map((f) => f.ruleId));

  const toUpdate: UpdateOp[] = [];
  const toInsert: ScannerFinding[] = [];

  for (const sf of scanFindings) {
    const existing = existingByRuleId.get(sf.ruleId) ?? legacyByTitle.get(sf.title);

    if (existing) {
      // Finding already exists — update description/severity/rule metadata.
      // Re-open rule: "remediated" findings are re-opened because "remediated"
      // is the auto-resolve state; a reappearing rule means it isn't fixed.
      // Deliberate human dispositions — "accepted_risk", "false_positive", and
      // "in_progress" — are preserved; scans must never override human decisions.
      const newStatus =
        existing.status === "open" || existing.status === "remediated"
          ? "open"
          : existing.status;

      toUpdate.push({ row: existing, finding: sf, newStatus });

      // Backfill scanRuleId for legacy rows matched by title, so the stale-
      // resolution step below uses ruleId (not title) for accurate tracking.
      existingByRuleId.set(sf.ruleId, { ...existing, scanRuleId: sf.ruleId });
    } else {
      toInsert.push(sf);
    }
  }

  // Auto-resolve findings whose rule was not returned — but ONLY for a
  // successful scan.  A failed scan (target-unreachable) must never clear the
  // existing register; a transient outage is not a fix.
  const toResolve: Array<{ findingId: string }> = [];

  if (!scanFailed) {
    const staleRuleIds = [...existingByRuleId.keys()].filter(
      (rid) => !returnedRuleIds.has(rid),
    );

    for (const rid of staleRuleIds) {
      const row = existingByRuleId.get(rid)!;
      // Only auto-resolve findings that are still "open" — never touch
      // remediated, accepted_risk, false_positive, or in_progress rows.
      if (row.status === "open") {
        toResolve.push({ findingId: row.findingId });
      }
    }
  }

  return { toUpdate, toInsert, toResolve };
}
