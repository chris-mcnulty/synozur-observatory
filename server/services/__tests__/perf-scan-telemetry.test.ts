/**
 * Tests for the scheduled performance scan dispatch contract.
 *
 * runScheduledPerfScan has two design invariants under test:
 *  1. The dispatch loop is not serialized — runScheduledPerfScan returns as
 *     soon as deps.enqueue is called; it does NOT await the queued work.
 *  2. Scan rejections are swallowed after logging — the caller is never thrown
 *     at. Telemetry (scheduled_job_runs rows) is the queue persistence hook's
 *     responsibility, not runScheduledPerfScan's.
 *
 * Telemetry-ownership tests (startJobRun / completeJobRun) were removed because
 * runScheduledPerfScan no longer writes DB rows directly — the job queue's
 * onCreate / onComplete hooks own that path. This eliminates the duplicate-row
 * bug where both the explicit telemetry call and the queue hook created a
 * scheduled_job_runs entry for the same scan.
 */

import { describe, it, expect, vi } from "vitest";
import { runScheduledPerfScan, type PerfScanScheduleDeps } from "../perf-scan-schedule-core";

// ── shared helpers ────────────────────────────────────────────────────────────

/** A deferred void promise — useful for waiting on detached continuations. */
function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Build a deps where enqueue is a vi.fn() with a sane default. */
function makeDeps(overrides?: Partial<PerfScanScheduleDeps>): PerfScanScheduleDeps {
  return {
    enqueue: vi.fn(async (_label, work, _opts) => { await work(); }),
    ...overrides,
  };
}

const TENANT = "acme.com";
const ASMT_ID = "asmt-001";
const ASMT_TITLE = "Homepage Perf";

// ── job label ─────────────────────────────────────────────────────────────────

