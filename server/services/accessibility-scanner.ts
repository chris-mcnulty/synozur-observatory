/**
 * Accessibility Scanner — implements the ScannerProvider contract using
 * axe-core injected into a headless Puppeteer page.
 *
 * Scan flow:
 *  1. Discover pages via sitemap.xml / nav-link extraction (up to pageLimit).
 *  2. Scan each discovered page independently with axe-core.
 *  3. Map each violation → ScannerFinding (severity, WCAG criterion, selector)
 *     with location.url = the page where the violation was found.
 *  4. Return a flat ScannerFinding[] across all pages; the scan runner
 *     deduplicates by scanRuleId|selector and accumulates source_pages.
 *  5. Raw per-page axe reports are stored as one combined obs_evidence row.
 */

import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { runInPage } from "./headless-crawler";

// CJS/ESM-compatible require — the production build outputs CJS where import.meta.url
// is undefined, so prefer __filename (always defined in CJS) and fall back to import.meta.url
// only when running as ESM (e.g. tsx in development).
declare const __filename: string | undefined;
const _require = createRequire(
  typeof __filename !== "undefined" ? __filename : import.meta.url
);
import { validateUrlWithDnsCheck } from "../utils/url-validator";
import type { ScannerProvider, ScanRequest, ScanResult, ScannerFinding } from "./observatory-scanners";

// ── axe-core source (loaded once at module init) ────────────────────────────

let _axeSource: string | null = null;

function getAxeSource(): string {
  if (_axeSource) return _axeSource;
  try {
    const axePath = _require.resolve("axe-core");
    _axeSource = fs.readFileSync(axePath, "utf8");
    console.log("[AccessibilityScanner] axe-core loaded from:", axePath);
    return _axeSource;
  } catch (err) {
    throw new Error(`axe-core not found. Run: npm install axe-core\n${err}`);
  }
}

