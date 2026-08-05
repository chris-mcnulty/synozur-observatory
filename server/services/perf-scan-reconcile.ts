/**
 * Pure reconcile logic for per-page performance scan findings.
 *
 * Follows the same contract as observatory-scan-runner.ts:
 *   - Match existing findings by URL-scoped scanRuleId.
 *   - Matched rows: refresh title/description/severity; NEVER touch status
 *     (human decisions like false_positive/accepted_risk/in_progress are
 *     preserved).
 *   - Auto-resolve only open, scanner-created (scanRuleId != null) findings
 *     that were not matched — and ONLY when the page scanned successfully.
 *     A failed/unreachable page must not mass-close its existing findings.
 *
 * Keeping this as a pure function (no DB imports) makes it trivially testable
 * without any database mocking.
 */

export interface ExistingPerfFinding {
  id: string;
  title: string;
  status: string;
  /** URL-scoped scanRuleId set by a previous scan, e.g. "ttfb_sla_breach::https://example.com/". */
  scanRuleId: string | null;
  /** The URL of the page this finding belongs to. */
  affectedComponent: string | null;
}

export interface IncomingPerfFinding {
  /** Base rule key, e.g. "ttfb_sla_breach". */
  ruleId: string;
  title: string;
  description: string;
  severity: string;
  recommendation: string;
}

export interface PerfFindingUpdate {
  id: string;
  title: string;
  description: string;
  severity: string;
  /** The scoped ruleId to (re-)stamp on the row. */
  scanRuleId: string;
}

export interface PerfFindingInsert extends IncomingPerfFinding {
  /** Pre-computed URL-scoped ruleId to store on the new row. */
  scopedRuleId: string;
}

export interface PerfReconcilePlan {
  toUpdate: PerfFindingUpdate[];
  toInsert: PerfFindingInsert[];
  /** IDs of open scanner-created findings that were not matched → auto-resolve. */
  toResolveIds: string[];
}

/**
 * Produce a URL-scoped scanRuleId so findings for different pages
 * never collide or auto-resolve each other.
 * Uses origin + pathname so query strings don't create spurious duplicates.
 */
export function scopedPerfRuleId(ruleId: string, url: string): string {
  try {
    const u = new URL(url);
    return `${ruleId}::${u.origin}${u.pathname}`;
  } catch {
    return `${ruleId}::${url}`;
  }
}

/**
 * Given the existing findings already stored for a specific page URL and the
 * fresh scanner results for that page, compute the minimal set of DB operations
 * needed to keep the findings register accurate without duplicating or
 * clobbering human decisions.
 *
 * @param existingForPage  Findings already in obs_findings where affectedComponent = url.
 * @param scannerFindings  Findings returned by runPerformanceScan for this URL.
 * @param url              The page URL being reconciled.
 * @param pageSucceeded    True when the page was measured successfully. When false
 *                         auto-resolution is suppressed — a transient failure must
 *                         not mass-close real findings.
 */
export function planPerfFindingReconcile(
  existingForPage: ExistingPerfFinding[],
  scannerFindings: IncomingPerfFinding[],
  url: string,
  pageSucceeded: boolean,
): PerfReconcilePlan {
  // Build lookup map — only rows that already carry a URL-scoped scanRuleId.
  const existingByRuleId = new Map<string, ExistingPerfFinding>(
    existingForPage
      .filter((f) => f.scanRuleId != null)
      .map((f) => [f.scanRuleId as string, f]),
  );

  const matchedIds = new Set<string>();
  const toUpdate: PerfFindingUpdate[] = [];
  const toInsert: PerfFindingInsert[] = [];

  for (const finding of scannerFindings) {
    const scoped = scopedPerfRuleId(finding.ruleId, url);
    const existing = existingByRuleId.get(scoped);

    if (existing) {
      // Consume so the same existing row can only match one scanner finding.
      existingByRuleId.delete(scoped);
      matchedIds.add(existing.id);
      // Refresh measured values (title/description embed the measured ms) and
      // severity — but leave status alone; it may be a human decision.
      toUpdate.push({
        id: existing.id,
        title: finding.title,
        description: finding.description,
        severity: finding.severity,
        scanRuleId: scoped,
      });
    } else {
      toInsert.push({ ...finding, scopedRuleId: scoped });
    }
  }

  // Auto-resolve open scanner-created findings that were not seen in this scan.
  // Skipped entirely when the page failed so a transient outage doesn't clear
  // real findings.
  const toResolveIds = pageSucceeded
    ? existingForPage
        .filter((f) => f.scanRuleId != null && f.status === "open" && !matchedIds.has(f.id))
        .map((f) => f.id)
    : [];

  return { toUpdate, toInsert, toResolveIds };
}
