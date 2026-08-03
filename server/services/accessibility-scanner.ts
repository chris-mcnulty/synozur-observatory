/**
 * Accessibility Scanner — implements the ScannerProvider contract using
 * axe-core injected into a headless Puppeteer page.
 *
 * Scan flow:
 *  1. Load the application URL with the shared headless browser pool.
 *  2. Inject axe-core and run axe.run() in-page.
 *  3. Map each violation → ScannerFinding (severity, WCAG criterion, selector).
 *  4. Persist findings as obs_findings + link to matching accessibility review items.
 *  5. Store the raw axe report as obs_evidence (evidenceType = "scan_report").
 */

import * as fs from "fs";
import * as path from "path";
import { db } from "../db";
import {
  obsFindings,
  obsEvidence,
  obsAssessmentEvidence,
  obsFindingEvidence,
  obsReviewItems,
  obsReviewItemFindings,
  obsAuditLogs,
} from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { runInPage } from "./headless-crawler";
import { validateUrlWithDnsCheck } from "../utils/url-validator";
import type { ScannerProvider, ScanRequest, ScanResult, ScannerFinding } from "./observatory-scanners";

// ── axe-core source (loaded once at module init) ────────────────────────────

let _axeSource: string | null = null;

function getAxeSource(): string {
  if (_axeSource) return _axeSource;
  try {
    const axePath = require.resolve("axe-core");
    _axeSource = fs.readFileSync(axePath, "utf8");
    console.log("[AccessibilityScanner] axe-core loaded from:", axePath);
    return _axeSource;
  } catch (err) {
    throw new Error(`axe-core not found. Run: npm install axe-core\n${err}`);
  }
}

function getAxeVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("axe-core/package.json").version;
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

    const startedAt = new Date();
    const axeSource = getAxeSource();
    const findings: (ScannerFinding & { _category: string })[] = [];
    let rawAxeResults: unknown = null;

    console.log(`[AccessibilityScanner] Scanning ${targetUrl} for assessment ${request.assessmentId}`);

    const scanResult = await runInPage(
      targetUrl,
      async (page) => {
        // Inject axe-core and run WCAG 2.1/2.2 A, AA, AAA
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
      { waitTime: 1500, timeout: 45000, ssrfProtect: true, waitUntil: "domcontentloaded" },
    );

    if (!scanResult) {
      throw new Error(`Could not load ${targetUrl} for accessibility scan — headless browser failed`);
    }

    rawAxeResults = scanResult;
    const axeAny = scanResult as any;

    // Map violations → findings (one per rule, using first node as primary location)
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

      findings.push({
        ruleId: violation.id,
        title: `[${level}] ${violation.help}`,
        description,
        severity: mapImpact(violation.impact),
        wcagCriterion: criterion ? `WCAG ${criterion} (Level ${level})` : undefined,
        location: { url: targetUrl, selector },
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

      findings.push({
        ruleId: `${incomplete.id}:needs-review`,
        title: `Needs review: ${incomplete.help}`,
        description: `${incomplete.description}\n\nManual verification required.`,
        severity: "Informational",
        wcagCriterion: criterion ? `WCAG ${criterion} (Level ${level})` : undefined,
        location: { url: targetUrl, selector },
        raw: incomplete,
        _category: category,
      });
    }

    const violations = (axeAny.violations ?? []).length;
    const incomplete = (axeAny.incomplete ?? []).length;
    console.log(`[AccessibilityScanner] ${targetUrl} — ${violations} violations, ${incomplete} needs-review`);

    return {
      findings,
      rawReport: {
        contentType: "application/json",
        body: JSON.stringify(rawAxeResults, null, 2),
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

// ── Persist scan findings + evidence ─────────────────────────────────────────

export async function persistScanFindings(
  tenantDomain: string,
  assessmentId: string,
  applicationId: string,
  versionId: string | null | undefined,
  scanResult: ScanResult,
  scannedUrl: string,
): Promise<{ created: number; evidenceId: string }> {
  const now = new Date();

  // 1. Store the raw axe report as obs_evidence, including full JSON body
  const [evidence] = await db
    .insert(obsEvidence)
    .values({
      tenantDomain,
      title: `axe-core scan — ${new URL(scannedUrl).hostname} (${now.toISOString().slice(0, 10)})`,
      description: `Automated WCAG 2.1/2.2 scan via axe-core ${scanResult.tool}. ${scanResult.findings.length} violations found.`,
      evidenceType: "scan_report",
      source: `axe-core ${scanResult.tool}`,
      collectedAt: scanResult.finishedAt,
      externalUrl: scannedUrl,
      contentType: scanResult.rawReport?.contentType ?? "application/json",
      // Persist the raw report payload so analysts can inspect the full axe output
      body: scanResult.rawReport?.body ?? null,
    })
    .returning();

  // Link evidence to assessment
  await db
    .insert(obsAssessmentEvidence)
    .values({ assessmentId, evidenceId: evidence.id })
    .onConflictDoNothing();

  // 2. Load existing review items so we can link findings to them
  const reviewItems = await db
    .select()
    .from(obsReviewItems)
    .where(
      and(
        eq(obsReviewItems.assessmentId, assessmentId),
        eq(obsReviewItems.module, "accessibility"),
      ),
    );
  const categoryToItemId = new Map(reviewItems.map((r) => [r.category, r.id]));

  // 3. Deduplicate: skip findings already present (same assessmentId + wcagCriterion + affectedComponent)
  const existingFindings = await db
    .select({ wcagCriterion: obsFindings.wcagCriterion, affectedComponent: obsFindings.affectedComponent })
    .from(obsFindings)
    .where(eq(obsFindings.assessmentId, assessmentId));

  const existingKeys = new Set(
    existingFindings.map((f) => `${f.wcagCriterion ?? ""}||${f.affectedComponent ?? ""}`),
  );

  let created = 0;
  for (const sf of scanResult.findings) {
    const extended = sf as ScannerFinding & { _category?: string };
    const selector = sf.location?.selector ?? "";
    const dedupeKey = `${sf.wcagCriterion ?? ""}||${selector}`;
    if (existingKeys.has(dedupeKey)) continue;
    existingKeys.add(dedupeKey);

    const [finding] = await db
      .insert(obsFindings)
      .values({
        tenantDomain,
        assessmentId,
        applicationId,
        versionId: versionId ?? null,
        title: sf.title.slice(0, 255),
        description: sf.description ?? null,
        severity: sf.severity,
        domain: "accessibility",
        status: "open",
        wcagCriterion: sf.wcagCriterion ?? null,
        affectedComponent: selector || null,
        recommendation: `Refer to axe-core guidance: ${(sf.raw as any)?.helpUrl ?? ""}`,
        createdBy: null,
      })
      .returning();

    created++;

    // Link finding to evidence
    await db
      .insert(obsFindingEvidence)
      .values({ findingId: finding.id, evidenceId: evidence.id })
      .onConflictDoNothing();

    // Link finding to the matching accessibility review item
    const category = extended._category;
    if (category && categoryToItemId.has(category)) {
      await db
        .insert(obsReviewItemFindings)
        .values({ reviewItemId: categoryToItemId.get(category)!, findingId: finding.id })
        .onConflictDoNothing();
    }
  }

  return { created, evidenceId: evidence.id };
}