function getAxeVersion(): string {
  try {
    return (_require("axe-core/package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}

// ── axe severity → Observatory severity ─────────────────────────────────────

function mapImpact(impact: string | null | undefined): string {
  switch (impact) {
    case "critical": return "Critical";
    case "serious":  return "High";
    case "moderate": return "Medium";
    case "minor":    return "Low";
    default:         return "Informational";
  }
}

// ── WCAG tag parsing ─────────────────────────────────────────────────────────

/** Parse WCAG criterion from axe tags: "wcag143" → "1.4.3", "wcag21" → "2.1" */
function extractWcagCriterion(tags: string[]): string | undefined {
  for (const tag of tags) {
    const m = tag.match(/^wcag(\d)(\d)(\d+)$/);
    if (m) return `${m[1]}.${m[2]}.${m[3]}`;
    const m2 = tag.match(/^wcag(\d)(\d+)$/);
    if (m2) return `${m2[1]}.${m2[2]}`;
  }
  return undefined;
}

function extractWcagLevel(tags: string[]): "A" | "AA" | "AAA" {
  if (tags.some((t) => t.includes("aaa"))) return "AAA";
  if (tags.some((t) => t.includes("aa"))) return "AA";
  return "A";
}

// ── axe rule ID → Observatory accessibility category ─────────────────────────

const RULE_CATEGORY_MAP: Record<string, string> = {
  // Images
  "image-alt": "Images",
  "image-redundant-alt": "Images",
  "role-img-alt": "Images",
  "svg-img-alt": "Images",
  "input-image-alt": "Images",
  "area-alt": "Images",
  "object-alt": "Images",
  // Forms
  "label": "Forms",
  "label-content-name-mismatch": "Forms",
  "select-name": "Forms",
  "form-field-multiple-labels": "Forms",
  "autocomplete-valid": "Forms",
  // Keyboard
  "accesskeys": "Keyboard",
  "keyboard-focusable-scrollable": "Keyboard",
  "scrollable-region-focusable": "Keyboard",
  // Focus
  "focus-trap": "Focus",
  "focus-order-semantics": "Focus",
  "bypass": "Focus",
  "tabindex": "Focus",
  // Color Contrast
  "color-contrast": "Color Contrast",
  "color-contrast-enhanced": "Color Contrast",
  // Screen Reader
  "button-name": "Screen Reader",
  "frame-title": "Screen Reader",
  "frame-tested": "Screen Reader",
  "frame-focusable-content": "Screen Reader",
  "link-name": "Screen Reader",
  "link-in-text-block": "Screen Reader",
  "video-caption": "Screen Reader",
  "audio-caption": "Screen Reader",
  // Zoom
  "meta-viewport": "Zoom Testing",
  // Tables
  "td-headers-attr": "Tables",
  "th-has-data-cells": "Tables",
  "table-dup-name": "Tables",
  "table-fake-caption": "Tables",
  "scope-attr-valid": "Tables",
  // Semantic Structure
  "document-title": "Semantic Structure",
  "html-has-lang": "Semantic Structure",
  "html-lang-valid": "Semantic Structure",
  "html-xml-lang-mismatch": "Semantic Structure",
  "heading-order": "Semantic Structure",
  "landmark-banner-is-top-level": "Semantic Structure",
  "landmark-complementary-is-top-level": "Semantic Structure",
  "landmark-contentinfo-is-top-level": "Semantic Structure",
  "landmark-main-is-top-level": "Semantic Structure",
  "landmark-no-duplicate-banner": "Semantic Structure",
  "landmark-no-duplicate-contentinfo": "Semantic Structure",
  "landmark-no-duplicate-main": "Semantic Structure",
  "landmark-one-main": "Semantic Structure",
  "landmark-unique": "Semantic Structure",
  "page-has-heading-one": "Semantic Structure",
  "region": "Semantic Structure",
  "list": "Semantic Structure",
  "listitem": "Semantic Structure",
  "definition-list": "Semantic Structure",
  "dlitem": "Semantic Structure",
  // Error Handling
  "aria-live-region-valid": "Error Handling",
};

function ruleToCategory(ruleId: string): string {
  if (RULE_CATEGORY_MAP[ruleId]) return RULE_CATEGORY_MAP[ruleId];
  if (ruleId.startsWith("aria-")) return "ARIA";
  if (ruleId.includes("color")) return "Color Contrast";
  if (ruleId.includes("image") || ruleId.includes("img")) return "Images";
  if (ruleId.includes("label") || ruleId.includes("form")) return "Forms";
  if (ruleId.includes("table") || ruleId.includes("td-") || ruleId.includes("th-")) return "Tables";
  if (ruleId.includes("lang") || ruleId.includes("heading") || ruleId.includes("landmark") || ruleId.includes("region")) return "Semantic Structure";
  return "Screen Reader";
}

// ── SSRF-safe URL validation ─────────────────────────────────────────────────

/**
 * Validate that a URL is safe to scan: must be http/https and must not resolve
 * to a private/internal IP address. Throws if validation fails.
 */
export async function validateScanTarget(url: string): Promise<string> {
  const result = await validateUrlWithDnsCheck(url);
  if (!result.isValid) {
    throw new Error(`Scan target URL is not safe to scan: ${result.error ?? "invalid URL"}`);
  }
  return result.normalizedUrl ?? url;
}

// ── SSRF-safe HTTP fetcher ───────────────────────────────────────────────────

const SITEMAP_TIMEOUT_MS = 8_000;
const MAX_REDIRECT_HOPS  = 5;

/**
 * Fetch the text body of a URL with full SSRF protection:
 *  - DNS/IP-validates the URL before connecting (blocks private ranges).
 *  - Uses `redirect: "manual"` so every Location header is validated before
 *    following; each hop counts toward MAX_REDIRECT_HOPS.
 *  - Relative redirect URLs are resolved against the current URL.
 * Returns the response text on 2xx, or null on any SSRF block, error, or
 * non-2xx response.
 */
export async function safeFetchText(
  url: string,
  signal?: AbortSignal,
): Promise<string | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    // SSRF guard: validate URL (format + DNS → private-IP check) before connecting.
    const check = await validateUrlWithDnsCheck(current);
    if (!check.isValid) {
      console.log(`[AccessibilityScanner] sitemap URL blocked (SSRF): ${current} — ${check.error}`);
      return null;
    }
    current = check.normalizedUrl ?? current;

    // Per-request timeout, combined with any caller cancellation signal.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SITEMAP_TIMEOUT_MS);
    if (signal?.aborted) {
      clearTimeout(timer);
      ctrl.abort();
    } else {
      signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
    }

    let resp: Response;
    try {
      resp = await fetch(current, {
        signal: ctrl.signal,
        redirect: "manual",   // follow redirects manually so we can SSRF-check each Location
        headers: { "User-Agent": "Observatory-AccessibilityScanner/1.0" },
      });
    } catch (err: any) {
      clearTimeout(timer);
      if (!err?.message?.includes("aborted")) {
        console.log(`[AccessibilityScanner] sitemap fetch error for ${current}: ${err?.message ?? err}`);
      }
      return null;
    }
    clearTimeout(timer);

    if (resp.status >= 300 && resp.status < 400) {
      if (hop === MAX_REDIRECT_HOPS) {
        console.log(`[AccessibilityScanner] sitemap redirect limit (${MAX_REDIRECT_HOPS}) reached for ${url}`);
        return null;
      }
      const location = resp.headers.get("location");
      if (!location) {
        console.log(`[AccessibilityScanner] redirect with no Location header from ${current}`);
        return null;
      }
      try {
        current = new URL(location, current).toString();
      } catch {
        console.log(`[AccessibilityScanner] invalid redirect Location: ${location}`);
        return null;
      }
      continue; // validate + fetch the redirect target
    }

    if (!resp.ok) return null; // 4xx / 5xx — not a scanner error, just no sitemap
    return resp.text();
  }
  return null; // exhausted hops
}

// ── Sitemap XML parsing ──────────────────────────────────────────────────────

/**
 * Extract same-origin page URLs from a regular urlset sitemap XML body.
 * Skips binary/asset extensions and meta-paths.
 */
export function extractLocUrls(
  xml: string,
  cap: number,
  isPageUrl: (url: string) => boolean,
): string[] {
  const pages: string[] = [];
  const locRe = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = locRe.exec(xml)) !== null && pages.length < cap) {
    const normalized = normalizePageUrl(m[1].trim());
    if (normalized && isPageUrl(normalized)) pages.push(normalized);
  }
  return pages;
}

