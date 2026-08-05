import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
  isPerfScanDue,
  shouldSkipFinding,
  PERF_SCAN_INTERVAL_MS,
} from "../perf-scan-schedule-core";

// ── isPerfScanDue ────────────────────────────────────────────────────────────

describe("isPerfScanDue", () => {
  const NOW = new Date("2024-06-15T12:00:00Z").getTime();

  it("returns false when schedule is 'disabled'", () => {
    assert.equal(
      isPerfScanDue({ scanSchedule: "disabled", lastAutoScanAt: null, nowMs: NOW }),
      false,
    );
  });

  it("returns false when schedule is 'disabled' even if never scanned", () => {
    assert.equal(
      isPerfScanDue({ scanSchedule: "disabled", lastAutoScanAt: null, nowMs: NOW }),
      false,
    );
  });

  it("returns true for daily schedule when never scanned (lastAutoScanAt = null)", () => {
    assert.equal(
      isPerfScanDue({ scanSchedule: "daily", lastAutoScanAt: null, nowMs: NOW }),
      true,
    );
  });

  it("returns true for weekly schedule when never scanned", () => {
    assert.equal(
      isPerfScanDue({ scanSchedule: "weekly", lastAutoScanAt: null, nowMs: NOW }),
      true,
    );
  });

  it("returns false for daily schedule when last scan was < 24 h ago", () => {
    const lastAutoScanAt = new Date(NOW - 23 * 60 * 60 * 1000); // 23 h ago
    assert.equal(
      isPerfScanDue({ scanSchedule: "daily", lastAutoScanAt, nowMs: NOW }),
      false,
    );
  });

  it("returns true for daily schedule when last scan was exactly 24 h ago", () => {
    const lastAutoScanAt = new Date(NOW - PERF_SCAN_INTERVAL_MS.daily);
    assert.equal(
      isPerfScanDue({ scanSchedule: "daily", lastAutoScanAt, nowMs: NOW }),
      true,
    );
  });

  it("returns true for daily schedule when last scan was > 24 h ago", () => {
    const lastAutoScanAt = new Date(NOW - 25 * 60 * 60 * 1000); // 25 h ago
    assert.equal(
      isPerfScanDue({ scanSchedule: "daily", lastAutoScanAt, nowMs: NOW }),
      true,
    );
  });

  it("returns false for weekly schedule when last scan was 3 days ago", () => {
    const lastAutoScanAt = new Date(NOW - 3 * 24 * 60 * 60 * 1000);
    assert.equal(
      isPerfScanDue({ scanSchedule: "weekly", lastAutoScanAt, nowMs: NOW }),
      false,
    );
  });

  it("returns true for weekly schedule when last scan was exactly 7 days ago", () => {
    const lastAutoScanAt = new Date(NOW - PERF_SCAN_INTERVAL_MS.weekly);
    assert.equal(
      isPerfScanDue({ scanSchedule: "weekly", lastAutoScanAt, nowMs: NOW }),
      true,
    );
  });

  it("returns true for weekly schedule when last scan was 8 days ago", () => {
    const lastAutoScanAt = new Date(NOW - 8 * 24 * 60 * 60 * 1000);
    assert.equal(
      isPerfScanDue({ scanSchedule: "weekly", lastAutoScanAt, nowMs: NOW }),
      true,
    );
  });

  it("uses Date.now() as default when nowMs is omitted", () => {
    // Never scanned → always due regardless of current time
    assert.equal(
      isPerfScanDue({ scanSchedule: "daily", lastAutoScanAt: null }),
      true,
    );
  });
});

// ── shouldSkipFinding ────────────────────────────────────────────────────────

describe("shouldSkipFinding", () => {
  const openRuleIds = new Set(["slow-ttfb", "slow-lcp"]);

  it("never skips for manual scans regardless of open rules", () => {
    assert.equal(
      shouldSkipFinding({ scanSource: "manual", ruleId: "slow-ttfb", openRuleIds }),
      false,
    );
  });

  it("never skips for manual scans with no open rules", () => {
    assert.equal(
      shouldSkipFinding({ scanSource: "manual", ruleId: "slow-ttfb", openRuleIds: new Set() }),
      false,
    );
  });

  it("skips scheduled scan when an open finding exists for that ruleId", () => {
    assert.equal(
      shouldSkipFinding({ scanSource: "scheduled", ruleId: "slow-ttfb", openRuleIds }),
      true,
    );
  });

  it("skips scheduled scan for second matching open rule", () => {
    assert.equal(
      shouldSkipFinding({ scanSource: "scheduled", ruleId: "slow-lcp", openRuleIds }),
      true,
    );
  });

  it("does NOT skip scheduled scan when ruleId has no open finding", () => {
    assert.equal(
      shouldSkipFinding({ scanSource: "scheduled", ruleId: "high-cls", openRuleIds }),
      false,
    );
  });

  it("does NOT skip scheduled scan when openRuleIds is empty", () => {
    assert.equal(
      shouldSkipFinding({ scanSource: "scheduled", ruleId: "slow-ttfb", openRuleIds: new Set() }),
      false,
    );
  });

  it("does NOT skip scheduled scan when ruleId is null", () => {
    assert.equal(
      shouldSkipFinding({ scanSource: "scheduled", ruleId: null, openRuleIds }),
      false,
    );
  });

  it("does NOT skip scheduled scan when ruleId is undefined", () => {
    assert.equal(
      shouldSkipFinding({ scanSource: "scheduled", ruleId: undefined, openRuleIds }),
      false,
    );
  });

  it("is case-sensitive: different case is NOT a match", () => {
    assert.equal(
      shouldSkipFinding({ scanSource: "scheduled", ruleId: "Slow-TTFB", openRuleIds }),
      false,
    );
  });
});

// ── interval constants ───────────────────────────────────────────────────────

describe("PERF_SCAN_INTERVAL_MS", () => {
  it("daily interval is exactly 24 hours in ms", () => {
    assert.equal(PERF_SCAN_INTERVAL_MS.daily, 24 * 60 * 60 * 1000);
  });

  it("weekly interval is exactly 7 days in ms", () => {
    assert.equal(PERF_SCAN_INTERVAL_MS.weekly, 7 * 24 * 60 * 60 * 1000);
  });

  it("daily interval is 1/7 of weekly interval", () => {
    assert.equal(PERF_SCAN_INTERVAL_MS.weekly / PERF_SCAN_INTERVAL_MS.daily, 7);
  });
});
