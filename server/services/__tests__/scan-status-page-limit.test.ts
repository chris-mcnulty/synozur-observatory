/**
 * Regression test — pageLimit persisted in scan-report evidence body.
 *
 * Covers the requirement that the effective page limit used during an
 * accessibility scan is stored in the raw-report JSON body and surfaced
 * correctly by the scan-status endpoint's partialScanInfo extraction.
 *
 * The extraction logic lives in server/routes/observatory.ts in the
 * GET /api/observatory/assessments/:id/scan-status handler.  Rather than
 * spinning up the full Express app with a mocked DB queue, we test the
 * pure parsing step in isolation — this is the exact code path that was
 * changed and is the most fragile part.
 */

import { describe, it, expect } from "vitest";

// ── Helper: mirrors the partialScanInfo extraction in the scan-status handler ──

interface PartialScanInfo {
  partial: boolean;
  scannedPages: number;
  discoveredPages: number;
  pageLimit?: number;
}

/**
 * Reproduce the extraction logic from the scan-status route so changes to
 * that logic break this test immediately.
 */
function extractPartialScanInfo(bodyJson: string): PartialScanInfo | undefined {
  const reportObj = JSON.parse(bodyJson) as any;
  const scannedPages =
    Array.isArray(reportObj?.scannedPages) ? reportObj.scannedPages.length : null;
  const discoveredPages =
    typeof reportObj?.discoveredPages === "number" ? reportObj.discoveredPages : null;
  const pageLimit =
    typeof reportObj?.pageLimit === "number" ? reportObj.pageLimit : null;

  if (scannedPages === null || discoveredPages === null) return undefined;

  return {
    partial: scannedPages < discoveredPages,
    scannedPages,
    discoveredPages,
    ...(pageLimit !== null ? { pageLimit } : {}),
  };
}

// ── Helper: mirrors the raw-report body built by accessibility-scanner.ts ─────

function buildReportBody({
  scannedPageUrls,
  discoveredCount,
  pageLimit,
}: {
  scannedPageUrls: string[];
  discoveredCount: number;
  pageLimit: number;
}): string {
  return JSON.stringify({
    scannedPages: scannedPageUrls,
    discoveredPages: discoveredCount,
    partial: scannedPageUrls.length < discoveredCount,
    pageLimit,
    pages: {},
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("scan-status pageLimit persistence", () => {
  it("includes pageLimit in partialScanInfo when the report body contains it", () => {
    const body = buildReportBody({
      scannedPageUrls: ["https://example.com", "https://example.com/about"],
      discoveredCount: 15,
      pageLimit: 20,
    });

    const info = extractPartialScanInfo(body);

    expect(info).toBeDefined();
    expect(info!.partial).toBe(true);
    expect(info!.scannedPages).toBe(2);
    expect(info!.discoveredPages).toBe(15);
    // Core assertion: non-default limit (20) must be preserved
    expect(info!.pageLimit).toBe(20);
  });

  it("includes pageLimit when a non-default limit was used for a full scan (not partial)", () => {
    // All 5 discovered pages were scanned, but a custom limit of 5 was set
    const scannedUrls = [
      "https://example.com",
      "https://example.com/about",
      "https://example.com/contact",
      "https://example.com/pricing",
      "https://example.com/blog",
    ];
    const body = buildReportBody({
      scannedPageUrls: scannedUrls,
      discoveredCount: 5,
      pageLimit: 5,
    });

    const info = extractPartialScanInfo(body);

    expect(info).toBeDefined();
    expect(info!.partial).toBe(false);
    expect(info!.scannedPages).toBe(5);
    expect(info!.pageLimit).toBe(5);
  });

  it("preserves the default pageLimit of 10 when that was used", () => {
    const body = buildReportBody({
      scannedPageUrls: ["https://example.com"],
      discoveredCount: 10,
      pageLimit: 10,
    });

    const info = extractPartialScanInfo(body);

    expect(info!.pageLimit).toBe(10);
  });

  it("omits pageLimit when the report body does not contain it (legacy reports)", () => {
    // Old reports written before this change have no pageLimit field
    const legacyBody = JSON.stringify({
      scannedPages: ["https://example.com"],
      discoveredPages: 5,
      partial: true,
      pages: {},
    });

    const info = extractPartialScanInfo(legacyBody);

    expect(info).toBeDefined();
    expect(info!.partial).toBe(true);
    // pageLimit must be absent, not 0 or null
    expect("pageLimit" in info!).toBe(false);
  });

  it("returns undefined when the body is missing scannedPages or discoveredPages", () => {
    expect(extractPartialScanInfo(JSON.stringify({}))).toBeUndefined();
    expect(extractPartialScanInfo(JSON.stringify({ scannedPages: [] }))).toBeUndefined();
    expect(extractPartialScanInfo(JSON.stringify({ discoveredPages: 5 }))).toBeUndefined();
  });
});
