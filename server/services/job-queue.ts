type JobType = "pdf" | "monitor" | "crawl" | "analysis" | "planner" | "scan" | "other";
type JobStatus = "pending" | "active" | "completed" | "failed" | "timeout";

/** Optional context passed alongside a job for DB persistence and display. */
export interface JobContext {
  tenantDomain?: string;
  targetId?: string;
  targetName?: string;
}

/** Live progress data published by a running job. */
export interface JobProgress {
  /** 0..100 percent complete. Undefined when indeterminate. */
  percent?: number;
  /** Human-readable phase label, e.g. "Synthesising sections". */
  phase?: string;
  /** When iterating over a list of items, which item are we on (1-indexed). */
  currentItem?: number;
  /** Total number of items being processed. */
  totalItems?: number;
  /** Display name of the item currently being processed. */
  currentItemName?: string;
}

/** A function jobs can call to publish their current phase / percent. */
export type ProgressReporter = (patch: Partial<JobProgress>) => void;

interface QueuedJob<T = any> {
  id: string;
  type: JobType;
  priority: number;
  label: string;
  status: JobStatus;
  work: (signal?: AbortSignal, reportProgress?: ProgressReporter) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: any) => void;
  enqueuedAt: number;
  startedAt?: number;
  completedAt?: number;
  timeoutMs: number;
  abortController?: AbortController;
  /** DB row id when persistence is enabled. */
  dbRowId?: string;
  ctx?: JobContext;
  /** P3: Retry tracking */
  attempt: number;
  maxRetries: number;
  /** Live progress reported by the running job. */
  progress?: JobProgress;
}

// ---------------------------------------------------------------------------
// P3 — Dead-Letter Queue
// Jobs that exhaust retries land here for admin inspection / dismissal.
// ---------------------------------------------------------------------------
export interface DeadLetterEntry {
  jobId: string;
  type: JobType;
  label: string;
  error: string;
  attempts: number;
  failedAt: number;
  ctx?: JobContext;
}

const deadLetterStore: DeadLetterEntry[] = [];
const MAX_DLQ_SIZE = 200;

export function getDeadLetterJobs(): DeadLetterEntry[] {
  return [...deadLetterStore];
}

export function dismissDeadLetterJob(jobId: string): boolean {
  const idx = deadLetterStore.findIndex(e => e.jobId === jobId);
  if (idx === -1) return false;
  deadLetterStore.splice(idx, 1);
  return true;
}

// ---------------------------------------------------------------------------
// Persistence hooks — wired up at startup via setPersistenceHooks() so that
// the job queue can write lifecycle events to the scheduled_job_runs table
// without importing the DB layer directly (avoids circular dependencies).
// ---------------------------------------------------------------------------
interface PersistenceHooks {
  onCreate(job: {
    id: string;
    type: JobType;
    label: string;
    status: "running";
    startedAt: Date;
    ctx?: JobContext;
  }): Promise<string>;
  onComplete(dbRowId: string, status: "completed" | "failed", errorMessage?: string): Promise<void>;
}

let persistenceHooks: PersistenceHooks | null = null;

/** Called once during server startup after the DB is ready. */
export function setPersistenceHooks(hooks: PersistenceHooks): void {
  persistenceHooks = hooks;
  console.log("[JobQueue] DB persistence hooks registered");
}

interface QueueConfig {
  maxConcurrent: number;
  perTypeLimits: Partial<Record<JobType, number>>;
  defaultTimeoutMs: number;
}

interface QueueStats {
  active: number;
  pending: number;
  completed: number;
  failed: number;
  activeByType: Record<string, number>;
  pendingByType: Record<string, number>;
  activeJobs: Array<{ id: string; type: JobType; label: string; runningSec: number; progress?: JobProgress }>;
  pendingJobs: Array<{ id: string; type: JobType; label: string; waitingSec: number; priority: number }>;
  paused: boolean;
}

const DEFAULT_CONFIG: QueueConfig = {
  maxConcurrent: 4,
  perTypeLimits: {
    pdf: 1,
    // Crawl + monitor are background, non-time-sensitive work. Keep them at 1
    // concurrent each so they trickle through the dedicated crawl pool rather
    // than bursting and starving time-sensitive workers (publish/email).
    crawl: 1,
    monitor: 1,
    analysis: 1,
    planner: 2,
    // Scans are user-triggered and headless-browser-bound; limit to 2 so they
    // don't exhaust the crawl pool (shared with website monitoring).
    scan: 2,
  },
  defaultTimeoutMs: 5 * 60 * 1000,
};

const PRIORITY = {
  pdf: 10,
  scan: 6,   // User-triggered — higher than background crawls
  analysis: 5,
  planner: 4,
  crawl: 3,
  monitor: 2,
  other: 1,
} as const;

