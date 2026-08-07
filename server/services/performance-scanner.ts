/**
 * Observatory — Performance Scanner
 *
 * Provides two scan surfaces:
 *
 * 1. ScannerProvider (`performanceScanner`) — integrates with the unified
 *    Observatory scan runner (used by the automated /scan endpoint). Reuses
 *    the shared headless browser pool via getBrowserPage/releaseBrowserPage.
 *
 * 2. Standalone `runPerformanceScan()` — called directly by the performance
 *    workbench scan panel. Opens a dedicated browser instance so it can
 *    disable cache and inject observers without affecting shared pool pages.
 *
 * Metrics captured: TTFB, Load Time, LCP (ms), CLS (score), TTI (ms).
 */

import { getBrowserPage, releaseBrowserPage } from "./headless-crawler";
import type { ScannerProvider, ScanRequest, ScanResult, ScannerFinding } from "./observatory-scanners";
import puppeteer, { Browser, Page } from "puppeteer";
import * as fs from "fs";
import { assertScanUrlSafe, installSsrfRequestInterceptor } from "./ssrf-guard";
import { findChromiumPath } from "../utils/find-chromium";

// Default thresholds for the ScannerProvider (override via request.options.thresholds).
const DEFAULT_THRESHOLDS = {
  ttfbMs: 800,        // Time to First Byte
  fcp: 2500,          // First Contentful Paint (Core Web Vital)
  lcp: 4000,          // Largest Contentful Paint (Core Web Vital — needs improvement threshold)
  cls: 0.25,          // Cumulative Layout Shift (needs improvement — float, not ms)
  domReadyMs: 3000,   // DOMContentLoaded
  loadMs: 5000,       // window.onload
};

interface PerfTiming {
  ttfbMs: number;
  domReadyMs: number;
  loadMs: number;
  fcp: number | null;
  lcp: number | null;
  cls: number | null;
  transferSizeKb: number;
  resourceCount: number;
}

/**
 * Rule IDs produced by the standalone /performance-scan route (buildPerfFindings).
 * The dedicated route's reconcile must only auto-resolve findings in this namespace.
 */
export const PERF_SLA_RULE_IDS = [
  "ttfb_sla_breach",
  "load_time_sla_breach",
  "lcp_sla_breach",
  "cls_sla_breach",
  "tti_sla_breach",
] as const;

/**
 * Rule IDs produced by the ScannerProvider path (performanceScanner.runScan,
 * called via the general /scan route through runObservatoryScan).
 * The scan-runner's reconcile must only auto-resolve findings in this namespace.
 * Declared before performanceScanner to avoid TDZ (temporal dead zone) errors.
 */
export const PERF_PROVIDER_RULE_IDS = [
  "slow-ttfb",
  "slow-fcp",
  "slow-lcp",
  "high-cls",
  "slow-load",
] as const;

