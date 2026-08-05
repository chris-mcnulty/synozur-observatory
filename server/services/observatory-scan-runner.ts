/**
 * Observatory Scan Runner — orchestrates automated scans for an assessment.
 *
 * Responsibilities:
 *  1. Look up the assessment + application to get the target URL
 *  2. Find the right ScannerProvider for the assessment type
 *  3. Run the scan (via the job queue — never called inline)
 *  4. Write ScannerFindings → obs_findings with cross-page dedup:
 *       dedup key = scanRuleId|selector (no URL component)
 *       source_pages accumulates ALL page URLs where the violation was seen
 *  5. Persist the combined raw report as obs_evidence (type: scan_report)
 *  6. Link evidence to assessment + each finding
 *  7. Auto-resolve open scan-created findings no longer detected, with two
 *     safety guards:
 *       a) Skip entirely when target-unreachable was detected (global guard)
 *       b) Skip per-finding when its source_pages contains a URL not in the
 *          current scanned set (scope-change guard)
 *  8. Update assessment status to "completed"
 */

import { db } from "../db";
import { eq, and, inArray } from "drizzle-orm";
import {
  obsAssessments,
  obsApplications,
  obsFindings,
  obsEvidence,
  obsAssessmentEvidence,
  obsFindingEvidence,
  obsReviewItems,
  obsReviewItemFindings,
  obsPenTests,
  obsPenTestFindings,
} from "@shared/schema";
import { findScannerForType } from "./observatory-scanners";
import type { ScanRequest } from "./observatory-scanners";
import { validateUrlWithDnsCheck } from "../utils/url-validator";

export interface ScanRunOptions {
  assessmentId: string;
  tenantDomain: string;
  /** User ID who triggered the scan (for audit / createdBy). */
  triggeredByUserId?: string;
  /** Job-queue AbortSignal — passed through to the scanner so it can release resources when the job times out. */
  signal?: AbortSignal;
  /**
   * Maximum number of pages to discover and scan (accessibility scans only).
   * Clamped to [1, 25]. Defaults to 10 inside the scanner.
   */
  pageLimit?: number;
}