/**
 * Parse page URLs from a sitemap XML string, handling both formats:
 *  - `<urlset>` — a regular sitemap; `<loc>` entries are page URLs.
 *  - `<sitemapindex>` — an index sitemap; `<loc>` entries inside `<sitemap>`
 *    wrappers are child sitemap URLs. Each child is fetched once (SSRF-safe,
 *    no further recursion) and its page `<loc>` entries collected.
 *
 * The page cap is applied across the combined result.
 */
export async function parseSitemapPageUrls(
  xml: string,
  cap: number,
  isPageUrl: (url: string) => boolean,
  signal?: AbortSignal,
): Promise<string[]> {
  const pages: string[] = [];

  if (/<sitemapindex[\s>]/i.test(xml)) {
    // Sitemap index: collect child sitemap URLs from <sitemap><loc>…</loc></sitemap>
    const childRe = /<sitemap[\s>][\s\S]*?<\/sitemap>/gi;
    const childUrls: string[] = [];
    let cm: RegExpExecArray | null;
    while ((cm = childRe.exec(xml)) !== null) {
      const locM = /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(cm[0]);
      if (locM) childUrls.push(locM[1].trim());
    }

    for (const childUrl of childUrls) {
      if (pages.length >= cap || signal?.aborted) break;
      // SSRF-validate each child sitemap URL before fetching
      const childText = await safeFetchText(childUrl, signal);
      if (!childText) continue;
      // Parse child as a plain urlset (one level of recursion only)
      pages.push(...extractLocUrls(childText, cap - pages.length, isPageUrl));
    }
  } else {
    // Regular urlset
    pages.push(...extractLocUrls(xml, cap, isPageUrl));
  }

  return pages;
}