export const performanceScanner: ScannerProvider = {
  key: "observatory_performance",
  name: "Observatory Performance Scanner (built-in)",
  assessmentTypes: ["performance"],
  // Declare the namespace of rule IDs this provider can produce so the scan
  // runner's auto-resolve never touches findings from the dedicated /performance-scan
  // SLA route (which uses a completely different rule-ID set).
  ownedRuleIds: PERF_PROVIDER_RULE_IDS,

  async isAvailable(): Promise<boolean> {
    return true;
  },

  async runScan(request: ScanRequest): Promise<ScanResult> {
    const startedAt = new Date();
    const targetUrl = request.target.url;
    if (!targetUrl) throw new Error("performance scan requires a target URL");

    const thresholds = { ...DEFAULT_THRESHOLDS, ...(request.options?.thresholds as Partial<typeof DEFAULT_THRESHOLDS> ?? {}) };
    const findings: ScannerFinding[] = [];

    let page: Awaited<ReturnType<typeof getBrowserPage>> | null = null;
    let timing: PerfTiming | null = null;

    // SSRF guard — validate before any browser navigation.
    await assertScanUrlSafe(targetUrl);

    try {
      console.log(`[PerformanceScanner] Scanning ${targetUrl}`);
      page = await getBrowserPage();

      // Block redirect-to-private attacks at browser network time.
      await page.setRequestInterception(true);
      installSsrfRequestInterceptor(page);

      // Disable cache for accurate measurement
      await page.setCacheEnabled(false);

      // Enable performance metrics
      await (page as any)._client().send("Performance.enable").catch(() => {});

      const lcpValues: number[] = [];
      const clsValues: number[] = [];

      // Observe LCP and CLS via PerformanceObserver injected before navigation
      await page.evaluateOnNewDocument(() => {
        (window as any).__obs_lcp = [];
        (window as any).__obs_cls = 0;

        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              (window as any).__obs_lcp.push(entry.startTime);
            }
          }).observe({ type: "largest-contentful-paint", buffered: true });
        } catch {}

        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as any[]) {
              if (!entry.hadRecentInput) (window as any).__obs_cls += entry.value;
            }
          }).observe({ type: "layout-shift", buffered: true });
        } catch {}
      });

      await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 40000 });

      // Wait a moment for LCP/CLS to settle
      await new Promise(r => setTimeout(r, 2000));

      timing = await page.evaluate((): PerfTiming => {
        const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
        const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];

        const paintEntries = performance.getEntriesByType("paint");
        const fcpEntry = paintEntries.find(e => e.name === "first-contentful-paint");

        const lcpArr = (window as any).__obs_lcp as number[];
        const clsVal = (window as any).__obs_cls as number;

        return {
          ttfbMs: Math.round(nav.responseStart - nav.requestStart),
          domReadyMs: Math.round(nav.domContentLoadedEventEnd - nav.fetchStart),
          loadMs: Math.round(nav.loadEventEnd - nav.fetchStart),
          fcp: fcpEntry ? Math.round(fcpEntry.startTime) : null,
          lcp: lcpArr.length > 0 ? Math.round(Math.max(...lcpArr)) : null,
          cls: typeof clsVal === "number" ? Math.round(clsVal * 1000) / 1000 : null,
          transferSizeKb: Math.round(resources.reduce((sum, r) => sum + (r.transferSize || 0), 0) / 1024),
          resourceCount: resources.length,
        };
      });

      console.log(`[PerformanceScanner] ${targetUrl} — TTFB:${timing.ttfbMs}ms Load:${timing.loadMs}ms FCP:${timing.fcp}ms LCP:${timing.lcp}ms CLS:${timing.cls}`);

      // ── Flag threshold breaches as findings ────────────────────────────

      if (timing.ttfbMs > thresholds.ttfbMs) {
        findings.push({
          ruleId: "slow-ttfb",
          title: `Slow time to first byte (${timing.ttfbMs}ms, threshold: ${thresholds.ttfbMs}ms)`,
          description: `The server took ${timing.ttfbMs}ms to begin returning a response. This suggests slow server-side processing, database queries, or network latency. Target: under ${thresholds.ttfbMs}ms.`,
          severity: timing.ttfbMs > thresholds.ttfbMs * 2 ? "High" : "Medium",
          location: { url: targetUrl },
          raw: { measured: timing.ttfbMs, threshold: thresholds.ttfbMs },
        });
      }

      if (timing.fcp !== null && timing.fcp > thresholds.fcp) {
        findings.push({
          ruleId: "slow-fcp",
          title: `First Contentful Paint too slow (${timing.fcp}ms, threshold: ${thresholds.fcp}ms)`,
          description: `FCP measures how long until the first text or image is visible. ${timing.fcp}ms exceeds the ${thresholds.fcp}ms threshold. Common causes: render-blocking CSS/JS, large HTML, slow server response.`,
          severity: timing.fcp > 4000 ? "High" : "Medium",
          location: { url: targetUrl },
          raw: { measured: timing.fcp, threshold: thresholds.fcp },
        });
      }

      if (timing.lcp !== null && timing.lcp > thresholds.lcp) {
        findings.push({
          ruleId: "slow-lcp",
          title: `Largest Contentful Paint too slow (${timing.lcp}ms, threshold: ${thresholds.lcp}ms)`,
          description: `LCP measures when the largest visible element is rendered. ${timing.lcp}ms indicates poor perceived load performance. Target: under 2,500ms (good), under 4,000ms (needs improvement).`,
          severity: timing.lcp > 6000 ? "High" : "Medium",
          location: { url: targetUrl },
          raw: { measured: timing.lcp, threshold: thresholds.lcp },
        });
      }

      if (timing.cls !== null && timing.cls > thresholds.cls) {
        findings.push({
          ruleId: "high-cls",
          title: `Cumulative Layout Shift too high (CLS: ${timing.cls}, threshold: ${thresholds.cls})`,
          description: `CLS measures visual stability — how much page content shifts unexpectedly during load. A score of ${timing.cls} indicates elements are moving significantly. Target: under 0.1 (good), under 0.25 (needs improvement).`,
          severity: timing.cls > 0.5 ? "High" : "Medium",
          location: { url: targetUrl },
          raw: { measured: timing.cls, threshold: thresholds.cls },
        });
      }

      if (timing.loadMs > thresholds.loadMs) {
        findings.push({
          ruleId: "slow-load",
          title: `Page load time exceeds SLA (${timing.loadMs}ms, threshold: ${thresholds.loadMs}ms)`,
          description: `Total page load time is ${timing.loadMs}ms across ${timing.resourceCount} resources (${timing.transferSizeKb}KB transferred). This exceeds the ${thresholds.loadMs}ms SLA threshold.`,
          severity: timing.loadMs > thresholds.loadMs * 2 ? "High" : "Medium",
          location: { url: targetUrl },
          raw: { measured: timing.loadMs, threshold: thresholds.loadMs, resourceCount: timing.resourceCount, transferSizeKb: timing.transferSizeKb },
        });
      }

    } finally {
      if (page) releaseBrowserPage(page);
    }

    const rawReport = { url: targetUrl, timing, thresholds, findings: findings.length };

    return {
      findings,
      rawReport: {
        contentType: "application/json",
        body: JSON.stringify(rawReport, null, 2),
      },
      tool: "observatory-performance-scanner@1.0",
      startedAt,
      finishedAt: new Date(),
    };
  },
};

