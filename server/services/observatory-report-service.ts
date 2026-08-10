/**
 * Observatory Reporting Engine.
 *
 * Renders printable HTML reports from live Observatory data and generates
 * them asynchronously through the job queue (202-and-poll pattern). PDF
 * export reuses the shared Puppeteer browser pool.
 *
 * Report types:
 *   - executive_readiness     — portfolio/application readiness for executives
 *   - technical_assessment    — full assessment + findings detail
 *   - accessibility_vpat      — WCAG/508 mapping + VPAT support data
 *   - pen_test                — penetration test report with validation state
 *   - certification_readiness — blockers, evidence coverage, go/no-go view
 *
 * Every finding referenced in a report lists its linked evidence so the
 * traceability chain (report → finding → evidence) is preserved.
 */
import { db } from "../db";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import {
  obsApplications,
  obsVersions,
  obsAssessments,
  obsFindings,
  obsEvidence,
  obsFindingEvidence,
  obsPenTests,
  obsPenTestFindings,
  obsReviewItems,
  obsVpatEntries,
  obsControls,
  obsFrameworks,
  obsReports,
  OBS_READINESS_DOMAIN_LABELS,
  OBS_REPORT_TYPE_LABELS,
  OBS_VPAT_DISCLAIMER,
  AI_FEATURES,
  type ObsReportType,
  type ObsApplication,
  type ObsVersion,
  type ObsFinding,
  type ObsDomainScore,
  type ObsReadinessBlocker,
} from "@shared/schema";
import { computeReadiness, type ReadinessResult } from "./observatory-readiness";
import { completeForFeature } from "./ai-provider";
import { enqueue, enqueuePdf } from "./job-queue";
import { withPdfPage } from "./pdf-browser-pool";

// ── shared rendering helpers ────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

const SEVERITY_COLORS: Record<string, string> = {
  Critical: "#dc2626",
  High: "#ea580c",
  Medium: "#ca8a04",
  Low: "#2563eb",
  Informational: "#6b7280",
};

const BAND_COLORS: Record<string, string> = {
  "Ready": "#16a34a",
  "Ready With Minor Remediation": "#ca8a04",
  "Remediation Required": "#ea580c",
  "Not Ready": "#dc2626",
};

function severityChip(sev: string): string {
  const c = SEVERITY_COLORS[sev] ?? "#6b7280";
  return `<span class="chip" style="color:${c};border-color:${c}">${esc(sev)}</span>`;
}