// ── Page discovery ───────────────────────────────────────────────────────────

/**
 * Discover pages to scan for a given base URL.
 *
 * Strategy (in order):
 *  1. Fetch <baseOrigin>/sitemap.xml via safeFetchText (SSRF-safe, redirect-
 *     validated). Parse <loc> entries with one level of sitemap-index recursion.
 *  2. If sitemap yields fewer than `cap` pages, use `runInPage` on `baseUrl`
 *     to extract <a href> links from nav/header landmarks (fallback: all links).
 *  3. Always includes `baseUrl` itself.
 *  4. Silent fallback: if both methods fail, returns [baseUrl].
 *
 * The baseUrl has already been SSRF-validated by the caller.
 */
export async function discoverAccessibilityPages(
  baseUrl: string,
  cap: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const baseOrigin = new URL(baseUrl).origin;
  const pages = new Set<string>([normalizePageUrl(baseUrl)]);

  /** True if a URL should be included as a page to scan. */
  function isPageUrl(url: string): boolean {
    try {
      const u = new URL(url);
      if (u.origin !== baseOrigin) return false;
      const p = u.pathname.toLowerCase();
      if (/\.(pdf|png|jpg|jpeg|gif|webp|svg|ico|css|js|json|xml|zip|tar|gz|mp4|mp3|ogg|woff|woff2|ttf|eot)(\?|$)/i.test(p)) return false;
      if (/^\/(sitemap|robots|favicon)/i.test(p)) return false;
      return true;
    } catch {
      return false;
    }
  }

  // ── 1. Sitemap (SSRF-safe) ────────────────────────────────────────────────
  try {
    const sitemapUrl = `${baseOrigin}/sitemap.xml`;
    const sitemapText = await safeFetchText(sitemapUrl, signal);

    if (sitemapText) {
      const discovered = await parseSitemapPageUrls(
        sitemapText, cap - pages.size, isPageUrl, signal,
      );
      for (const p of discovered) {
        if (pages.size >= cap) break;
        pages.add(p);
      }
      console.log(`[AccessibilityScanner] Sitemap yielded ${pages.size} page(s) from ${sitemapUrl}`);
    }
  } catch (err: any) {
    if (!err?.message?.includes("aborted")) {
      console.log(`[AccessibilityScanner] Sitemap fetch failed (${err?.message ?? err}), will try nav-link extraction`);
    }
  }

  // ── 2. Nav-link fallback ──────────────────────────────────────────────────
  if (pages.size < cap && !signal?.aborted) {
    try {
      const navLinks = await runInPage(
        baseUrl,
        async (page) => {
          return await (page as any).evaluate((): string[] => {
            const hrefs: string[] = [];
            // Try navigation / header landmarks first
            const navEls = document.querySelectorAll('nav, header, [role="navigation"]');
            for (const nav of navEls) {
              for (const a of nav.querySelectorAll("a[href]")) {
                const href = (a as HTMLAnchorElement).href;
                if (href) hrefs.push(href);
              }
            }
            // Fallback: all links on the page
            if (hrefs.length === 0) {
              for (const a of document.querySelectorAll("a[href]")) {
                const href = (a as HTMLAnchorElement).href;
                if (href) hrefs.push(href);
              }
            }
            return [...new Set(hrefs)];
          });
        },
        { waitTime: 1000, timeout: 20000, ssrfProtect: true, waitUntil: "domcontentloaded", signal },
      );

      for (const link of navLinks ?? []) {
        if (pages.size >= cap) break;
        const normalized = normalizePageUrl(link);
        if (normalized && isPageUrl(normalized)) {
          pages.add(normalized);
        }
      }
      console.log(`[AccessibilityScanner] After nav-link extraction: ${pages.size} page(s) discovered`);
    } catch (err: any) {
      console.warn(`[AccessibilityScanner] Nav-link extraction failed: ${err?.message ?? err}`);
    }
  }

  return [...pages].slice(0, cap);
}