export interface PerfSlaConfig {
  ttfbMs: number;
  loadTimeMs: number;
  lcpMs: number;
  clsScore: number;
  ttiMs: number;
}

export interface PagePerfMetrics {
  ttfbMs: number | null;
  loadTimeMs: number | null;
  lcpMs: number | null;
  clsScore: number | null;
  ttiMs: number | null;
  /** ISO timestamp when the measurement started. */
  scannedAt: string;
  /** Final URL after any redirects. */
  finalUrl: string;
  /** Any non-fatal warnings encountered during measurement. */
  warnings: string[];
}

function severityFromRatio(ratio: number): string {
  if (ratio >= 4) return "Critical";
  if (ratio >= 2) return "High";
  return "Medium";
}

export async function measurePagePerformance(
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<PagePerfMetrics> {
  const { timeoutMs = 45_000 } = options;
  const scannedAt = new Date().toISOString();
  const warnings: string[] = [];

  const executablePath = await findChromiumPath();
  const browser: Browser = await puppeteer.launch({
    headless: true,
    executablePath,
    timeout: 120000,
    protocolTimeout: 120000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
      // --single-process removed: causes CDP protocol hangs in production
      "--no-zygote",
      "--window-size=1920,1080",
      "--js-flags=--max-old-space-size=256",
    ],
  });

  let page: Page | null = null;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultNavigationTimeout(timeoutMs);
    page.setDefaultTimeout(timeoutMs);

    // Block redirect-to-private attacks at browser network time.
    await page.setRequestInterception(true);
    installSsrfRequestInterceptor(page);

    // Inject PerformanceObserver shim before navigation to collect LCP + CLS.
    await page.evaluateOnNewDocument(() => {
      (window as any).__perfData = {
        lcp: null as number | null,
        cls: 0,
        longTasks: [] as number[],
      };

      try {
        const lcpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          if (last) (window as any).__perfData.lcp = last.startTime;
        });
        lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
      } catch {
        // LCP not supported in this browser version
      }

      try {
        const clsObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const e = entry as any;
            if (!e.hadRecentInput) {
              (window as any).__perfData.cls += e.value;
            }
          }
        });
        clsObserver.observe({ type: "layout-shift", buffered: true });
      } catch {
        // CLS not supported
      }

      try {
        const ttiObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            (window as any).__perfData.longTasks.push(entry.startTime + entry.duration);
          }
        });
        ttiObserver.observe({ type: "longtask", buffered: true });
      } catch {
        // Long Tasks API not supported
      }
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: timeoutMs });

    // Allow a short settle period so deferred content and observers flush.
    await new Promise<void>((r) => setTimeout(r, 1500));

    const finalUrl = page.url();

    const metrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const perfData = (window as any).__perfData as {
        lcp: number | null;
        cls: number;
        longTasks: number[];
      };

      const ttfbMs = nav ? Math.round(nav.responseStart - nav.startTime) : null;
      const loadTimeMs = nav ? Math.round(nav.loadEventEnd - nav.startTime) : null;
      const lcpMs = perfData.lcp !== null ? Math.round(perfData.lcp) : null;
      const clsScore = perfData.cls;

      // TTI approximation: last long-task end + 5 s quiet window heuristic.
      // If no long tasks observed, use DOM interactive.
      let ttiMs: number | null = null;
      if (perfData.longTasks.length > 0) {
        ttiMs = Math.round(Math.max(...perfData.longTasks));
      } else if (nav) {
        ttiMs = Math.round(nav.domInteractive - nav.startTime);
      }

      return { ttfbMs, loadTimeMs, lcpMs, clsScore, ttiMs };
    });

    // Warn about any zero/negative values that indicate a measurement failure.
    if (metrics.ttfbMs !== null && metrics.ttfbMs < 0) {
      warnings.push("TTFB measurement returned a negative value; the metric may be unreliable.");
      metrics.ttfbMs = null;
    }

    return {
      ...metrics,
      clsScore: metrics.clsScore > 0 ? Math.round(metrics.clsScore * 10000) / 10000 : 0,
      scannedAt,
      finalUrl,
      warnings,
    };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {}
    }
    try {
      await browser.close();
    } catch {}
  }
}

