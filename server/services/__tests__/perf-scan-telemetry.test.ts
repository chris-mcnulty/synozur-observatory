/**
 * Integration-style tests for the scheduled performance scan telemetry contract.
 *
 * runScheduledPerfScan has two design invariants under test:
 *  1. Telemetry is opportunistic — falsy/failed startJobRun must never block
 *     or cancel scan dispatch.
 *  2. The dispatch loop is not serialized — runScheduledPerfScan returns as
 *     soon as dispatch fires; completeJobRun runs in a detached continuation
 *     after the job's own retry lifecycle finishes.
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

/** Completions captured by the shared completeJobRun spy. */
type Completion = [string, "completed" | "failed", unknown?, string?];

/** Build a set of deps where all three fns are vi.fn() with sane defaults. */
function makeDeps(overrides?: Partial<PerfScanScheduleDeps>): {
  deps: PerfScanScheduleDeps;
  completions: Completion[];
} {
  const completions: Completion[] = [];

  const deps: PerfScanScheduleDeps = {
    startJobRun: vi.fn(async () => "job-run-id-123"),
    completeJobRun: vi.fn(async (jobRunId, status, result?, errorMessage?) => {
      completions.push([jobRunId, status, result, errorMessage]);
    }),
    // Default enqueue: runs work synchronously then resolves
    enqueue: vi.fn(async (_label, work, _opts) => { await work(); }),
    ...overrides,
  };

  return { deps, completions };
}

const TENANT = "acme.com";
const ASMT_ID = "asmt-001";
const ASMT_TITLE = "Homepage Perf";

// ── success path ─────────────────────────────────────────────────────────────

