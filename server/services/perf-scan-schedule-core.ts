/**
 * Pure scheduling-logic helpers for the performance scan scheduler.
 *
 * Extracted here so they can be unit-tested without a database or browser.
 * The scheduler in scheduled-jobs.ts delegates all decisions to these functions.
 */

export type ScanSchedule = "daily" | "weekly" | "disabled";

export const PERF_SCAN_INTERVAL_MS: Record<"daily" | "weekly", number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Returns true when an automated scan should be dispatched for this assessment.
 *
 * Rules (all must hold):
 *  - scanSchedule is not "disabled"
 *  - elapsed time since lastAutoScanAt >= the schedule interval
 *  - no scan job is currently active or pending (caller provides this)
 *  - the application has a usable URL (caller provides this)
 */
export function isPerfScanDue(opts: {
  scanSchedule: ScanSchedule;
  lastAutoScanAt: Date | null;
  nowMs?: number;
}): boolean {
  const { scanSchedule, lastAutoScanAt, nowMs = Date.now() } = opts;

  if (scanSchedule === "disabled") return false;

  const intervalMs = PERF_SCAN_INTERVAL_MS[scanSchedule];
  const lastRun = lastAutoScanAt ? lastAutoScanAt.getTime() : 0;

  return nowMs - lastRun >= intervalMs;
}

/**
 * Returns true when a scheduled scan should skip creating a finding because
 * an open finding for the same rule already exists on this assessment.
 *
 * For manual scans this always returns false (no dedup — user explicitly ran).
 * Never touches human-set finding statuses; caller provides the set of open rule IDs.
 */
export function shouldSkipFinding(opts: {
  scanSource: "manual" | "scheduled";
  ruleId: string | null | undefined;
  openRuleIds: Set<string>;
}): boolean {
  const { scanSource, ruleId, openRuleIds } = opts;
  if (scanSource !== "scheduled") return false;
  if (!ruleId) return false;
  return openRuleIds.has(ruleId);
}

// ── Async telemetry contract ─────────────────────────────────────────────────

/**
 * Dependencies injected into runScheduledPerfScan. Separating them from the
 * implementation lets tests pass mock implementations and verify the telemetry
 * contract without a real DB or job queue.
 */
export interface PerfScanScheduleDeps {
  /** Record a job start in scheduled_job_runs. Returns the row id (may be "" on failure). */
  startJobRun(
    jobType: string,
    tenantDomain: string,
    targetId: string,
    targetName: string,
  ): Promise<string>;
  /** Record a job outcome in scheduled_job_runs. */
  completeJobRun(
    jobRunId: string,
    status: "completed" | "failed",
    result?: Record<string, unknown>,
    errorMessage?: string,
  ): Promise<void>;
  /**
   * Enqueue the scan work. Returns a Promise that resolves on scan success and
   * rejects (after all retries are exhausted) on failure.
   *
   * runScheduledPerfScan does NOT await this — it attaches telemetry as a
   * detached continuation so the dispatch loop is never serialized.
   */
  enqueue(
    label: string,
    work: () => Promise<void>,
    opts: { maxRetries: number; priority: number; timeoutMs: number },
  ): Promise<void>;
}

/**
 * Dispatch a single scheduled performance scan and wire its outcome back into
 * the scheduled_job_runs telemetry row.
 *
 * Two invariants this function enforces:
 *
 * 1. Telemetry is opportunistic — a falsy/failed startJobRun must NEVER block
 *    or cancel scan dispatch. lastAutoScanAt is already stamped by the time
 *    this function is called; dropping the scan would delay it a full interval.
 *
 * 2. The dispatch loop is not serialized — deps.enqueue is NOT awaited here.
 *    Instead, telemetry completion fires as a detached async continuation
 *    (.then/.catch) so the caller can immediately dispatch the next assessment.
 *    completeJobRun is still called only after the job's full retry lifecycle
 *    finishes. Unhandled rejections in the continuation are caught and logged.
 */
export async function runScheduledPerfScan(
  tenantDomain: string,
  assessmentId: string,
  assessmentTitle: string,
  work: () => Promise<void>,
  deps: PerfScanScheduleDeps,
): Promise<void> {
  // Start telemetry opportunistically. A throw or falsy return must not prevent
  // the scan from running — the scan is the primary goal; telemetry is secondary.
  let jobRunId = "";
  try {
    jobRunId = await deps.startJobRun(
      "perfScanScheduled",
      tenantDomain,
      assessmentId,
      assessmentTitle,
    );
  } catch {
    // telemetry unavailable — continue without a row id
  }

  // Fire-and-forget: attach telemetry as a detached continuation so the
  // calling sweep loop can immediately dispatch the next due assessment.
  // completeJobRun fires only after the scan's full retry lifecycle ends.
  deps
    .enqueue(`perf-scan:${assessmentId}`, work, {
      maxRetries: 2,
      priority: 4,
      timeoutMs: 120_000,
    })
    .then(async () => {
      if (jobRunId) {
        try {
          await deps.completeJobRun(jobRunId, "completed", {});
        } catch (telErr) {
          // Telemetry write failure must not surface as an unhandled rejection.
          console.warn(
            `[PerfScan] Telemetry complete write failed for ${assessmentId}:`,
            telErr,
          );
        }
      }
    })
    .catch(async (err: unknown) => {
      // The scan failed (retries exhausted) — record failure then swallow so
      // the unhandled-rejection handler is never triggered by a scan error.
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (jobRunId) {
        try {
          await deps.completeJobRun(jobRunId, "failed", undefined, errorMessage);
        } catch (telErr) {
          console.warn(
            `[PerfScan] Telemetry failure write failed for ${assessmentId}:`,
            telErr,
          );
        }
      }
    });

  // Return immediately — the caller dispatches the next assessment without delay.
}