export interface ScanRunResult {
  findingsCreated: number;
  findingsSkipped: number;
  findingsResolved: number;
  evidenceId: string | null;
  tool: string;
  durationMs: number;
}
export async function runObservatoryScan(opts: ScanRunOptions): Promise<ScanRunResult> {
  const { assessmentId, tenantDomain, triggeredByUserId } = opts;
  const started = Date.now();

  // ── 1. Load assessment + application ────────────────────────────────────
  const [assessment] = await db
    .select()
    .from(obsAssessments)
    .where(and(eq(obsAssessments.id, assessmentId), eq(obsAssessments.tenantDomain, tenantDomain)));

  if (!assessment) throw new Error(`Assessment ${assessmentId} not found for tenant ${tenantDomain}`);

  const [application] = await db
    .select()
    .from(obsApplications)
    .where(and(eq(obsApplications.id, assessment.applicationId), eq(obsApplications.tenantDomain, tenantDomain)));

  if (!application) throw new Error(`Application ${assessment.applicationId} not found`);

  const rawTargetUrl = application.appUrl;
  if (!rawTargetUrl) {
    throw new Error(
      `Application "${application.name}" has no URL configured. Add an App URL in the application settings before running a scan.`,
    );
  }

  // ── SSRF guard: validate scheme and DNS before any scanner network request ──
  const urlCheck = await validateUrlWithDnsCheck(rawTargetUrl);
  if (!urlCheck.isValid) {
    throw new Error(
      `Application URL "${rawTargetUrl}" failed safety validation: ${urlCheck.error ?? "invalid URL"}. ` +
      `Private/internal addresses and non-HTTP(S) schemes are blocked.`,
    );
  }
  const targetUrl = urlCheck.normalizedUrl ?? rawTargetUrl;

  // ── 2. Find scanner ───────────────────────────────────────────────────────
  const scannerOrNull = await findScannerForType(assessment.type, tenantDomain);
  if (!scannerOrNull) {
    throw new Error(
      `No scanner is available for assessment type "${assessment.type}". ` +
      `Supported types: accessibility, penetration_test, performance.`,
    );
  }
  // Capture in a non-nullable const so TypeScript can narrow inside the inner
  // executeScan() closure (narrowing is not carried across function boundaries).
  const scanner = scannerOrNull;

  // ── 3. Mark assessment in_progress ───────────────────────────────────────
  // Remember the prior status so a failed/timed-out scan can restore it instead
  // of leaving the assessment stuck "in_progress" forever.
  const priorStatus = assessment.status;
  await db
    .update(obsAssessments)
    .set({ status: "in_progress", updatedAt: new Date() })
    .where(eq(obsAssessments.id, assessmentId));

  try {
    return await executeScan();
  } catch (err) {
    // Restore the pre-scan status (falling back to "planned" if the assessment
    // was already in_progress) so the UI doesn't show a scan that never ends.
    const restoreTo = priorStatus === "in_progress" ? "planned" : priorStatus;
    await db
      .update(obsAssessments)
      .set({ status: restoreTo, updatedAt: new Date() })
      .where(eq(obsAssessments.id, assessmentId))
      .catch(() => {});
    throw err;
  }

  async function executeScan(): Promise<ScanRunResult> {
  // scanner is non-null here (null-checked before executeScan is ever invoked),
  // but TypeScript cannot narrow a closed-over variable through a nested function
  // boundary. Bind to a fresh const so all uses below are provably non-null.
  const sc = scanner!;

  // ── 4. Run scan ───────────────────────────────────────────────────────────
  const request: ScanRequest = {
    tenantDomain,
    applicationId: assessment.applicationId,
    assessmentId,
    target: { url: targetUrl },
    // Thread pageLimit so the accessibility scanner can cap page discovery.
    options: opts.pageLimit != null ? { pageLimit: opts.pageLimit } : undefined,
  };

  console.log(`[ScanRunner] Starting ${sc.key} scan for assessment ${assessmentId} (${assessment.type}) → ${targetUrl}`);
  const result = await sc.runScan({ ...request, signal: opts.signal });

  // ── 5. Persist raw report as evidence (including full JSON body) ────────────
  let evidenceId: string | null = null;
  if (result.rawReport) {
    const [evidenceRow] = await db
      .insert(obsEvidence)
      .values({
        tenantDomain,
        title: `${sc.name} scan report — ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`,
        description: `Automated scan by ${result.tool}. Duration: ${Math.round((result.finishedAt.getTime() - result.startedAt.getTime()) / 1000)}s.`,
        evidenceType: "scan_report",
        contentType: result.rawReport.contentType,
        source: result.tool,
        collectedAt: result.startedAt,
        createdBy: triggeredByUserId ?? null,
        externalUrl: null,
        fileName: `scan-report-${assessmentId}-${Date.now()}.json`,
        fileSize: result.rawReport.body.length,
        // Persist the raw JSON payload in the body column for analyst inspection
        body: result.rawReport.body,
      })
      .returning({ id: obsEvidence.id });

    evidenceId = evidenceRow.id;

    // Link evidence to assessment
    await db.insert(obsAssessmentEvidence).values({
      assessmentId,
      evidenceId,
    }).onConflictDoNothing();
  }

  // ── 6. Reconcile findings ─────────────────────────────────────────────────

  // Recover the set of pages actually scanned this run from the raw report.
  // Used by the scope-change guard when deciding which findings to auto-resolve.
  const scannedPages = new Set<string>();
  try {
    if (result.rawReport?.body) {
      const reportObj = JSON.parse(result.rawReport.body) as any;
      if (Array.isArray(reportObj?.scannedPages)) {
        for (const url of reportObj.scannedPages as string[]) scannedPages.add(url);
      }
    }
  } catch {
    // non-JSON raw report (e.g. security scanner) — scannedPages stays empty;
    // the scope-change guard treats empty scannedPages as "all known pages scanned"
    // via the fallback in allSourcePagesWereScanned (pages.length === 0 → true)
  }
  // Fallback: union of finding location URLs (covers scanners that don't embed scannedPages)
  if (scannedPages.size === 0) {
    for (const f of result.findings) {
      if (f.location?.url) scannedPages.add(f.location.url);
    }
  }

  // Pre-pass: build ruleKey → Set<pageUrl> across ALL findings (including
  // duplicates by key from multiple pages).  This lets us record every page
  // where a violation was seen, even for keys that seenScanKeys will skip.
  const ruleKeyToPages = new Map<string, Set<string>>();
  for (const finding of result.findings) {
    const selector = finding.location?.selector ?? finding.location?.file ?? "";
    const key = `${finding.ruleId}|${selector}`;
    if (!ruleKeyToPages.has(key)) ruleKeyToPages.set(key, new Set());
    const pageUrl = finding.location?.url;
    if (pageUrl) ruleKeyToPages.get(key)!.add(pageUrl);
  }

  const existingFindings = await db
    .select({
      id: obsFindings.id,
      title: obsFindings.title,
      affectedComponent: obsFindings.affectedComponent,
      status: obsFindings.status,
      scanRuleId: obsFindings.scanRuleId,
      sourcePages: obsFindings.sourcePages,
    })
    .from(obsFindings)
    .where(and(eq(obsFindings.assessmentId, assessmentId), eq(obsFindings.tenantDomain, tenantDomain)));

  // Primary match: scanRuleId|selector. Fallback: title|selector (legacy rows
  // created before scanRuleId existed — matched once, then backfilled).
  const existingByRuleKey = new Map(
    existingFindings.filter(f => f.scanRuleId != null).map(f => [`${f.scanRuleId}|${f.affectedComponent ?? ""}`, f]),
  );
  const existingByTitleKey = new Map(
    existingFindings.filter(f => f.scanRuleId == null).map(f => [`${f.title}|${f.affectedComponent ?? ""}`, f]),
  );
  const matchedFindingIds = new Set<string>();

  // For penetration_test assessments, look up the linked pen test so we can
  // create obs_pen_test_findings junction rows alongside each new finding.
  let penTestId: string | null = null;
  if (assessment.type === "penetration_test") {
    const [pt] = await db
      .select({ id: obsPenTests.id })
      .from(obsPenTests)
      .where(and(eq(obsPenTests.assessmentId, assessmentId), eq(obsPenTests.tenantDomain, tenantDomain)));
    penTestId = pt?.id ?? null;
  }

  // For accessibility assessments, pre-load review items to link findings
  const reviewItemsByCategory = new Map<string, string>();
  if (assessment.type === "accessibility") {
    const reviewItems = await db
      .select({ id: obsReviewItems.id, category: obsReviewItems.category })
      .from(obsReviewItems)
      .where(and(eq(obsReviewItems.assessmentId, assessmentId), eq(obsReviewItems.module, "accessibility")));
    for (const ri of reviewItems) {
      if (ri.category) reviewItemsByCategory.set(ri.category, ri.id);
    }
  }

  let findingsCreated = 0;
  let findingsSkipped = 0;
  let findingsResolved = 0;

  // Scan-side dedup: identical rule|selector results within one scan are
  // processed (insert/update) once.  The ruleKeyToPages pre-pass above already
  // captured ALL page URLs for every key, so skipped duplicates still count.
  const seenScanKeys = new Set<string>();
  // "target-unreachable" is a synthetic finding some scanners emit instead of
  // throwing.  Treat it as a failed scan: never auto-resolve other findings.
  const scanUnreachable = result.findings.some((f) => f.ruleId === "target-unreachable");

  for (const finding of result.findings) {
    const selector = finding.location?.selector ?? finding.location?.file ?? "";
    const ruleKey = `${finding.ruleId}|${selector}`;
    if (seenScanKeys.has(ruleKey)) {
      // Duplicate key from a different page — ruleKeyToPages already recorded
      // the page URL; skip the insert/update but don't count as skipped.
      continue;
    }
    seenScanKeys.add(ruleKey);

    const titleKey = `${finding.title}|${selector}`;
    const existing = existingByRuleKey.get(ruleKey) ?? existingByTitleKey.get(titleKey);

    // All page URLs where this rule|selector violation was seen this run
    const newPageUrls = [...(ruleKeyToPages.get(ruleKey) ?? new Set<string>())];
    const sourcePagesJson = newPageUrls.length > 0 ? JSON.stringify(newPageUrls) : null;

    let findingId: string;
    if (existing) {
      // Consume the row so it can only match one scan result.
      existingByRuleKey.delete(ruleKey);
      existingByTitleKey.delete(titleKey);
      // Already known — refresh metadata but NEVER override a human decision.
      // remediated / accepted_risk / false_positive / in_progress stay untouched.
      matchedFindingIds.add(existing.id);
      findingId = existing.id;

      // Merge source_pages: union existing + new pages from this run
      const existingPageUrls = parseSourcePages(existing.sourcePages);
      const mergedPages = [...new Set([...existingPageUrls, ...newPageUrls])];
      const mergedSourcePages = mergedPages.length > 0 ? JSON.stringify(mergedPages) : null;

      await db
        .update(obsFindings)
        .set({
          description: finding.description ?? null,
          severity: finding.severity,
          wcagCriterion: finding.wcagCriterion ?? null,
          cweId: finding.cweId ?? null,
          // Backfill scanRuleId on legacy rows so future scans match by rule.
          scanRuleId: finding.ruleId,
          // Merge page URLs — additive, never overwrites prior provenance.
          sourcePages: mergedSourcePages,
          updatedAt: new Date(),
        })
        .where(eq(obsFindings.id, existing.id));
      findingsSkipped++;
    } else {
      const [inserted] = await db
        .insert(obsFindings)
        .values({
          tenantDomain,
          assessmentId,
          applicationId: assessment.applicationId,
          versionId: assessment.versionId ?? null,
          title: finding.title,
          description: finding.description ?? null,
          severity: finding.severity,
          domain: mapDomain(assessment.type),
          status: "open",
          affectedComponent: selector || null,
          wcagCriterion: finding.wcagCriterion ?? null,
          cweId: finding.cweId ?? null,
          sourceLine: finding.location?.line ?? null,
          scanRuleId: finding.ruleId,
          // Record the first-seen URL in stepsToReproduce for quick analyst reference.
          stepsToReproduce: finding.location?.url
            ? `URL: ${finding.location.url}${selector ? `\nSelector: ${selector}` : ""}${newPageUrls.length > 1 ? `\n(+${newPageUrls.length - 1} other page${newPageUrls.length > 2 ? "s" : ""})` : ""}`
            : null,
          // Record all pages as a JSON array for programmatic use.
          sourcePages: sourcePagesJson,
          createdBy: triggeredByUserId ?? null,
        })
        .returning({ id: obsFindings.id });
      findingId = inserted.id;
      findingsCreated++;
    }

    // Associations run for BOTH inserted and matched findings so legacy rows
    // missing junction/evidence/review links get repaired idempotently.

    // For pen tests: create the junction row so the finding shows in the pen test detail.
    if (penTestId) {
      await db.insert(obsPenTestFindings).values({
        tenantDomain,
        penTestId,
        findingId,
        cvssScore: defaultCvssForSeverity(finding.severity),
        validationStatus: "Not Started",
      }).onConflictDoNothing();
    }

    // Link raw scan evidence to each finding
    if (evidenceId) {
      await db.insert(obsFindingEvidence).values({
        findingId,
        evidenceId,
      }).onConflictDoNothing();
    }

    // For accessibility: link finding to the matching review item by category
    if (assessment.type === "accessibility") {
      const extended = finding as typeof finding & { _category?: string };
      const category = extended._category;
      if (category && reviewItemsByCategory.has(category)) {
        await db.insert(obsReviewItemFindings).values({
          reviewItemId: reviewItemsByCategory.get(category)!,
          findingId,
        }).onConflictDoNothing();
      }
    }
  }

  // ── 6b. Auto-resolve scan findings no longer detected ──────────────────────
  // Only rows this scanner previously created (scanRuleId set) AND still "open"
  // are candidates. Three safety guards prevent false positives:
  //
  //   1. Global unreachable guard: if any finding was "target-unreachable",
  //      skip auto-resolve entirely — a transient outage must not mass-close
  //      real findings.
  //
  //   2. Namespace guard: when the scanner declares ownedRuleIds, only
  //      auto-resolve findings whose scanRuleId is in that set. Prevents
  //      cross-path interference when the same assessment type has multiple
  //      scan entry points (e.g. /scan provider path vs /performance-scan
  //      SLA route) each owning distinct rule-ID namespaces.
  //
  //   3. Scope-change guard: if a finding's source_pages contains a URL that
  //      wasn't in the current scan's page set, leave it open — we can't know
  //      if it's fixed on pages we didn't visit.
  const staleOpenIds = scanUnreachable ? [] : existingFindings
    .filter((f) => {
      if (f.scanRuleId == null || f.status !== "open" || matchedFindingIds.has(f.id)) return false;
      if (sc.ownedRuleIds && !sc.ownedRuleIds.includes(f.scanRuleId)) return false;
      if (!allSourcePagesWereScanned(f.sourcePages, scannedPages)) return false;
      return true;
    })
    .map((f) => f.id);

  if (staleOpenIds.length > 0) {
    await db
      .update(obsFindings)
      .set({
        status: "remediated",
        resolvedAt: new Date(),
        resolutionNote: "Resolved by re-scan — issue no longer detected by automated scanner",
        updatedAt: new Date(),
      })
      .where(inArray(obsFindings.id, staleOpenIds));
    findingsResolved = staleOpenIds.length;
  }

  // ── 7. Mark assessment completed ─────────────────────────────────────────
  await db
    .update(obsAssessments)
    .set({ status: "completed", updatedAt: new Date() })
    .where(eq(obsAssessments.id, assessmentId));

  const durationMs = Date.now() - started;
  console.log(
    `[ScanRunner] Completed ${sc.key} for ${assessmentId}: ` +
    `${findingsCreated} findings created, ${findingsSkipped} updated/skipped, ${findingsResolved} auto-resolved, ${Math.round(durationMs / 1000)}s`,
  );

  return { findingsCreated, findingsSkipped, findingsResolved, evidenceId, tool: result.tool, durationMs };
  }
}
/** Reasonable default CVSS score when a scan finding has no explicit score. */
function defaultCvssForSeverity(severity: string): number {
  switch (severity) {
    case "Critical":      return 9.0;
    case "High":          return 7.5;
    case "Medium":        return 5.0;
    case "Low":           return 2.0;
    case "Informational": return 0.0;
    default:              return 5.0;
  }
}

function mapDomain(assessmentType: string): string {
  switch (assessmentType) {
    case "accessibility":        return "accessibility";
    case "penetration_test":
    case "security_source_review": return "security";
    case "performance":          return "performance";
    case "code_quality":         return "code_quality";
    case "compliance":           return "compliance";
    default:                     return "other";
  }
}

/**
 * Parse source_pages JSON, return the URL array.
 * Returns [] on null / invalid JSON.
 */
function parseSourcePages(sourcePages: string | null | undefined): string[] {
  if (!sourcePages) return [];
  try {
    const parsed = JSON.parse(sourcePages);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Scope-change guard: return true only if every URL recorded in a finding's
 * source_pages was actually scanned in the current run.
 * Findings whose source URL set is entirely within the current scan are safe to
 * auto-resolve; those with URLs we didn't visit this run are left open.
 */
function allSourcePagesWereScanned(sourcePages: string | null | undefined, scannedPages: Set<string>): boolean {
  const pages = parseSourcePages(sourcePages);
  // No recorded pages → conservative: allow auto-resolve (legacy row)
  if (pages.length === 0) return true;
  return pages.every((url) => scannedPages.has(url));
}
