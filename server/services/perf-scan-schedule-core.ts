/**
 * Pure scheduling-logic helpers for the performance scan scheduler.
 *
 * Extracted here so they can be unit-tested without a database or browser.
 * The scheduler in scheduled-jobs.ts delegates all decisions to these functions.
 *
 * Telemetry note: runScheduledPerfScan does NOT write scheduled_job_runs rows
 * directly. The job queue's persistence hooks (setPersistenceHooks in index.ts)
 * write a single labeled row for every queued job — that row is the canonical
 * telemetry record. Direct startJobRun/completeJobRun calls were removed to
 * avoid duplicate rows that can cause the status endpoint to report stale data.
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

// ── Scan dispatcher ──────────────────────────────────────────────────────────

/**
 * How long to allow per URL (ms). The job timeout scales with URL count so
 * a 20-page batch never gets aborted by the queue mid-scan.
 */
export const PERF_SCAN_TIMEOUT_PER_URL_MS = 120_000;

/**
 * Injected dependencies for runScheduledPerfScan — kept minimal so this pure
 * function can be unit-tested without a real job queue.
 */
export interface PerfScanScheduleDeps {
  /**
   * Enqueue the scan work. Returns a Promise that resolves on scan success and
   * rejects (after all retries are exhausted) on failure.
   *
   * runScheduledPerfScan does NOT await this — rejections are routed through
   * the onQueueReject callback and then swallowed. Telemetry
   * (scheduled_job_runs rows) is written by the queue's own persistence hooks
   * (onCreate / onComplete in index.ts) so there is exactly one telemetry row
   * per queued job and no duplicate records.
   */
  enqueue(
    label: string,
    work: () => Promise<void>,
    opts: { maxRetries: number; priority: number; timeoutMs: number },
  ): Promise<void>;
}

/**
 * Dispatch a single scheduled performance scan.
 *
 * Design invariants:
 *
 * 1. The dispatch loop is NOT serialized — deps.enqueue is NOT awaited.
 *    The caller can immediately dispatch the next assessment without waiting
 *    for the current scan to complete.
 *
 * 2. Queue rejections are routed through `onQueueReject` (if provided), then
 *    logged and swallowed. The caller uses this hook to transition the
 *    pre-created scan batch row from "running" to "failed" when the queue
 *    rejects before work ever ran (infrastructure failure, queue down).
 *    Note: when the work DID run but all retries failed, executePerfScan
 *    already updates the batch row — onQueueReject's DB update is a safe
 *    idempotent no-op in that case (WHERE status='running' matches nothing).
 *
 * Telemetry is owned by the queue persistence hooks — do NOT add
 * startJobRun/completeJobRun calls here or duplicate rows will be created.
 */
export async function runScheduledPerfScan(
  tenantDomain: string,
  assessmentId: string,
  assessmentTitle: string,
  work: () => Promise<void>,
  deps: PerfScanScheduleDeps,
  /** Total number of URLs being scanned (primary + extra). Defaults to 1. */
  urlCount = 1,
  /**
   * Optional callback invoked when the queue rejects (all retries exhausted
   * or queue infrastructure failure). Use this to transition any pre-created
   * batch row from "running" → "failed". Errors thrown by this callback are
   * swallowed so they never surface as unhandled rejections.
   */
  onQueueReject?: (err: unknown) => Promise<void> | void,
): Promise<void> {
  const jobLabel = `perf-scan:${assessmentId}`;

  // Fire-and-forget: attach cleanup/logging as a detached continuation so the
  // calling sweep loop can immediately dispatch the next due assessment.
  deps
    .enqueue(jobLabel, work, {
      maxRetries: 2,
      priority: 4,
      timeoutMs: PERF_SCAN_TIMEOUT_PER_URL_MS * Math.max(1, urlCount),
    })
    .catch(async (err: unknown) => {
      // Retries exhausted (or queue failure) — log, then call the cleanup hook.
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[PerfScan] Scheduled scan failed for assessment ${assessmentId} (${tenantDomain}): ${message}`,
      );
      if (onQueueReject) {
        try {
          await onQueueReject(err);
        } catch (cleanupErr) {
          // Cleanup errors must never surface as unhandled rejections.
          console.warn(`[PerfScan] onQueueReject callback failed for ${assessmentId}:`, cleanupErr);
        }
      }
    });

  // Return immediately — the caller dispatches the next assessment without delay.
}