let jobCounter = 0;
const pendingQueue: QueuedJob[] = [];
const activeJobs: Map<string, QueuedJob> = new Map();
let completedCount = 0;
let failedCount = 0;
let paused = false;
let config = { ...DEFAULT_CONFIG };

function generateJobId(type: JobType): string {
  return `${type}-${++jobCounter}-${Date.now().toString(36)}`;
}

function getActiveCountByType(type: JobType): number {
  let count = 0;
  for (const job of activeJobs.values()) {
    if (job.type === type) count++;
  }
  return count;
}

function getPendingCountByType(type: JobType): number {
  return pendingQueue.filter(j => j.type === type).length;
}

function canStartJob(type: JobType): boolean {
  if (paused) return false;
  if (activeJobs.size >= config.maxConcurrent) return false;
  const typeLimit = config.perTypeLimits[type];
  if (typeLimit !== undefined && getActiveCountByType(type) >= typeLimit) return false;
  return true;
}

function processQueue(): void {
  if (paused) return;

  const sortedPending = [...pendingQueue].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.enqueuedAt - b.enqueuedAt;
  });

  for (const job of sortedPending) {
    if (activeJobs.size >= config.maxConcurrent) break;
    if (!canStartJob(job.type)) continue;

    const idx = pendingQueue.indexOf(job);
    if (idx === -1) continue;
    pendingQueue.splice(idx, 1);

    startJob(job);
  }
}

function startJob(job: QueuedJob): void {
  job.status = "active";
  job.startedAt = Date.now();
  const abortController = new AbortController();
  job.abortController = abortController;
  activeJobs.set(job.id, job);

  console.log(`[JobQueue] Starting ${job.type}/${job.label} (active: ${activeJobs.size}/${config.maxConcurrent}, pending: ${pendingQueue.length})`);

  const reportProgress: ProgressReporter = (patch) => {
    job.progress = { ...(job.progress || {}), ...patch };
  };

  // Persist job start BEFORE running work so job.dbRowId is always set before
  // onComplete can fire — even on immediate (< 1 ms) scan failures.
  // Fire-and-forget from processQueue's perspective, but work only starts after
  // the onCreate promise settles so there is no race on dbRowId.
  const persistenceReady: Promise<void> = persistenceHooks
    ? persistenceHooks.onCreate({
        id: job.id,
        type: job.type,
        label: job.label,
        status: "running",
        startedAt: new Date(job.startedAt),
        ctx: job.ctx,
      }).then(dbRowId => {
        job.dbRowId = dbRowId;
      }).catch(err => {
        console.error(`[JobQueue] Failed to persist job start for ${job.label}:`, err.message);
      })
    : Promise.resolve();

  persistenceReady.then(() => {
    const timeoutHandle = setTimeout(() => {
      if (activeJobs.has(job.id)) {
        console.error(`[JobQueue] Job ${job.id} (${job.label}) timed out after ${job.timeoutMs / 1000}s - aborting`);
        job.status = "timeout";
        abortController.abort();
        activeJobs.delete(job.id);
        failedCount++;
        if (persistenceHooks && job.dbRowId) {
          persistenceHooks.onComplete(job.dbRowId, "failed", `Timed out after ${job.timeoutMs / 1000}s`).catch(() => {});
        }
        job.reject(new Error(`Job timed out after ${job.timeoutMs / 1000}s: ${job.label}`));
        processQueue();
      }
    }, job.timeoutMs);

    job.work(abortController.signal, reportProgress)
      .then(result => {
        clearTimeout(timeoutHandle);
        if (job.status === "timeout") return;
        job.status = "completed";
        job.completedAt = Date.now();
        activeJobs.delete(job.id);
        completedCount++;
        const durationSec = ((job.completedAt - (job.startedAt || job.enqueuedAt)) / 1000).toFixed(1);
        console.log(`[JobQueue] Completed ${job.type}/${job.label} in ${durationSec}s (active: ${activeJobs.size}, pending: ${pendingQueue.length})`);
        if (persistenceHooks && job.dbRowId) {
          persistenceHooks.onComplete(job.dbRowId, "completed").catch(() => {});
        }
        job.resolve(result);
        processQueue();
      })
      .catch(err => {
        clearTimeout(timeoutHandle);
        if (job.status === "timeout") return;
        activeJobs.delete(job.id);

        // P3: Retry with exponential back-off (2s -> 4s -> 8s)
        if (job.attempt < job.maxRetries) {
          const nextAttempt = job.attempt + 1;
          const delay = 2000 * Math.pow(2, job.attempt); // 2s, 4s, 8s
          console.warn(`[JobQueue] Retrying ${job.type}/${job.label} (attempt ${nextAttempt}/${job.maxRetries}) in ${delay}ms — ${err.message}`);
          job.attempt = nextAttempt;
          job.status = "pending";
          setTimeout(() => {
            if (canStartJob(job.type)) {
              startJob(job);
            } else {
              pendingQueue.push(job);
            }
          }, delay);
          // Free the concurrency slot so other pending jobs can start immediately
          processQueue();
          return;
        }

        // Exhausted retries — move to dead-letter queue
        job.status = "failed";
        job.completedAt = Date.now();
        failedCount++;
        console.error(`[JobQueue] Failed ${job.type}/${job.label} after ${job.attempt + 1} attempts: ${err.message}`);

        if (deadLetterStore.length >= MAX_DLQ_SIZE) {
          deadLetterStore.shift(); // evict oldest
        }
        deadLetterStore.push({
          jobId: job.id,
          type: job.type,
          label: job.label,
          error: err.message || String(err),
          attempts: job.attempt + 1,
          failedAt: Date.now(),
          ctx: job.ctx,
        });
        console.warn(`[JobQueue] Job ${job.id} moved to dead-letter queue (${deadLetterStore.length} entries)`);

        if (persistenceHooks && job.dbRowId) {
          persistenceHooks.onComplete(job.dbRowId, "failed", err.message).catch(() => {});
        }
        job.reject(err);
        processQueue();
      });
  });
}