describe("runScheduledPerfScan — success", () => {
  it("marks job run as completed after the scan work resolves", async () => {
    const completeLatch = deferred();
    const scanWork = vi.fn(async () => {});
    const { deps, completions } = makeDeps({
      completeJobRun: vi.fn(async (id, status, result?, err?) => {
        completions.push([id, status, result, err]);
        completeLatch.resolve();
      }),
    });

    await runScheduledPerfScan(TENANT, ASMT_ID, ASMT_TITLE, scanWork, deps);
    await completeLatch.promise; // wait for detached continuation

    expect(deps.startJobRun).toHaveBeenCalledWith(
      "perfScanScheduled", TENANT, ASMT_ID, ASMT_TITLE,
    );
    expect(scanWork).toHaveBeenCalledOnce();
    expect(completions).toHaveLength(1);
    expect(completions[0][0]).toBe("job-run-id-123");
    expect(completions[0][1]).toBe("completed");
    expect(completions[0][3]).toBeUndefined();
  });

  it("passes maxRetries:2, priority:4, timeoutMs:120000 to enqueue", async () => {
    const completeLatch = deferred();
    const { deps } = makeDeps({
      enqueue: vi.fn(async (_l, w, _o) => { await w(); }),
      completeJobRun: vi.fn(async () => { completeLatch.resolve(); }),
    });

    await runScheduledPerfScan(TENANT, ASMT_ID, ASMT_TITLE, async () => {}, deps);
    await completeLatch.promise;

    const opts = (deps.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][2] as {
      maxRetries: number; priority: number; timeoutMs: number;
    };
    expect(opts.maxRetries).toBe(2);
    expect(opts.priority).toBe(4);
    expect(opts.timeoutMs).toBe(120_000);
  });

  it("uses the correct job-queue label", async () => {
    const completeLatch = deferred();
    const { deps } = makeDeps({
      enqueue: vi.fn(async (_l, w) => { await w(); }),
      completeJobRun: vi.fn(async () => { completeLatch.resolve(); }),
    });

    await runScheduledPerfScan(TENANT, "my-asmt-id", ASMT_TITLE, async () => {}, deps);
    await completeLatch.promise;

    expect((deps.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "perf-scan:my-asmt-id",
    );
  });
});

// ── failure-after-retries path ────────────────────────────────────────────────

describe("runScheduledPerfScan — failure after retries exhausted", () => {
  it("marks job run as failed when enqueue rejects (retries exhausted)", async () => {
    const completeLatch = deferred();
    const { deps, completions } = makeDeps({
      enqueue: vi.fn(async () => { throw new Error("Browser crashed after 3 attempts"); }),
      completeJobRun: vi.fn(async (id, status, result?, err?) => {
        completions.push([id, status, result, err]);
        completeLatch.resolve();
      }),
    });

    // runScheduledPerfScan does NOT propagate scan errors — the continuation swallows
    await runScheduledPerfScan(TENANT, ASMT_ID, ASMT_TITLE, async () => {}, deps);
    await completeLatch.promise;

    expect(completions[0][1]).toBe("failed");
    expect(completions[0][3]).toBe("Browser crashed after 3 attempts");
  });

  it("does NOT propagate the scan error to the caller (continuation swallows it)", async () => {
    const completeLatch = deferred();
    const { deps } = makeDeps({
      enqueue: vi.fn(async () => { throw new Error("Timeout after 120s"); }),
      completeJobRun: vi.fn(async () => { completeLatch.resolve(); }),
    });

    // Must resolve, not reject
    await expect(
      runScheduledPerfScan(TENANT, ASMT_ID, ASMT_TITLE, async () => {}, deps),
    ).resolves.toBeUndefined();
    await completeLatch.promise;
  });

  it("records the error message from a non-Error rejection", async () => {
    const completeLatch = deferred();
    const { deps, completions } = makeDeps({
      enqueue: vi.fn(async () => { throw "string rejection"; }),
      completeJobRun: vi.fn(async (id, status, result?, err?) => {
        completions.push([id, status, result, err]);
        completeLatch.resolve();
      }),
    });

    await runScheduledPerfScan(TENANT, ASMT_ID, ASMT_TITLE, async () => {}, deps);
    await completeLatch.promise;

    expect(completions[0][3]).toBe("string rejection");
  });

  it("marks failed when the scan work itself throws", async () => {
    const completeLatch = deferred();
    const { deps, completions } = makeDeps({
      enqueue: vi.fn(async (_l, work) => { await work(); }),
      completeJobRun: vi.fn(async (id, status, result?, err?) => {
        completions.push([id, status, result, err]);
        completeLatch.resolve();
      }),
    });
    const failingWork = async () => { throw new Error("TTFB probe failed"); };

    await runScheduledPerfScan(TENANT, ASMT_ID, ASMT_TITLE, failingWork, deps);
    await completeLatch.promise;

    expect(completions[0][1]).toBe("failed");
    expect(completions[0][3]).toBe("TTFB probe failed");
  });
});

// ── ordering invariant ───────────────────────────────────────────────────────

describe("runScheduledPerfScan — ordering", () => {
  it("always starts the telemetry row before firing enqueue", async () => {
    const order: string[] = [];
    const completeLatch = deferred();

    const deps: PerfScanScheduleDeps = {
      startJobRun: vi.fn(async () => { order.push("start"); return "job-1"; }),
      enqueue: vi.fn(async (_l, w) => { order.push("enqueue"); await w(); }),
      completeJobRun: vi.fn(async () => { order.push("complete"); completeLatch.resolve(); }),
    };

    await runScheduledPerfScan(TENANT, ASMT_ID, ASMT_TITLE, async () => {}, deps);
    await completeLatch.promise;

    expect(order).toEqual(["start", "enqueue", "complete"]);
  });

  it("marks complete only AFTER enqueue resolves (not immediately after dispatch)", async () => {
    const completeLatch = deferred();
    let enqueueResolve!: () => void;
    let completedBeforeEnqueueFinished = false;
    let completeCount = 0;

    const deps: PerfScanScheduleDeps = {
      startJobRun: vi.fn(async () => "job-1"),
      // enqueue never resolves until we call enqueueResolve
      enqueue: vi.fn(() => new Promise<void>(res => { enqueueResolve = res; })),
      completeJobRun: vi.fn(async () => {
        completeCount++;
        completeLatch.resolve();
      }),
    };

    await runScheduledPerfScan(TENANT, ASMT_ID, ASMT_TITLE, async () => {}, deps);

    // Scan is still "running" — completeJobRun must not have been called yet
    completedBeforeEnqueueFinished = completeCount > 0;
    expect(completedBeforeEnqueueFinished).toBe(false);

    // Let the scan finish — continuation should fire
    enqueueResolve();
    await completeLatch.promise;

    expect(completeCount).toBe(1);
    expect(deps.completeJobRun).toHaveBeenCalledWith("job-1", "completed", {});
  });
});

// ── telemetry unavailable — scan must still run ───────────────────────────────

describe("runScheduledPerfScan — telemetry unavailable", () => {
  it("still enqueues and runs the scan when startJobRun returns empty string", async () => {
    const scanWork = vi.fn(async () => {});
    // Use a latch on enqueue since there's no telemetry row to wait on
    const enqueueLatch = deferred();
    const { deps } = makeDeps({
      startJobRun: vi.fn(async () => ""),
      enqueue: vi.fn(async (_l, work) => { await work(); enqueueLatch.resolve(); }),
      completeJobRun: vi.fn(async () => {}), // called with no-op if id were present
    });

    await runScheduledPerfScan(TENANT, ASMT_ID, ASMT_TITLE, scanWork, deps);
    await enqueueLatch.promise;

    expect(deps.enqueue).toHaveBeenCalledOnce();
    expect(scanWork).toHaveBeenCalledOnce();
    // completeJobRun must not be called — there is no row to update
    expect(deps.completeJobRun).not.toHaveBeenCalled();
  });

  it("still enqueues and runs the scan when startJobRun throws", async () => {
    const scanWork = vi.fn(async () => {});
    const enqueueLatch = deferred();
    const { deps } = makeDeps({
      startJobRun: vi.fn(async () => { throw new Error("DB unreachable"); }),
      enqueue: vi.fn(async (_l, work) => { await work(); enqueueLatch.resolve(); }),
      completeJobRun: vi.fn(async () => {}),
    });

    // Must resolve — startJobRun throw must be swallowed
    await expect(
      runScheduledPerfScan(TENANT, ASMT_ID, ASMT_TITLE, scanWork, deps),
    ).resolves.toBeUndefined();

    await enqueueLatch.promise;
    expect(scanWork).toHaveBeenCalledOnce();
    expect(deps.completeJobRun).not.toHaveBeenCalled();
  });
});

// ── parallel dispatch — no serialization ─────────────────────────────────────

describe("runScheduledPerfScan — parallel dispatch", () => {
  it("dispatches multiple assessments promptly without waiting for earlier scans", async () => {
    // Assessment 1: enqueue never resolves (simulates a 120s scan still running)
    // Assessment 2: should still be dispatched immediately after assessment 1
    const enqueuedLabels: string[] = [];
    let resolveAsmt1!: () => void;
    const asmt2Latch = deferred();

    const deps: PerfScanScheduleDeps = {
      startJobRun: vi.fn(async () => "run-id"),
      completeJobRun: vi.fn(async () => {}),
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
    // asmt-2 index in array must appear after asmt-1 (both dispatched)
    expect(enqueuedLabels.indexOf("perf-scan:asmt-1")).toBeLessThan(
      enqueuedLabels.indexOf("perf-scan:asmt-2"),
    );

    // Cleanup dangling promise to prevent test-runner unhandled-rejection warning
    resolveAsmt1();
  });

  it("records correct telemetry for each assessment independently", async () => {
    const completions: Completion[] = [];
    const allDoneLatch = deferred();
    let doneCount = 0;

    const deps: PerfScanScheduleDeps = {
      startJobRun: vi.fn(async (_type, _tenant, targetId) => `run-${targetId}`),
      enqueue: vi.fn(async (_l, work) => { await work(); }),
      completeJobRun: vi.fn(async (id, status, result?, err?) => {
        completions.push([id, status, result, err]);
        if (++doneCount === 2) allDoneLatch.resolve();
      }),
    };

    await runScheduledPerfScan(TENANT, "asmt-A", "Assessment A", async () => {}, deps);
    await runScheduledPerfScan(TENANT, "asmt-B", "Assessment B",
      async () => { throw new Error("scan-B failed"); }, deps);

    await allDoneLatch.promise;

    const byId = Object.fromEntries(completions.map(c => [c[0], c]));
    expect(byId["run-asmt-A"][1]).toBe("completed");
    expect(byId["run-asmt-B"][1]).toBe("failed");
    expect(byId["run-asmt-B"][3]).toBe("scan-B failed");
  });
});