// findChromiumPath is provided by the shared utility; imported at the top of the file.

export async function runPerformanceScan(
  url: string,
  sla: PerfSlaConfig,
  options: { timeoutMs?: number } = {},
): Promise<PerfScanResult> {
  const metrics = await measurePagePerformance(url, options);
  const findings = buildPerfFindings(metrics, sla, url);
  return { metrics, findings };
}

export const DEFAULT_PERF_SLA: PerfSlaConfig = {
  ttfbMs: 800,
  loadTimeMs: 3000,
  lcpMs: 2500,
  clsScore: 0.1,
  ttiMs: 3800,
};

export function buildPerfFindings(
  metrics: PagePerfMetrics,
  sla: PerfSlaConfig,
  url: string,
): PerfScannerFinding[] {
  const findings: PerfScannerFinding[] = [];

  const check = (
    ruleId: string,
    label: string,
    value: number | null,
    threshold: number,
    unit: string,
    format: (v: number) => string,
    recommendation: string,
  ) => {
    if (value === null) return; // metric not captured — skip
    if (value <= threshold) return; // within SLA — no finding
    const ratio = value / threshold;
    const severity = severityFromRatio(ratio);
    const measured = format(value);
    const thresholdStr = format(threshold);
    findings.push({
      ruleId,
      title: `${label} SLA breach on ${new URL(url).pathname || "/"}`,
      description: `${label} was measured at ${measured}, exceeding the configured SLA threshold of ${thresholdStr}. The ratio of measured to threshold is ${ratio.toFixed(1)}×.`,
      recommendation,
      severity,
      measured,
      threshold: thresholdStr,
    });
  };

  check(
    "ttfb_sla_breach",
    "Time to First Byte (TTFB)",
    metrics.ttfbMs,
    sla.ttfbMs,
    "ms",
    fmtMs,
    "Reduce server response time: optimise database queries, add caching (CDN, Redis), or move compute closer to users with edge functions.",
  );

  check(
    "load_time_sla_breach",
    "Page Load Time",
    metrics.loadTimeMs,
    sla.loadTimeMs,
    "ms",
    fmtMs,
    "Defer non-critical scripts, lazy-load images, reduce render-blocking resources, and enable HTTP/2 or HTTP/3.",
  );

  check(
    "lcp_sla_breach",
    "Largest Contentful Paint (LCP)",
    metrics.lcpMs,
    sla.lcpMs,
    "ms",
    fmtMs,
    "Preload the LCP resource, serve images in next-gen formats (WebP/AVIF), and ensure the origin responds quickly (see TTFB finding).",
  );

  if (metrics.clsScore !== null && metrics.clsScore > sla.clsScore) {
    const ratio = metrics.clsScore / sla.clsScore;
    const severity = severityFromRatio(ratio);
    findings.push({
      ruleId: "cls_sla_breach",
      title: `Cumulative Layout Shift (CLS) SLA breach on ${new URL(url).pathname || "/"}`,
      description: `CLS score was ${metrics.clsScore.toFixed(4)}, exceeding the SLA threshold of ${sla.clsScore}. Layout instability can cause users to click the wrong elements.`,
      recommendation:
        "Set explicit width/height on images and video, avoid inserting content above existing content, and use CSS transform for animations instead of layout-triggering properties.",
      severity,
      measured: metrics.clsScore.toFixed(4),
      threshold: String(sla.clsScore),
    });
  }

  check(
    "tti_sla_breach",
    "Time to Interactive (TTI)",
    metrics.ttiMs,
    sla.ttiMs,
    "ms",
    fmtMs,
    "Reduce main-thread JavaScript work: code-split large bundles, remove unused polyfills, defer third-party scripts, and minimise long tasks (>50 ms).",
  );

  return findings;
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

export interface PerfScanResult {
  metrics: PagePerfMetrics;
  findings: PerfScannerFinding[];
}

export interface PerfScannerFinding {
  /** Stable key identifying which metric breached, e.g. "lcp_sla_breach". */
  ruleId: string;
  title: string;
  description: string;
  recommendation: string;
  /** Observatory severity: Critical | High | Medium | Low | Informational */
  severity: string;
  /** Measured value (formatted for display, e.g. "3 200 ms"). */
  measured: string;
  /** Threshold value (formatted for display). */
  threshold: string;
}