export function enqueue<T>(
  type: JobType,
  label: string,
  work: ((signal?: AbortSignal, reportProgress?: ProgressReporter) => Promise<T>) | ((signal?: AbortSignal) => Promise<T>) | (() => Promise<T>),
  options?: { priority?: number; timeoutMs?: number; ctx?: JobContext; maxRetries?: number }
): Promise<T> {
  const priority = options?.priority ?? PRIORITY[type] ?? PRIORITY.other;
  const timeoutMs = options?.timeoutMs ?? config.defaultTimeoutMs;
  const maxRetries = options?.maxRetries ?? 3;

  return new Promise<T>((resolve, reject) => {
    const job: QueuedJob<T> = {
      id: generateJobId(type),
      type,
      priority,
      label,
      status: "pending",
      work,
      resolve,
      reject,
      enqueuedAt: Date.now(),
      timeoutMs,
      ctx: options?.ctx,
      attempt: 0,
      maxRetries,
    };

    if (canStartJob(type)) {
      startJob(job);
    } else {
      pendingQueue.push(job);
      console.log(`[JobQueue] Queued ${type}/${label} (priority: ${priority}, pending: ${pendingQueue.length})`);
    }
  });
}

export function enqueuePdf<T>(
  label: string,
  work:
    | ((signal?: AbortSignal, reportProgress?: ProgressReporter) => Promise<T>)
    | ((signal?: AbortSignal) => Promise<T>)
    | (() => Promise<T>),
  timeoutMs?: number,
  ctx?: JobContext,
): Promise<T> {
  return enqueue("pdf", label, work, { priority: PRIORITY.pdf, timeoutMs: timeoutMs ?? 60000, ctx });
}

export function enqueueMonitor<T>(label: string, work: ((signal?: AbortSignal) => Promise<T>) | (() => Promise<T>), timeoutMs?: number, ctx?: JobContext): Promise<T> {
  return enqueue("monitor", label, work, { priority: PRIORITY.monitor, timeoutMs: timeoutMs ?? 10 * 60 * 1000, ctx });
}

/** Enqueue an Observatory automated scan (accessibility / security / performance). */
export function enqueueScan<T>(
  label: string,
  work: ((signal?: AbortSignal, reportProgress?: ProgressReporter) => Promise<T>) | (() => Promise<T>),
  options?: { timeoutMs?: number; ctx?: JobContext; maxRetries?: number },
): Promise<T> {
  return enqueue("scan", label, work, {
    priority: PRIORITY.scan,
    timeoutMs: options?.timeoutMs ?? 5 * 60 * 1000,
    ctx: options?.ctx,
    maxRetries: options?.maxRetries ?? 1, // Scans are expensive — one retry by default
  });
}

/**
 * Enqueue an outbound Microsoft Planner sync job. Planner sync runs through
 * the queue so slow/failing Graph calls don't block the originating HTTP
 * request, and so retry/back-off + DLQ behaviour is applied uniformly.
 */
export function enqueuePlannerSync<T>(
  label: string,
  work: ((signal?: AbortSignal) => Promise<T>) | (() => Promise<T>),
  options?: { timeoutMs?: number; ctx?: JobContext; maxRetries?: number },
): Promise<T> {
  return enqueue("planner", label, work, {
    priority: PRIORITY.planner,
    timeoutMs: options?.timeoutMs ?? 5 * 60 * 1000,
    ctx: options?.ctx,
    maxRetries: options?.maxRetries ?? 3,
  });
}