/** Normalize a URL: strip fragment, trailing slash from non-root paths. */
function normalizePageUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    // Canonicalize: keep trailing slash only on root
    if (u.pathname !== "/" && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return "";
  }
}

// ── ScannerProvider implementation ───────────────────────────────────────────

export const axeCoreScanner: ScannerProvider = {
  key: "axe_core",
  name: "axe-core (built-in, WCAG 2.1/2.2)",
  assessmentTypes: ["accessibility"],

  async isAvailable(): Promise<boolean> {
    try {
      getAxeSource();
      return true;
    } catch {
      return false;
    }
  },

  async runScan(request: ScanRequest): Promise<ScanResult> {
    const rawUrl = request.target.url;
    if (!rawUrl) throw new Error("accessibility scan requires a target URL");

    // SSRF guard: validate scheme and DNS resolution before passing to headless browser
    const targetUrl = await validateScanTarget(rawUrl);

    const pageLimit = Math.min(
      Math.max(1, Number((request.options as any)?.pageLimit ?? 10)),
      25,
    );

    // Time-budget guard — the job queue kills the job at 300s regardless.
    // Reserve 60s for result saving; stop queuing new pages when the remaining
    // budget is less than one full per-page allowance (50s) so we always return
    // partial results rather than dying mid-scan with nothing.
    const JOB_BUDGET_MS = 5 * 60 * 1000; // must match enqueueScan default
    const BUDGET_RESERVE_MS = 60_000;     // reserved for evidence/findings save
    const PER_PAGE_BUDGET_MS = 50_000;    // per-page timeout + axe runtime
    const scanStartedAt = Date.now();
    const budgetExhausted = () =>
      Date.now() - scanStartedAt > JOB_BUDGET_MS - BUDGET_RESERVE_MS - PER_PAGE_BUDGET_MS;

    const startedAt = new Date();
    const axeSource = getAxeSource();
    const allFindings: (ScannerFinding & { _category: string })[] = [];
    const pageReports: Record<string, unknown> = {};

    // ── Page discovery ──────────────────────────────────────────────────────
    console.log(`[AccessibilityScanner] Discovering pages for ${targetUrl} (cap: ${pageLimit})`);
    const pages = await discoverAccessibilityPages(targetUrl, pageLimit, request.signal);
    console.log(`[AccessibilityScanner] Will scan ${pages.length} page(s): ${pages.slice(0, 5).join(", ")}${pages.length > 5 ? ` … (+${pages.length - 5} more)` : ""}`);

    // ── Per-page scan loop ──────────────────────────────────────────────────
    for (const pageUrl of pages) {
      if (request.signal?.aborted) break;

      if (budgetExhausted()) {
        console.warn(`[AccessibilityScanner] Time budget exhausted — stopping after ${Object.keys(pageReports).length} page(s); ${pages.length - Object.keys(pageReports).length} page(s) skipped`);
        break;
      }

      console.log(`[AccessibilityScanner] Scanning ${pageUrl} (elapsed ${Math.round((Date.now() - scanStartedAt) / 1000)}s)`);

      const scanResult = await runInPage(
        pageUrl,
        async (page) => {
          await page.evaluate(axeSource);
          return await (page as any).evaluate(async () => {
            return await (window as any).axe.run(document, {
              runOnly: {
                type: "tag",
                values: ["wcag2a", "wcag2aa", "wcag2aaa", "wcag21a", "wcag21aa", "wcag21aaa", "wcag22aa", "best-practice"],
              },
              resultTypes: ["violations", "incomplete"],
            });
          });
        },
        { waitTime: 500, timeout: 40000, ssrfProtect: true, waitUntil: "domcontentloaded", signal: request.signal },
      );

      if (!scanResult) {
        console.warn(`[AccessibilityScanner] Could not load ${pageUrl} — emitting target-unreachable`);
        allFindings.push({
          ruleId: "target-unreachable",
          title: "Page could not be loaded",
          description: `The scanner could not load ${pageUrl}. This may be a transient network error or the page may require authentication.`,
          severity: "Informational",
          location: { url: pageUrl },
          raw: {},
          _category: "Screen Reader",
        });
        continue;
      }

      pageReports[pageUrl] = scanResult;
      const axeAny = scanResult as any;

      // Map violations → findings
      for (const violation of (axeAny.violations ?? [])) {
        const firstNode = violation.nodes?.[0];
        const selector = firstNode?.target?.join(", ") ?? "";
        const htmlSnippet = firstNode?.html ?? "";
        const nodeCount = violation.nodes?.length ?? 0;
        const level = extractWcagLevel(violation.tags ?? []);
        const criterion = extractWcagCriterion(violation.tags ?? []);
        const category = ruleToCategory(violation.id);

        const description = [
          violation.description,
          htmlSnippet ? `\n\nFirst affected element:\n\`${htmlSnippet}\`` : "",
          nodeCount > 1 ? `\n\n${nodeCount} elements affected on this page.` : "",
          firstNode?.failureSummary ? `\n\n${firstNode.failureSummary}` : "",
        ].filter(Boolean).join("");

        allFindings.push({
          ruleId: violation.id,
          title: `[${level}] ${violation.help}`,
          description,
          severity: mapImpact(violation.impact),
          wcagCriterion: criterion ? `WCAG ${criterion} (Level ${level})` : undefined,
          location: { url: pageUrl, selector },
          raw: { helpUrl: violation.helpUrl, tags: violation.tags, nodeHtml: htmlSnippet },
          _category: category,
        });
      }

      // Surface incomplete (needs-review) items as Informational
      for (const incomplete of (axeAny.incomplete ?? [])) {
        const firstNode = incomplete.nodes?.[0];
        const selector = firstNode?.target?.join(", ") ?? "";
        const criterion = extractWcagCriterion(incomplete.tags ?? []);
        const level = extractWcagLevel(incomplete.tags ?? []);
        const category = ruleToCategory(incomplete.id);

        allFindings.push({
          ruleId: `${incomplete.id}:needs-review`,
          title: `Needs review: ${incomplete.help}`,
          description: `${incomplete.description}\n\nManual verification required.`,
          severity: "Informational",
          wcagCriterion: criterion ? `WCAG ${criterion} (Level ${level})` : undefined,
          location: { url: pageUrl, selector },
          raw: incomplete,
          _category: category,
        });
      }

      const violations = (axeAny.violations ?? []).length;
      const incomplete = (axeAny.incomplete ?? []).length;
      console.log(`[AccessibilityScanner] ${pageUrl} — ${violations} violations, ${incomplete} needs-review`);
    }

    // Pages actually scanned = those that made it into pageReports (budget may have cut the loop short)
    const scannedPageUrls = Object.keys(pageReports);
    const discoveredCount = pages.length;
    const scannedCount = scannedPageUrls.length;
    const partial = scannedCount < discoveredCount;

    const totalViolations = allFindings.filter((f) => f.ruleId !== "target-unreachable" && !f.ruleId.endsWith(":needs-review")).length;
    console.log(
      `[AccessibilityScanner] ${scannedCount}/${discoveredCount} pages scanned — ${totalViolations} total violation instances (before cross-page dedup in scan runner)` +
        (partial ? ` [PARTIAL — ${discoveredCount - scannedCount} page(s) skipped due to time budget]` : ""),
    );

    return {
      findings: allFindings,
      rawReport: {
        contentType: "application/json",
        // scannedPages = URLs actually scanned (used by the scan runner's scope-change guard).
        // discoveredPages = total pages discovered (may exceed scannedPages when budget ran out).
        // partial = true when the time-budget guard stopped the scan early.
        body: JSON.stringify({
          scannedPages: scannedPageUrls,
          discoveredPages: discoveredCount,
          partial,
          pages: pageReports,
        }, null, 2),
      },
      tool: getAxeVersion(),
      startedAt,
      finishedAt: new Date(),
    };
  },
};

// Register in the global registry so runObservatoryScan can find it
import { registerScanner } from "./observatory-scanners";
registerScanner(axeCoreScanner);