function bandChip(band: string): string {
  const c = BAND_COLORS[band] ?? "#6b7280";
  return `<span class="chip" style="color:${c};border-color:${c}">${esc(band)}</span>`;
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function baseCss(): string {
  return `
    * { box-sizing: border-box; }
    body { font-family: "Segoe UI", Helvetica, Arial, sans-serif; color: #1a1a2e; margin: 0; padding: 40px 48px; font-size: 12px; line-height: 1.5; }
    h1 { font-size: 24px; margin: 0 0 4px; color: #231650; }
    h2 { font-size: 16px; margin: 28px 0 10px; color: #231650; border-bottom: 2px solid #e0dced; padding-bottom: 6px; }
    h3 { font-size: 13px; margin: 18px 0 6px; color: #3a2d6e; }
    p { margin: 6px 0; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; page-break-inside: auto; }
    th { text-align: left; background: #f3f1fa; color: #231650; padding: 6px 8px; font-size: 11px; border: 1px solid #e0dced; }
    td { padding: 6px 8px; border: 1px solid #e8e6f0; vertical-align: top; }
    tr { page-break-inside: avoid; }
    .chip { display: inline-block; border: 1px solid; border-radius: 10px; padding: 1px 8px; font-size: 10px; font-weight: 600; white-space: nowrap; }
    .meta { color: #666; font-size: 11px; margin-bottom: 2px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #231650; padding-bottom: 14px; margin-bottom: 18px; }
    .brand { font-size: 13px; font-weight: 700; color: #231650; letter-spacing: 1px; }
    .score-hero { display: flex; gap: 24px; align-items: center; background: #f7f6fc; border: 1px solid #e0dced; border-radius: 8px; padding: 16px 20px; margin: 14px 0; }
    .score-num { font-size: 42px; font-weight: 700; color: #231650; }
    .blocker { background: #fef2f2; border: 1px solid #fecaca; border-left: 4px solid #dc2626; border-radius: 4px; padding: 8px 12px; margin: 6px 0; }
    .callout { background: #f7f6fc; border: 1px solid #e0dced; border-radius: 6px; padding: 10px 14px; margin: 10px 0; }
    .disclaimer { background: #fffbeb; border: 1px solid #fde68a; border-left: 4px solid #d97706; padding: 10px 14px; margin: 14px 0; font-weight: 600; font-size: 11px; }
    .evidence-list { margin: 2px 0 0; padding-left: 16px; color: #444; font-size: 11px; }
    .footer { margin-top: 32px; border-top: 1px solid #e0dced; padding-top: 10px; color: #888; font-size: 10px; }
    .bar-track { background: #e8e6f0; border-radius: 4px; height: 10px; width: 180px; display: inline-block; vertical-align: middle; }
    .bar-fill { height: 10px; border-radius: 4px; display: block; }
    @media print { body { padding: 24px 28px; } }
  `;
}

export function reportShell(title: string, subtitle: string, body: string, opts?: { brand?: string; brandUrl?: string }): string {
  const brand = opts?.brand ?? "Observatory";
  const brandUrl = opts?.brandUrl;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${baseCss()}</style></head>
<body>
  <div class="header">
    <div>
      <h1>${esc(title)}</h1>
      <p class="meta">${esc(subtitle)}</p>
    </div>
    <div style="text-align:right;">
      <div class="brand">${esc(brand)}</div>
      ${brandUrl ? `<div class="meta" style="margin:2px 0 0;">${esc(brandUrl)}</div>` : ""}
    </div>
  </div>
  ${body}
  <div class="footer">Generated by ${esc(brand)}${brandUrl ? ` · ${esc(brandUrl)}` : ""} on ${esc(new Date().toLocaleString("en-US"))} · Confidential — internal use only.</div>
</body></html>`;
}

// ── data loading ────────────────────────────────────────────────────────────

interface ReportData {
  application: ObsApplication;
  version: ObsVersion | null;
  versions: ObsVersion[];
  assessments: (typeof obsAssessments.$inferSelect)[];
  findings: ObsFinding[];
  evidenceByFinding: Map<string, { id: string; title: string; evidenceType: string; source: string | null }[]>;
  readiness: ReadinessResult | null;
}

export async function loadReportData(tenantDomain: string, applicationId: string, versionId?: string | null): Promise<ReportData> {
  const [application] = await db
    .select()
    .from(obsApplications)
    .where(and(eq(obsApplications.id, applicationId), eq(obsApplications.tenantDomain, tenantDomain)));
  if (!application) throw new Error("Application not found");

  const versions = await db
    .select()
    .from(obsVersions)
    .where(and(eq(obsVersions.tenantDomain, tenantDomain), eq(obsVersions.applicationId, applicationId)))
    .orderBy(desc(obsVersions.createdAt));

  const version = versionId ? versions.find((v) => v.id === versionId) ?? null : versions[0] ?? null;

  const assessments = await db
    .select()
    .from(obsAssessments)
    .where(
      and(
        eq(obsAssessments.tenantDomain, tenantDomain),
        eq(obsAssessments.applicationId, applicationId),
        ...(version ? [or(eq(obsAssessments.versionId, version.id), isNull(obsAssessments.versionId))] : []),
      ),
    )
    .orderBy(desc(obsAssessments.createdAt));

  const assessmentIds = assessments.map((a) => a.id);
  const findings = assessmentIds.length
    ? await db
        .select()
        .from(obsFindings)
        .where(and(eq(obsFindings.tenantDomain, tenantDomain), inArray(obsFindings.assessmentId, assessmentIds)))
        .orderBy(asc(obsFindings.createdAt))
    : [];

  // Evidence traceability per finding
  const findingIds = findings.map((f) => f.id);
  const evidenceByFinding = new Map<string, { id: string; title: string; evidenceType: string; source: string | null }[]>();
  if (findingIds.length) {
    const links = await db
      .select({
        findingId: obsFindingEvidence.findingId,
        id: obsEvidence.id,
        title: obsEvidence.title,
        evidenceType: obsEvidence.evidenceType,
        source: obsEvidence.source,
      })
      .from(obsFindingEvidence)
      .innerJoin(obsEvidence, eq(obsFindingEvidence.evidenceId, obsEvidence.id))
      .where(inArray(obsFindingEvidence.findingId, findingIds));
    for (const l of links) {
      const list = evidenceByFinding.get(l.findingId) ?? [];
      list.push({ id: l.id, title: l.title, evidenceType: l.evidenceType, source: l.source });
      evidenceByFinding.set(l.findingId, list);
    }
  }

  const readiness = version ? await computeReadiness(tenantDomain, version, application) : null;

  return { application, version, versions, assessments, findings, evidenceByFinding, readiness };
}

// ── shared fragments ────────────────────────────────────────────────────────

const SEVERITY_ORDER = ["Critical", "High", "Medium", "Low", "Informational"];

function findingsTable(findings: ObsFinding[], evidenceByFinding: ReportData["evidenceByFinding"], opts?: { showStatus?: boolean }): string {
  if (!findings.length) return `<p class="meta">No findings recorded.</p>`;
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const rows = sorted
    .map((f) => {
      const ev = evidenceByFinding.get(f.id) ?? [];
      const evHtml = ev.length
        ? `<ul class="evidence-list">${ev.map((e) => `<li>${esc(e.title)} <span class="meta">(${esc(statusLabel(e.evidenceType))}${e.source ? ` · ${esc(e.source)}` : ""})</span></li>`).join("")}</ul>`
        : `<span class="meta">No evidence linked</span>`;
      return `<tr>
        <td>${severityChip(f.severity)}</td>
        <td><strong>${esc(f.title)}</strong>${f.description ? `<br><span class="meta">${esc(f.description).slice(0, 400)}</span>` : ""}
          ${f.recommendation ? `<br><span class="meta"><em>Recommendation:</em> ${esc(f.recommendation).slice(0, 300)}</span>` : ""}</td>
        <td>${esc(statusLabel(f.domain))}</td>
        ${opts?.showStatus === false ? "" : `<td>${esc(statusLabel(f.status))}</td>`}
        <td>${evHtml}</td>
      </tr>`;
    })
    .join("");
  return `<table>
    <thead><tr><th style="width:80px">Severity</th><th>Finding</th><th style="width:90px">Domain</th>${opts?.showStatus === false ? "" : `<th style="width:90px">Status</th>`}<th style="width:220px">Evidence</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function readinessSection(readiness: ReadinessResult | null, versionNumber?: string): string {
  if (!readiness) return `<p class="meta">No version available for readiness scoring.</p>`;
  const domains = (readiness.domainScores as ObsDomainScore[])
    .map((d) => {
      const label = OBS_READINESS_DOMAIN_LABELS[d.domain];
      const score = d.applicable && d.score !== null ? d.score : null;
      const color = score === null ? "#9ca3af" : score >= 90 ? "#16a34a" : score >= 75 ? "#ca8a04" : score >= 60 ? "#ea580c" : "#dc2626";
      return `<tr>
        <td>${esc(label)}</td>
        <td>${d.weight}%</td>
        <td>${score === null ? `<span class="meta">${esc(d.note ?? "N/A")}</span>` : `${score}`}</td>
        <td>${score === null ? "—" : `<span class="bar-track"><span class="bar-fill" style="width:${score}%;background:${color}"></span></span>`}</td>
        <td>${d.openFindings || "—"}</td>
        <td class="meta">${esc(d.note ?? (d.assessed ? "" : "Not assessed"))}</td>
      </tr>`;
    })
    .join("");
  const blockers = (readiness.blockers as ObsReadinessBlocker[])
    .map((b) => `<div class="blocker"><strong>${esc(b.reason)}</strong>${b.refs?.length ? `<ul class="evidence-list">${b.refs.map((r) => `<li>${esc(r.title)}</li>`).join("")}</ul>` : ""}</div>`)
    .join("");
  return `
    <div class="score-hero">
      <div class="score-num">${readiness.overallScore}</div>
      <div>
        <div>${bandChip(readiness.band)}</div>
        <p class="meta">Weighted readiness score${versionNumber ? ` for version ${esc(versionNumber)}` : ""} · Band by score alone: ${esc(readiness.rawBand)}${readiness.blocked ? " · downgraded by hard blockers" : ""}</p>
      </div>
    </div>
    ${blockers ? `<h3>Certification blockers</h3>${blockers}` : `<p class="meta">No hard blockers.</p>`}
    <h3>Domain breakdown</h3>
    <table>
      <thead><tr><th>Domain</th><th style="width:60px">Weight</th><th style="width:50px">Score</th><th style="width:190px"></th><th style="width:80px">Open findings</th><th>Notes</th></tr></thead>
      <tbody>${domains}</tbody>
    </table>`;
}

function aiSummarySection(aiSummary: string | null): string {
  if (!aiSummary) return "";
  const paragraphs = aiSummary
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<h2>Executive Summary</h2><div class="callout">${paragraphs}<p class="meta">AI-drafted summary — review and edit before external distribution.</p></div>`;
}

// ── report renderers ────────────────────────────────────────────────────────

function renderExecutiveReadiness(data: ReportData, aiSummary: string | null): string {
  const { application, version, assessments, findings, readiness, evidenceByFinding } = data;
  const openFindings = findings.filter((f) => ["open", "in_progress"].includes(f.status));
  const bySeverity = SEVERITY_ORDER.map((s) => ({ s, n: openFindings.filter((f) => f.severity === s).length })).filter((x) => x.n > 0);
  const body = `
    ${aiSummarySection(aiSummary)}
    <h2>Readiness Assessment</h2>
    ${readinessSection(readiness, version?.versionNumber)}
    <h2>Risk Overview</h2>
    <p>${openFindings.length} open finding${openFindings.length === 1 ? "" : "s"} across ${assessments.length} assessment${assessments.length === 1 ? "" : "s"}.</p>
    ${bySeverity.length ? `<table><thead><tr><th>Severity</th><th>Open findings</th></tr></thead><tbody>${bySeverity.map((x) => `<tr><td>${severityChip(x.s)}</td><td>${x.n}</td></tr>`).join("")}</tbody></table>` : ""}
    <h2>Top Open Findings</h2>
    ${findingsTable(openFindings.slice(0, 15), evidenceByFinding)}
  `;
  return reportShell(
    `Executive Readiness Report — ${application.name}`,
    `${version ? `Version ${version.versionNumber} · ` : ""}${application.productFamily ?? ""} ${application.certificationTarget ? `· Target: ${application.certificationTarget}` : ""}`,
    body,
  );
}

function renderTechnicalAssessment(data: ReportData, aiSummary: string | null): string {
  const { application, version, assessments, findings, evidenceByFinding, readiness } = data;
  const sections = assessments
    .map((a) => {
      const aFindings = findings.filter((f) => f.assessmentId === a.id);
      return `<h3>${esc(a.title)} <span class="meta">(${esc(statusLabel(a.type))} · ${esc(statusLabel(a.status))}${a.assessorName ? ` · ${esc(a.assessorName)}` : ""})</span></h3>
        ${a.scope ? `<p class="meta"><em>Scope:</em> ${esc(a.scope)}</p>` : ""}
        ${a.executiveSummary ? `<div class="callout">${esc(a.executiveSummary)}</div>` : ""}
        ${findingsTable(aFindings, evidenceByFinding)}`;
    })
    .join("");
  const body = `
    ${aiSummarySection(aiSummary)}
    <h2>Application Profile</h2>
    <table><tbody>
      <tr><td style="width:180px"><strong>Application</strong></td><td>${esc(application.name)}</td></tr>
      <tr><td><strong>Version</strong></td><td>${esc(version?.versionNumber ?? "All versions")}</td></tr>
      <tr><td><strong>Hosting</strong></td><td>${esc(application.hostingPlatform ?? "—")}</td></tr>
      <tr><td><strong>Authentication</strong></td><td>${esc(application.authMethod ?? "—")}</td></tr>
      <tr><td><strong>Data classification</strong></td><td>${esc(statusLabel(application.dataClassification ?? "—"))}</td></tr>
      <tr><td><strong>AI-enabled</strong></td><td>${application.aiEnabled ? "Yes" : "No"}</td></tr>
    </tbody></table>
    <h2>Readiness Snapshot</h2>
    ${readinessSection(readiness, version?.versionNumber)}
    <h2>Assessments &amp; Findings</h2>
    ${sections || `<p class="meta">No assessments recorded.</p>`}
  `;
  return reportShell(`Technical Assessment Report — ${application.name}`, `${version ? `Version ${version.versionNumber}` : "All versions"}`, body);
}

export async function renderAccessibilityVpat(tenantDomain: string, data: ReportData, aiSummary: string | null): Promise<string> {
  const { application, version, findings, evidenceByFinding } = data;
  const a11yFindings = findings.filter((f) => f.domain === "accessibility");

  let vpatSection = `<p class="meta">No VPAT worksheet has been initialized for this version.</p>`;
  if (version) {
    const entries = await db
      .select({
        entry: obsVpatEntries,
        control: obsControls,
        framework: obsFrameworks,
      })
      .from(obsVpatEntries)
      .innerJoin(obsControls, eq(obsVpatEntries.controlRef, obsControls.id))
      .innerJoin(obsFrameworks, eq(obsControls.frameworkId, obsFrameworks.id))
      .where(and(eq(obsVpatEntries.tenantDomain, tenantDomain), eq(obsVpatEntries.versionId, version.id)))
      .orderBy(asc(obsFrameworks.sortOrder), asc(obsControls.sortOrder), asc(obsControls.controlId));
    if (entries.length) {
      const byFramework = new Map<string, typeof entries>();
      for (const e of entries) {
        const list = byFramework.get(e.framework.name) ?? [];
        list.push(e);
        byFramework.set(e.framework.name, list);
      }
      vpatSection = [...byFramework.entries()]
        .map(
          ([fw, rows]) => `<h3>${esc(fw)}</h3>
          <table>
            <thead><tr><th style="width:70px">Criterion</th><th>Title</th><th style="width:50px">Level</th><th style="width:140px">Conformance</th><th>Remarks</th></tr></thead>
            <tbody>${rows
              .map(
                (r) => `<tr>
                  <td>${esc(r.control.controlId)}</td>
                  <td>${esc(r.control.title)}</td>
                  <td>${esc(r.control.level ?? "—")}</td>
                  <td>${esc(r.entry.conformance)}</td>
                  <td>${esc(r.entry.remarks ?? "")}</td>
                </tr>`,
              )
              .join("")}</tbody>
          </table>`,
        )
        .join("");
    }
  }

  const body = `
    <div class="disclaimer">${esc(OBS_VPAT_DISCLAIMER)}</div>
    ${aiSummarySection(aiSummary)}
    <h2>Accessibility Findings</h2>
    ${findingsTable(a11yFindings, evidenceByFinding)}
    <h2>WCAG / Section 508 Conformance (VPAT Support Data)</h2>
    ${vpatSection}
    <div class="disclaimer">${esc(OBS_VPAT_DISCLAIMER)}</div>
  `;
  return reportShell(`Accessibility Report — ${application.name}`, `${version ? `Version ${version.versionNumber} · ` : ""}WCAG 2.2 / Section 508 mapping with VPAT support data`, body);
}

async function renderPenTest(tenantDomain: string, data: ReportData, aiSummary: string | null): Promise<string> {
  const { application, version, assessments, findings, evidenceByFinding } = data;
  const ptAssessments = assessments.filter((a) => a.type === "penetration_test");
  const ptAssessmentIds = ptAssessments.map((a) => a.id);
  const penTests = ptAssessmentIds.length
    ? await db
        .select()
        .from(obsPenTests)
        .where(and(eq(obsPenTests.tenantDomain, tenantDomain), inArray(obsPenTests.assessmentId, ptAssessmentIds)))
    : [];
  const ptFindingExt = await db
    .select()
    .from(obsPenTestFindings)
    .where(
      and(
        eq(obsPenTestFindings.tenantDomain, tenantDomain),
        penTests.length ? inArray(obsPenTestFindings.penTestId, penTests.map((p) => p.id)) : eq(obsPenTestFindings.penTestId, "__none__"),
      ),
    );
  const extByFinding = new Map(ptFindingExt.map((e) => [e.findingId, e]));
  const findingById = new Map(findings.map((f) => [f.id, f]));

  // Render sections from formal pen-test engagement records (obsPenTests)
  const sectionsFromEngagements = penTests
    .map((pt) => {
      const assessment = ptAssessments.find((a) => a.id === pt.assessmentId);
      const ptFindings = ptFindingExt.filter((e) => e.penTestId === pt.id).map((e) => findingById.get(e.findingId)).filter(Boolean) as ObsFinding[];
      const rows = ptFindings
        .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
        .map((f) => {
          const ext = extByFinding.get(f.id)!;
          const ev = evidenceByFinding.get(f.id) ?? [];
          return `<tr>
            <td>${severityChip(f.severity)}${ext.cvssScore != null ? `<br><span class="meta">CVSS ${ext.cvssScore}</span>` : ""}</td>
            <td><strong>${esc(f.title)}</strong>${f.description ? `<br><span class="meta">${esc(f.description).slice(0, 300)}</span>` : ""}</td>
            <td>${esc(ext.exploitability ?? "—")}</td>
            <td>${esc(ext.validationStatus)}${ext.validatedBy ? `<br><span class="meta">${esc(ext.validatedBy)}</span>` : ""}</td>
            <td>${esc(statusLabel(f.status))}</td>
            <td>${ev.length ? `<ul class="evidence-list">${ev.map((e) => `<li>${esc(e.title)}</li>`).join("")}</ul>` : `<span class="meta">None</span>`}</td>
          </tr>`;
        })
        .join("");
      return `<h3>${esc(pt.testName)} <span class="meta">${pt.firm ? `· ${esc(pt.firm)}` : ""}${pt.methodology ? ` · ${esc(pt.methodology)}` : ""}</span></h3>
        <p class="meta">${fmtDate(pt.startDate)} – ${fmtDate(pt.endDate)} · Result: <strong>${esc(pt.result ?? "In progress")}</strong>${assessment ? ` · ${esc(statusLabel(assessment.status))}` : ""}</p>
        ${pt.executiveSummary ? `<div class="callout">${esc(pt.executiveSummary)}</div>` : ""}
        ${rows ? `<table><thead><tr><th style="width:90px">Severity</th><th>Finding</th><th style="width:80px">Exploitability</th><th style="width:100px">Validation</th><th style="width:85px">Status</th><th style="width:170px">Evidence</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="meta">No pen-test findings recorded.</p>`}`;
    })
    .join("");

  // For any penetration_test assessments that have no formal engagement record yet,
  // fall back to rendering their findings directly from obs_findings.
  const assessmentIdsWithEngagement = new Set(penTests.map((pt) => pt.assessmentId));
  const unlinkedPtAssessments = ptAssessments.filter((a) => !assessmentIdsWithEngagement.has(a.id));
  const sectionsFromAssessments = unlinkedPtAssessments
    .map((a) => {
      const aFindings = findings
        .filter((f) => f.assessmentId === a.id)
        .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
      const rows = aFindings
        .map((f) => {
          const ev = evidenceByFinding.get(f.id) ?? [];
          return `<tr>
            <td>${severityChip(f.severity)}</td>
            <td><strong>${esc(f.title)}</strong>${f.description ? `<br><span class="meta">${esc(f.description).slice(0, 300)}</span>` : ""}</td>
            <td>${esc(statusLabel(f.status))}</td>
            <td>${ev.length ? `<ul class="evidence-list">${ev.map((e) => `<li>${esc(e.title)}</li>`).join("")}</ul>` : `<span class="meta">None</span>`}</td>
          </tr>`;
        })
        .join("");
      return `<h3>${esc(a.title)} <span class="meta">· ${esc(statusLabel(a.status))}</span></h3>
        ${a.startDate ? `<p class="meta">Started ${fmtDate(a.startDate)}${a.assessorName ? ` · ${esc(a.assessorName)}${a.assessorOrg ? `, ${esc(a.assessorOrg)}` : ""}` : ""}</p>` : ""}
        ${rows ? `<table><thead><tr><th style="width:90px">Severity</th><th>Finding</th><th style="width:85px">Status</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="meta">No findings recorded yet.</p>`}`;
    })
    .join("");

  const sections = sectionsFromEngagements + sectionsFromAssessments;

  const body = `
    ${aiSummarySection(aiSummary)}
    <h2>Penetration Tests</h2>
    ${sections || `<p class="meta">No penetration tests recorded for this ${version ? "version" : "application"}.</p>`}
  `;
  return reportShell(`Penetration Test Report — ${application.name}`, `${version ? `Version ${version.versionNumber}` : "All versions"}`, body);
}

function renderCertificationReadiness(data: ReportData, aiSummary: string | null): string {
  const { application, version, assessments, readiness, findings, evidenceByFinding } = data;
  const blockers = (readiness?.blockers ?? []) as ObsReadinessBlocker[];
  const openCritical = findings.filter((f) => f.severity === "Critical" && ["open", "in_progress"].includes(f.status));
  const assessmentRows = assessments
    .map(
      (a) => `<tr>
        <td>${esc(a.title)}</td>
        <td>${esc(statusLabel(a.type))}</td>
        <td>${esc(statusLabel(a.status))}</td>
        <td>${a.overallScore ?? "—"}</td>
        <td>${fmtDate(a.endDate)}</td>
      </tr>`,
    )
    .join("");
  const verdict = readiness
    ? readiness.blocked
      ? `<div class="blocker"><strong>NO-GO:</strong> ${blockers.length} hard blocker${blockers.length === 1 ? "" : "s"} must be resolved before certification.</div>`
      : readiness.band === "Ready"
        ? `<div class="callout" style="border-left:4px solid #16a34a"><strong>GO:</strong> This version meets the readiness bar (${readiness.overallScore}/100).</div>`
        : `<div class="callout" style="border-left:4px solid #ca8a04"><strong>CONDITIONAL:</strong> Score ${readiness.overallScore}/100 (${esc(readiness.band)}). Remediate before certification.</div>`
    : "";
  const body = `
    ${aiSummarySection(aiSummary)}
    <h2>Certification Verdict</h2>
    ${verdict}
    ${application.certificationTarget ? `<p class="meta">Certification target: <strong>${esc(application.certificationTarget)}</strong></p>` : ""}
    <h2>Readiness Score</h2>
    ${readinessSection(readiness, version?.versionNumber)}
    <h2>Assessment Coverage</h2>
    ${assessmentRows ? `<table><thead><tr><th>Assessment</th><th>Type</th><th>Status</th><th>Score</th><th>Completed</th></tr></thead><tbody>${assessmentRows}</tbody></table>` : `<p class="meta">No assessments recorded.</p>`}
    <h2>Critical Findings Requiring Action</h2>
    ${findingsTable(openCritical, evidenceByFinding)}
  `;
  return reportShell(`Certification Readiness Report — ${application.name}`, `${version ? `Version ${version.versionNumber}` : "Latest version"}`, body);
}

// ── AI executive summary ────────────────────────────────────────────────────

async function draftExecutiveSummary(tenantDomain: string, reportType: ObsReportType, data: ReportData): Promise<string | null> {
  try {
    const { application, version, assessments, findings, readiness } = data;
    const open = findings.filter((f) => ["open", "in_progress"].includes(f.status));
    const bySeverity = SEVERITY_ORDER.map((s) => `${s}: ${open.filter((f) => f.severity === s).length}`).join(", ");
    const blockers = ((readiness?.blockers ?? []) as ObsReadinessBlocker[]).map((b) => `- ${b.reason}`).join("\n");
    const prompt = `Write a concise executive summary (3–4 short paragraphs, plain prose, no headings or bullet lists) for a "${OBS_REPORT_TYPE_LABELS[reportType]}" about the application "${application.name}"${version ? ` version ${version.versionNumber}` : ""}.

Facts:
- Readiness score: ${readiness ? `${readiness.overallScore}/100, band "${readiness.band}"${readiness.blocked ? " (hard blockers present)" : ""}` : "not computed"}
- Assessments: ${assessments.length} total (${assessments.filter((a) => a.status === "completed").length} completed)
- Open findings by severity: ${bySeverity}
${blockers ? `- Hard blockers:\n${blockers}` : "- No hard blockers"}

Audience: executives deciding certification/release. Be factual, direct, and avoid marketing language. Do not invent facts.`;
    const result = await completeForFeature(AI_FEATURES.OBSERVATORY_REPORT, prompt, {
      systemPrompt: "You are an application assurance analyst writing executive summaries for readiness reports. Be precise and factual.",
      maxTokens: 1000,
      tenantDomain,
    });
    return result.text.trim();
  } catch (err) {
    console.error("[observatory-reports] AI summary failed (continuing without):", err);
    return null;
  }
}

// ── generation orchestration (async, 202-and-poll) ─────────────────────────

export async function generateReportAsync(reportId: string): Promise<void> {
  void enqueue(
    "analysis",
    `Observatory report ${reportId}`,
    async () => {
      const [report] = await db.select().from(obsReports).where(eq(obsReports.id, reportId));
      if (!report) return;
      try {
        const data = await loadReportData(report.tenantDomain, report.applicationId, report.versionId);
        let aiSummary: string | null = null;
        if (report.includeAiSummary) {
          aiSummary = await draftExecutiveSummary(report.tenantDomain, report.reportType as ObsReportType, data);
        }
        let html: string;
        switch (report.reportType as ObsReportType) {
          case "executive_readiness":
            html = renderExecutiveReadiness(data, aiSummary);
            break;
          case "technical_assessment":
            html = renderTechnicalAssessment(data, aiSummary);
            break;
          case "accessibility_vpat":
            html = await renderAccessibilityVpat(report.tenantDomain, data, aiSummary);
            break;
          case "pen_test":
            html = await renderPenTest(report.tenantDomain, data, aiSummary);
            break;
          case "certification_readiness":
            html = renderCertificationReadiness(data, aiSummary);
            break;
          default:
            throw new Error(`Unknown report type: ${report.reportType}`);
        }
        await db
          .update(obsReports)
          .set({ status: "generated", html, aiSummary, generatedAt: new Date(), error: null })
          .where(eq(obsReports.id, reportId));
      } catch (err) {
        console.error(`[observatory-reports] generation failed for ${reportId}:`, err);
        await db
          .update(obsReports)
          .set({ status: "failed", error: err instanceof Error ? err.message : String(err) })
          .where(eq(obsReports.id, reportId));
      }
    },
    { timeoutMs: 3 * 60 * 1000 },
  ).catch((err) => console.error(`[observatory-reports] job enqueue failed for ${reportId}:`, err));
}

/** Render a generated report's stored HTML to PDF via the shared browser pool. */
export async function renderReportPdf(html: string, label: string): Promise<Buffer> {
  return enqueuePdf(label, async () =>
    withPdfPage(async (page) => {
      await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30000 });
      const pdf = await page.pdf({
        format: "letter",
        printBackground: true,
        margin: { top: "0.5in", bottom: "0.5in", left: "0.4in", right: "0.4in" },
      });
      return Buffer.from(pdf);
    }),
  );
}