describe("runScheduledPerfScan — job label", () => {
  it("passes perf-scan:<assessmentId> as the queue label", async () => {
    const enqueueLatch = deferred();
    const deps = makeDeps({
      enqueue: vi.fn(async (label, work) => { await work(); enqueueLatch.resolve(); }),
    });

    await runScheduledPerfScan(TENANT, "my-asmt-id", ASMT_TITLE, async () => {}, deps);
    await enqueueLatch.promise;

    expect((deps.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "perf-scan:my-asmt-id",
    );
  });

  it("passes correct enqueue options (maxRetries:2, priority:4, timeoutMs:120000)", async () => {
    const enqueueLatch = deferred();
    const deps = makeDeps({
      enqueue: vi.fn(async (_l, w) => { await w(); enqueueLatch.resolve(); }),
    });

    await runScheduledPerfScan(TENANT, ASMT_ID, ASMT_TITLE, async () => {}, deps);
    await enqueueLatch.promise;

    const opts = (deps.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][2] as {
      maxRetries: number; priority: number; timeoutMs: number;
    };
    expect(opts.maxRetries).toBe(2);
    expect(opts.priority).toBe(4);
    expect(opts.timeoutMs).toBe(120_000);
  });
});

// ── error swallowing ──────────────────────────────────────────────────────────

describe("runScheduledPerfScan — error handling", () => {
  it("does NOT propagate scan errors to the caller (swallowed after logging)", async () => {
    const enqueueLatch = deferred();
    const deps = makeDeps({
      enqueue: vi.fn(async () => { enqueueLatch.resolve(); throw new Error("Browser crashed"); }),
    });

    // Must resolve — scan errors must never crash the sweep loop
    await expect(
      runScheduledPerfScan(TENANT, ASMT_ID, ASMT_TITLE, async () => {}, deps),
    ).resolves.toBeUndefined();

    // Also wait for the detached rejection to be handled
    await enqueueLatch.promise.catch(() => {});
  });

  it("does NOT propagate when all-pages scan throws (allFailed path)", async () => {
    const deps = makeDeps({
      enqueue: vi.fn(async (_l, work) => { await work(); }),
    });
    const allFailWork = async () => { throw new Error("All 3 URL(s) failed to scan"); };

    await expect(
      runScheduledPerfScan(TENANT, ASMT_ID, ASMT_TITLE, allFailWork, deps),
    ).resolves.toBeUndefined();
  });
});

// ── onQueueReject callback ────────────────────────────────────────────────────

describe("runScheduledPerfScan — onQueueReject", () => {
  it("invokes onQueueReject when enqueue rejects (queue failure path)", async () => {
    const rejectLatch = deferred();
    const capturedErr: unknown[] = [];

    const deps = makeDeps({
      enqueue: vi.fn(async () => { throw new Error("Queue infrastructure down"); }),
    });

    await runScheduledPerfScan(
      TENANT, ASMT_ID, ASMT_TITLE, async () => {}, deps,
      1,
      async (err) => { capturedErr.push(err); rejectLatch.resolve(); },
    );
    await rejectLatch.promise;

    expect(capturedErr).toHaveLength(1);
    expect((capturedErr[0] as Error).message).toBe("Queue infrastructure down");
  });

  it("invokes onQueueReject when all scan retries are exhausted (all-fail path)", async () => {
    const rejectLatch = deferred();
    const capturedErr: unknown[] = [];

    const deps = makeDeps({
      enqueue: vi.fn(async (_l, work) => { await work(); }),
    });
    const failWork = async () => { throw new Error("All 3 URL(s) failed to scan"); };

    await runScheduledPerfScan(
      TENANT, ASMT_ID, ASMT_TITLE, failWork, deps,
      1,
      async (err) => { capturedErr.push(err); rejectLatch.resolve(); },
    );
    await rejectLatch.promise;

    expect((capturedErr[0] as Error).message).toBe("All 3 URL(s) failed to scan");
  });

  it("does NOT invoke onQueueReject when the scan succeeds", async () => {
    const enqueueLatch = deferred();
    const onQueueReject = vi.fn(async () => {});

    const deps = makeDeps({
      enqueue: vi.fn(async (_l, work) => { await work(); enqueueLatch.resolve(); }),
    });

    await runScheduledPerfScan(
      TENANT, ASMT_ID, ASMT_TITLE, async () => {}, deps,
      1,
      onQueueReject,
    );
    await enqueueLatch.promise;

    expect(onQueueReject).not.toHaveBeenCalled();
  });

  it("swallows errors thrown by onQueueReject (never surfaces as unhandled rejection)", async () => {
    const rejectLatch = deferred();

    const deps = makeDeps({
      enqueue: vi.fn(async () => { throw new Error("scan failed"); }),
    });

    await expect(
      runScheduledPerfScan(
        TENANT, ASMT_ID, ASMT_TITLE, async () => {}, deps,
        1,
        async () => {
          rejectLatch.resolve();
          throw new Error("DB write in cleanup also failed");
        },
      ),
    ).resolves.toBeUndefined();

    await rejectLatch.promise;
    // The test passes if no unhandled rejection was raised.
  });
});

// ── dispatch is not serialized ────────────────────────────────────────────────

describe("runScheduledPerfScan — parallel dispatch", () => {
  it("dispatches multiple assessments without waiting for earlier scans", async () => {
    const enqueuedLabels: string[] = [];
    let resolveAsmt1!: () => void;
    const asmt2Latch = deferred();

    const deps: PerfScanScheduleDeps = {
      enqueue: vi.fn(async (label, work, _opts) => {
        enqueuedLabels.push(label);
        if (label === "perf-scan:asmt-1") {
          // Never resolves until we manually release it
          await new Promise<void>(res => { resolveAsmt1 = res; });
        } else {
          await work();
          asmt2Latch.resolve();
        }
      }),
    };

    // Dispatch asmt-1 (its enqueue blocks indefinitely)
    await runScheduledPerfScan(TENANT, "asmt-1", "Slow Scan", async () => {}, deps);
    // Dispatch asmt-2 immediately — must not wait for asmt-1 to complete
    await runScheduledPerfScan(TENANT, "asmt-2", "Fast Scan", async () => {}, deps);

    // Wait only for asmt-2's completion — proves it ran without asmt-1 finishing
    await asmt2Latch.promise;

    expect(enqueuedLabels).toContain("perf-scan:asmt-1");
    expect(enqueuedLabels).toContain("perf-scan:asmt-2");

    // Clean up: let asmt-1 finish
    resolveAsmt1();
  });

  it("dispatches asmt-1 completed, asmt-2 failed — both outcomes tracked by queue hook", async () => {
    const allDoneLatch = deferred();
    let doneCount = 0;
    const outcomes: string[] = [];

    const deps: PerfScanScheduleDeps = {
      enqueue: vi.fn(async (label, work) => {
        try {
          await work();
          outcomes.push(`${label}:ok`);
        } catch (e) {
          outcomes.push(`${label}:fail`);
          throw e; // re-throw so queue hook records failure
        } finally {
          if (++doneCount === 2) allDoneLatch.resolve();
        }
      }),
    };

    await runScheduledPerfScan(TENANT, "asmt-A", "Assessment A", async () => {}, deps);
    await runScheduledPerfScan(TENANT, "asmt-B", "Assessment B",
      async () => { throw new Error("scan-B failed"); }, deps);

    await allDoneLatch.promise;

    expect(outcomes).toContain("perf-scan:asmt-A:ok");
    expect(outcomes).toContain("perf-scan:asmt-B:fail");
  });
});