/**
 * Update the live progress of an active job. Safe to call repeatedly; values
 * are merged into the existing progress record. Unknown jobs are ignored.
 */
export function updateJobProgress(jobId: string, patch: Partial<JobProgress>): void {
  const job = activeJobs.get(jobId);
  if (!job) return;
  job.progress = { ...(job.progress || {}), ...patch };
}

export interface JobStatusByLabel {
  status: "active" | "pending" | "not_found";
  progress?: JobProgress;
  runningSec?: number;
  queuePosition?: number;
  pendingAhead?: number;
  type?: JobType;
}

/**
 * Look up the queue status for the first job whose label matches `labelPrefix`.
 * When `tenantDomain` is provided, only jobs whose ctx.tenantDomain matches
 * are considered — this scopes the lookup to the caller's tenant.
 */
export function getJobStatusByLabel(labelPrefix: string, tenantDomain?: string): JobStatusByLabel {
  const matches = (job: QueuedJob) =>
    job.label.startsWith(labelPrefix) &&
    (!tenantDomain || job.ctx?.tenantDomain === tenantDomain);

  const now = Date.now();
  for (const job of activeJobs.values()) {
    if (matches(job)) {
      return {
        status: "active",
        progress: job.progress,
        runningSec: Math.round((now - (job.startedAt || now)) / 1000),
        type: job.type,
      };
    }
  }
  const sortedPending = [...pendingQueue].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.enqueuedAt - b.enqueuedAt;
  });
  const idx = sortedPending.findIndex(matches);
  if (idx !== -1) {
    const target = sortedPending[idx];
    const pendingAhead = sortedPending.slice(0, idx).filter(j => j.type === target.type).length;
    return {
      status: "pending",
      queuePosition: idx + 1,
      pendingAhead,
      type: target.type,
    };
  }
  return { status: "not_found" };
}

export interface ActiveJobInfo {
  label: string;
  status: "active" | "pending";
  progress?: JobProgress;
  type: JobType;
  runningSec: number;
}

/**
 * List all active and pending jobs whose label starts with `labelPrefix`,
 * scoped to the caller's tenant. Used by UIs that need to discover any
 * in-flight job (e.g. battlecard generation) for multiple targets at once.
 */
export function getActiveJobsByLabelPrefix(
  labelPrefix: string,
  tenantDomain?: string,
): ActiveJobInfo[] {
  const now = Date.now();
  const out: ActiveJobInfo[] = [];
  const matches = (job: QueuedJob) =>
    job.label.startsWith(labelPrefix) &&
    (!tenantDomain || job.ctx?.tenantDomain === tenantDomain);
  for (const job of activeJobs.values()) {
    if (!matches(job)) continue;
    out.push({
      label: job.label,
      status: "active",
      progress: job.progress,
      type: job.type,
      runningSec: Math.round((now - (job.startedAt || now)) / 1000),
    });
  }
  for (const job of pendingQueue) {
    if (!matches(job)) continue;
    out.push({
      label: job.label,
      status: "pending",
      type: job.type,
      runningSec: 0,
    });
  }
  return out;
}

export function getQueueStatus(): QueueStats {
  const now = Date.now();
  const activeByType: Record<string, number> = {};
  const pendingByType: Record<string, number> = {};

  for (const job of activeJobs.values()) {
    activeByType[job.type] = (activeByType[job.type] || 0) + 1;
  }
  for (const job of pendingQueue) {
    pendingByType[job.type] = (pendingByType[job.type] || 0) + 1;
  }

  return {
    active: activeJobs.size,
    pending: pendingQueue.length,
    completed: completedCount,
    failed: failedCount,
    activeByType,
    pendingByType,
    activeJobs: [...activeJobs.values()].map(j => ({
      id: j.id,
      type: j.type,
      label: j.label,
      runningSec: Math.round((now - (j.startedAt || now)) / 1000),
      progress: j.progress,
    })),
    pendingJobs: pendingQueue
      .sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt)
      .slice(0, 20)
      .map(j => ({
        id: j.id,
        type: j.type,
        label: j.label,
        waitingSec: Math.round((now - j.enqueuedAt) / 1000),
        priority: j.priority,
      })),
    paused,
  };
}

export function pauseQueue(): void {
  paused = true;
  console.log("[JobQueue] Queue paused — active jobs will finish but no new ones will start");
}

export function resumeQueue(): void {
  paused = false;
  console.log("[JobQueue] Queue resumed");
  processQueue();
}

export function updateConfig(newConfig: Partial<QueueConfig>): void {
  config = { ...config, ...newConfig };
  if (newConfig.perTypeLimits) {
    config.perTypeLimits = { ...DEFAULT_CONFIG.perTypeLimits, ...newConfig.perTypeLimits };
  }
  console.log(`[JobQueue] Config updated:`, JSON.stringify(config));
}

export { PRIORITY };
