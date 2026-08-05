import { storage, type ContextFilter } from "../storage";
import Anthropic from "@anthropic-ai/sdk";
import type { Activity, Competitor, CompanyProfile, IntelligenceBriefing } from "@shared/schema";
import { buildCompetitorDocumentContextForCompetitors } from "./competitor-document-context";

const anthropic = new Anthropic({
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
});

export interface BriefingTheme {
  title: string;
  description: string;
  competitors: string[];
  significance: "high" | "medium" | "low";
}

export interface CompetitorMovement {
  name: string;
  signals: string[];
  interpretation: string;
  threatLevel: "high" | "medium" | "low" | "none";
}

export interface ActionItem {
  title: string;
  description: string;
  urgency: "immediate" | "this_week" | "this_month" | "watch";
  category: "messaging" | "product" | "marketing" | "pricing" | "strategy" | "content";
  relatedCompetitors: string[];
}

export interface RiskAlert {
  title: string;
  description: string;
  severity: "critical" | "warning" | "watch";
  source: string;
}

/** @deprecated kept for schema compatibility — no longer populated */
export interface NewsArticleBrief {
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string;
  matchedEntity: string;
}

export interface BriefingData {
  executiveSummary: string;
  keyThemes: BriefingTheme[];
  competitorMovements: CompetitorMovement[];
  actionItems: ActionItem[];
  riskAlerts: RiskAlert[];
  signalDigest: {
    totalSignals: number;
    byType: Record<string, number>;
    byImpact: Record<string, number>;
    highlights: string[];
  };
  newsArticles: NewsArticleBrief[];
  periodLabel: string;
  generatedAt: string;
}

function stripBaselineFromBriefing(parsed: any, baselineName?: string): { movements: any[]; themes: any[] } {
  let movements = Array.isArray(parsed.competitorMovements) ? parsed.competitorMovements : [];
  let themes = Array.isArray(parsed.keyThemes) ? parsed.keyThemes : [];
  if (baselineName) {
    const baselineLower = baselineName.toLowerCase();
    movements = movements.filter(
      (m: any) => m.name?.toLowerCase() !== baselineLower
    );
    themes = themes.map((t: any) => ({
      ...t,
      competitors: Array.isArray(t.competitors)
        ? t.competitors.filter((c: string) => c.toLowerCase() !== baselineLower)
        : t.competitors,
    }));
  }
  return { movements, themes };
}

function formatActivityGroup(acts: Activity[]): string[] {
  const lines: string[] = [];
  const scored = acts.filter((a) => typeof a.sentimentScore === "number");
  if (scored.length > 0) {
    const meanSentiment = scored.reduce((s, a) => s + (a.sentimentScore || 0), 0) / scored.length;
    const toneCounts: Record<string, number> = {};
    for (const a of scored) {
      if (a.toneLabel) toneCounts[a.toneLabel] = (toneCounts[a.toneLabel] || 0) + 1;
    }
    const dominantTone = Object.entries(toneCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    lines.push(
      `  Tone snapshot: mean sentiment ${meanSentiment.toFixed(2)} (n=${scored.length})${dominantTone ? `, dominant tone "${dominantTone}"` : ""}.`,
    );
  }
  for (const act of acts) {
    const details = act.details as any;
    const changeAnalysis = details?.changeAnalysis;
    lines.push(`- **${act.type}** [Impact: ${act.impact}]: ${act.description}`);
    if (act.summary) lines.push(`  Summary: ${act.summary}`);
    if (typeof act.sentimentScore === "number" && act.toneLabel) {
      lines.push(`  Tone: ${act.toneLabel} (sentiment ${act.sentimentScore.toFixed(2)})${act.toneNote ? ` — ${act.toneNote}` : ""}`);
    }
    if (changeAnalysis?.changes?.length > 0) {
      for (const change of changeAnalysis.changes.slice(0, 3)) {
        lines.push(`  - [${change.category}/${change.significance}] ${change.description}`);
      }
    }
  }
  return lines;
}

function buildSignalSummary(activities: Activity[]): string {
  if (activities.length === 0) return "No signals detected during this period.";

  // Separate the client's OWN signals (their website baseline + their own
  // product pages) from competitor signals so the AI cannot confuse them and
  // generate competitor-facing action items — or false "abandoning X" risk
  // alerts — from the client's own-site/product monitoring events. Product
  // signals are about the client's OWN offerings, so they belong with baseline,
  // NOT with competitors.
  const OWN_SOURCE_TYPES = new Set(["baseline", "product"]);
  const competitorActivities = activities.filter(a => !OWN_SOURCE_TYPES.has(a.sourceType ?? ""));
  const ownActivities        = activities.filter(a => OWN_SOURCE_TYPES.has(a.sourceType ?? ""));

  const lines: string[] = [];

  // ── Competitor signals ──────────────────────────────────────────────────────
  if (competitorActivities.length > 0) {
    const byCompetitor: Record<string, Activity[]> = {};
    for (const act of competitorActivities) {
      const name = act.competitorName || "Unknown";
      if (!byCompetitor[name]) byCompetitor[name] = [];
      byCompetitor[name].push(act);
    }
    for (const [name, acts] of Object.entries(byCompetitor)) {
      lines.push(`\n### ${name} (${acts.length} signal${acts.length > 1 ? "s" : ""})`);
      lines.push(...formatActivityGroup(acts));
    }
  }

  // ── Own website + product signals — situational awareness only ─────────────
  // IMPORTANT FOR AI: These signals are about YOUR OWN COMPANY's website and its
  // OWN product/offering pages, not a competitor. Do NOT create competitorMovement
  // entries, action items, or risk alerts based on these signals. Do NOT treat
  // changes to your own website as a competitor opportunity. Use these only for
  // self-positioning context.
  if (ownActivities.length > 0) {
    lines.push(`\n---`);
    lines.push(`\n## OWN WEBSITE & PRODUCT CHANGES — SITUATIONAL AWARENESS ONLY`);
    lines.push(`NOTE FOR ANALYST: The following signals are about YOUR CLIENT'S OWN website and OWN product/offering pages (the baseline company), NOT a competitor. Do NOT generate any competitorMovements, actionItems, or riskAlerts from these signals. They are provided purely as context about the client's own site updates.`);
    lines.push(`CRITICAL — DO NOT MISREAD MONITORING ARTIFACTS AS STRATEGY: A "% change detected" number is a raw text-diff from an automated crawler, NOT evidence of a deliberate business decision. A high percentage almost always means a site redesign, CMS migration, navigation change, or a partial/failed crawl — it does NOT mean the client "removed", "abandoned", "pivoted away from", "deprioritized", or "walked back" that topic. NEVER infer that the client is retreating from any offering (e.g. AI, a product line, a service) from a change percentage, a missing page, or a failed/near-empty crawl of their own site. Only describe the client's positioning from the described positioning context, never from these change numbers.`);
    const byName: Record<string, Activity[]> = {};
    for (const act of ownActivities) {
      const name = act.competitorName || "Own website";
      if (!byName[name]) byName[name] = [];
      byName[name].push(act);
    }
    for (const [name, acts] of Object.entries(byName)) {
      lines.push(`\n### [OWN SITE] ${name} (${acts.length} signal${acts.length > 1 ? "s" : ""})`);
      lines.push(...formatActivityGroup(acts));
    }
  }

  return lines.join("\n");
}

function buildCompetitorContext(competitors: Competitor[], baseline?: CompanyProfile): string {
  const lines: string[] = [];

  if (baseline) {
    lines.push(`\n## YOUR COMPANY: ${baseline.companyName}`);
    lines.push(`Website: ${baseline.websiteUrl}`);
    if (baseline.industry) lines.push(`Industry: ${baseline.industry}`);
  }

  lines.push(`\n## TRACKED COMPETITORS (${competitors.length}):`);
  for (const comp of competitors) {
    lines.push(`- **${comp.name}** (${comp.url})`);
    if (comp.industry) lines.push(`  Industry: ${comp.industry}`);
    if (comp.employeeCount) lines.push(`  Size: ~${comp.employeeCount} employees`);
  }

  return lines.join("\n");
}

export async function generateBriefing(
  tenantDomain: string,
  periodDays: number = 7,
  marketId?: string,
  ctx?: ContextFilter
): Promise<IntelligenceBriefing> {
  const now = new Date();
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - periodDays);

  let activities: Activity[];
  let competitors: Competitor[];
  let baseline: CompanyProfile | undefined;

  if (ctx) {
    [activities, competitors, baseline] = await Promise.all([
      storage.getActivityByTenantForPeriod(tenantDomain, periodDays, marketId),
      storage.getCompetitorsByContext(ctx),
      storage.getCompanyProfileByContext(ctx).then(p => p || undefined),
    ]);
  } else if (marketId) {
    [activities, competitors, baseline] = await Promise.all([
      storage.getActivityByTenantForPeriod(tenantDomain, periodDays, marketId),
      storage.getCompetitorsByMarket(tenantDomain, marketId),
      storage.getCompanyProfileByTenant(tenantDomain),
    ]);
  } else {
    [activities, competitors, baseline] = await Promise.all([
      storage.getActivityByTenantForPeriod(tenantDomain, periodDays, marketId),
      storage.getCompetitorsByTenantDomain(tenantDomain),
      storage.getCompanyProfileByTenant(tenantDomain),
    ]);
  }

  const uniqueCompetitorIds = new Set(
    activities.filter(a => a.competitorId).map(a => a.competitorId)
  );

  const signalSummary = buildSignalSummary(activities);
  const competitorContext = buildCompetitorContext(competitors, baseline || undefined);
  const noCompetitorsTracked = competitors.length === 0;

  // Competitor uploaded documents grounding
  const competitorDocCtx = await buildCompetitorDocumentContextForCompetitors(
    tenantDomain,
    competitors.map((c) => c.id),
  );
  const competitorDocsSection = competitorDocCtx.context
    ? `\n${competitorDocCtx.context.slice(0, 10000)}\n`
    : "";

  const periodLabel = periodDays === 7 
    ? "Weekly" 
    : periodDays === 14 
      ? "Bi-Weekly" 
      : `${periodDays}-Day`;

  const prompt = `You are a senior competitive intelligence analyst producing a ${periodLabel} Market Intelligence Briefing for ${baseline?.companyName || tenantDomain}.

${competitorContext}
${competitorDocsSection}

## SIGNALS DETECTED (${activities.length} total over the past ${periodDays} days):
${signalSummary}

${activities.length === 0 ? `
Note: No signals were detected this period. This could mean competitors are stable, or monitoring coverage needs expansion. Provide a briefing that acknowledges the quiet period and suggests what to watch for based on the competitive landscape.
` : ""}

${noCompetitorsTracked ? `
CRITICAL INSTRUCTION — ZERO COMPETITORS TRACKED:
There are NO tracked competitors for this company. This is a BASELINE-ONLY assessment.
- Do NOT invent, fabricate, or reference any competitor companies by name.
- Do NOT hallucinate competitor movements, scores, or activities.
- The "competitorMovements" array MUST be empty [].
- The "keyThemes" competitors arrays MUST be empty [].
- The "relatedCompetitors" arrays in actionItems MUST be empty [].
- Focus the briefing entirely on the baseline company's own positioning and market observations.
- Clearly state in the executiveSummary that no competitors are currently tracked and this is a baseline-only report.
- Recommend adding competitors as a key action item.
` : ""}

Produce a comprehensive intelligence briefing as JSON with this exact structure:
{
  "executiveSummary": "2-3 paragraphs: What happened this period, what it means strategically, and the overall market direction. Be specific — reference competitor names and concrete changes. End with the single most important takeaway.",
  "keyThemes": [
    {
      "title": "Short theme name (e.g., 'Enterprise Pivot', 'Price Compression')",
      "description": "2-3 sentences explaining this theme and why it matters",
      "competitors": ["Names of competitors exhibiting this theme"],
      "significance": "high|medium|low"
    }
  ],
  "competitorMovements": [
    {
      "name": "Competitor Name",
      "signals": ["List of specific changes observed"],
      "interpretation": "What these moves signal about their strategy — be analytical, not just descriptive",
      "threatLevel": "high|medium|low|none"
    }
  ],
  "actionItems": [
    {
      "title": "Specific action to take",
      "description": "Why this action matters and how to execute it",
      "urgency": "immediate|this_week|this_month|watch",
      "category": "messaging|product|marketing|pricing|strategy|content",
      "relatedCompetitors": ["Which competitor movements triggered this"]
    }
  ],
  "riskAlerts": [
    {
      "title": "Risk title",
      "description": "What the risk is and potential impact",
      "severity": "critical|warning|watch",
      "source": "What signal or pattern triggered this alert"
    }
  ],
  "signalDigest": {
    "totalSignals": ${activities.length},
    "byType": {},
    "byImpact": {},
    "highlights": ["Top 3-5 most noteworthy individual signals as brief descriptions"]
  }
}

Rules:
- Be strategic and analytical, not just descriptive. "So what?" matters more than "what."
- Action items must be specific enough to act on — not vague advice like "monitor closely."
- If there are no signals, still produce themes based on the competitive landscape and suggest proactive actions.
- Provide 3-5 key themes, movements for each active competitor, 3-5 action items, and risk alerts only when warranted.
- NEVER raise a riskAlert (or any theme/action) claiming the client is removing, abandoning, pivoting away from, deprioritizing, or walking back one of their OWN offerings based on a website/product "% change detected" signal, a missing page, or a failed/near-empty crawl. Those are automated-crawler artifacts, not strategic decisions. Own-site/own-product signals in the "OWN WEBSITE & PRODUCT CHANGES" section are situational awareness only.
- CRITICAL: "${baseline?.companyName || tenantDomain}" is YOUR company / the baseline — the company receiving this briefing. NEVER list it as a competitor. Do NOT include "${baseline?.companyName || tenantDomain}" in the "competitors" arrays in keyThemes, do NOT create a competitorMovement entry for it, and do NOT reference it as a competitor anywhere. It should only appear as "your company" or "your organization" when discussing your own positioning. The competitorMovements array must ONLY contain entries for actual tracked competitors, never the baseline company.
- CRITICAL: You may ONLY reference the following competitor names in the briefing. Do NOT invent, fabricate, or reference any company not in this list: [${competitors.map(c => `"${c.name}"`).join(", ")}]. Every name in competitorMovements, keyThemes.competitors, and actionItems.relatedCompetitors MUST come from this exact list.
- Return ONLY valid JSON, no markdown code fences.`;

  const allowedCompetitorNames = new Set(competitors.map(c => c.name.toLowerCase()));

  let briefingData: BriefingData;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = response.content.find(block => block.type === "text");
    let raw = textBlock?.text || "";

    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    const parsed = JSON.parse(raw);

    const byType: Record<string, number> = {};
    const byImpact: Record<string, number> = {};
    for (const act of activities) {
      byType[act.type] = (byType[act.type] || 0) + 1;
      byImpact[act.impact || "Low"] = (byImpact[act.impact || "Low"] || 0) + 1;
    }

    const { movements, themes } = stripBaselineFromBriefing(parsed, baseline?.companyName);

    const filteredMovements = movements.filter(
      (m: any) => m.name && typeof m.name === "string" && allowedCompetitorNames.has(m.name.toLowerCase())
    );
    const filteredThemes = themes.map((t: any) => ({
      ...t,
      competitors: Array.isArray(t.competitors)
        ? t.competitors.filter((c: any) => typeof c === "string" && allowedCompetitorNames.has(c.toLowerCase()))
        : t.competitors,
    }));
    const baselineNameLower = baseline?.companyName?.toLowerCase();
    const filteredActionItems = (Array.isArray(parsed.actionItems) ? parsed.actionItems : [])
      .map((item: any) => ({
        ...item,
        relatedCompetitors: Array.isArray(item.relatedCompetitors)
          ? item.relatedCompetitors.filter((c: any) => typeof c === "string" && allowedCompetitorNames.has(c.toLowerCase()))
          : item.relatedCompetitors,
      }))
      // Hard guard: remove any action item whose title or relatedCompetitors
      // reference the baseline (own) company — this catches hallucinated
      // "capitalize on your own company's pivot" tasks generated from own-site
      // change signals that leaked into the prompt as competitor signals.
      .filter((item: any) => {
        if (!baselineNameLower) return true;
        const titleLower = (item.title || "").toLowerCase();
        if (titleLower.includes(baselineNameLower)) return false;
        if (Array.isArray(item.relatedCompetitors) &&
            item.relatedCompetitors.some((c: any) => typeof c === "string" && c.toLowerCase() === baselineNameLower)) {
          return false;
        }
        return true;
      });

    briefingData = {
      executiveSummary: parsed.executiveSummary || "Briefing generation completed but summary was empty.",
      keyThemes: filteredThemes,
      competitorMovements: filteredMovements,
      actionItems: filteredActionItems,
      riskAlerts: Array.isArray(parsed.riskAlerts) ? parsed.riskAlerts : [],
      signalDigest: {
        totalSignals: activities.length,
        byType,
        byImpact,
        highlights: parsed.signalDigest?.highlights || [],
      },
      newsArticles: [],
      periodLabel,
      generatedAt: now.toISOString(),
    };
  } catch (error: any) {
    console.error("Error generating intelligence briefing:", error);

    const byType: Record<string, number> = {};
    const byImpact: Record<string, number> = {};
    for (const act of activities) {
      byType[act.type] = (byType[act.type] || 0) + 1;
      byImpact[act.impact || "Low"] = (byImpact[act.impact || "Low"] || 0) + 1;
    }

    briefingData = {
      executiveSummary: `Intelligence briefing generation encountered an error. ${activities.length} signals were collected over the past ${periodDays} days across ${uniqueCompetitorIds.size} competitors but could not be synthesized. Please try generating again.`,
      keyThemes: [],
      competitorMovements: [],
      actionItems: [{
        title: "Retry briefing generation",
        description: "The AI analysis failed. Try generating a new briefing or review the raw activity log for recent signals.",
        urgency: "this_week" as const,
        category: "strategy" as const,
        relatedCompetitors: [],
      }],
      riskAlerts: [],
      signalDigest: {
        totalSignals: activities.length,
        byType,
        byImpact,
        highlights: [],
      },
      newsArticles: [],
      periodLabel,
      generatedAt: now.toISOString(),
    };
  }

  const briefing = await storage.createIntelligenceBriefing({
    tenantDomain,
    marketId: marketId || null,
    periodStart,
    periodEnd: now,
    status: "published",
    briefingData,
    signalCount: activities.length,
    competitorCount: uniqueCompetitorIds.size,
  });

  // Canonical fan-out point for "briefing ready" — every code path that
  // produces a briefing flows through here, so on-demand and scheduled
  // briefings both notify configured channels exactly once.
  try {
    const { notifications } = await import("./notifications");
    await notifications.dispatch(tenantDomain, "briefing_ready", {
      briefingId: briefing.id,
      marketId: marketId || null,
      periodLabel: briefingData.periodLabel,
      executiveSummary: briefingData.executiveSummary,
      actionItemCount: (briefingData.actionItems || []).length,
      riskAlertCount: (briefingData.riskAlerts || []).length,
    });
  } catch (notifyErr) {
    console.error("[Intelligence Briefing] Notification dispatch failed:", notifyErr);
  }

  // Task #100/#112: best-effort auto-push of new briefing to HubSpot
  // Companies (Notes attached to each related competitor's matched company).
  // Plan gating + connection state + auto-push toggle are checked inside the
  // helper. Never throws.
  void autoPushBriefingToHubspot({
    tenantDomain,
    briefingId: briefing.id,
    briefingData,
    competitorIds: Array.from(uniqueCompetitorIds).filter((x): x is string => typeof x === "string"),
  });

  return briefing;
}

/**
 * Shared HubSpot auto-push entrypoint used by every code path that finalises
 * an intelligence briefing (service-level `generateBriefing` + the on-demand
 * route that uses `generateBriefingData`). Centralising it ensures both
 * paths use the canonical competitor IDs from the generation inputs rather
 * than reconstructing them from AI-rendered names.
 *
 * Plan / connection / auto-push toggle gating live in `autoPushBriefing`.
 * This helper never throws.
 */
export async function autoPushBriefingToHubspot(opts: {
  tenantDomain: string;
  briefingId: string;
  briefingData: BriefingData;
  competitorIds: string[];
}): Promise<void> {
  try {
    const tenant = await storage.getTenantByDomain(opts.tenantDomain);
    if (!tenant?.plan) return;
    const { autoPushBriefing } = await import("./hubspot-integration");

    // Map AI action-item `relatedCompetitors` (names) to the closest
    // competitor ID so the helper can attach Tasks to the matched HubSpot
    // Company. The Notes side uses the canonical `competitorIds` list and
    // does not depend on this mapping.
    const competitors = await storage.getCompetitorsByTenantDomain(opts.tenantDomain);
    const nameToId = new Map<string, string>();
    for (const c of competitors) {
      if (c.name) nameToId.set(c.name.toLowerCase(), c.id);
    }

    const actionItemsForPush = (opts.briefingData.actionItems || []).slice(0, 25).map((ai) => {
      // ActionItem is a strict shape; the push pipeline historically reads loose
      // optional fields (`relatedCompetitors`, etc.) that aren't in the canonical
      // type. Cast via unknown to acknowledge the structural mismatch.
      const aiAny = ai as unknown as Record<string, unknown>;
      const related = Array.isArray(aiAny.relatedCompetitors)
        ? (aiAny.relatedCompetitors as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const firstName = related[0];
      const competitorId = firstName ? nameToId.get(firstName.toLowerCase()) ?? null : null;
      return {
        title: String(aiAny.title || aiAny.summary || "Action item"),
        rationale: typeof aiAny.rationale === "string"
          ? aiAny.rationale
          : (typeof aiAny.description === "string" ? aiAny.description : ""),
        priority: typeof aiAny.priority === "string"
          ? aiAny.priority
          : (typeof aiAny.urgency === "string" ? (aiAny.urgency as string) : undefined),
        dueAt: aiAny.dueAt ? new Date(String(aiAny.dueAt)) : null,
        competitorId,
      };
    });

    await autoPushBriefing({
      tenantDomain: opts.tenantDomain,
      briefingId: opts.briefingId,
      title: opts.briefingData.periodLabel || "Intelligence briefing",
      executiveSummary: opts.briefingData.executiveSummary || "",
      competitorIds: opts.competitorIds,
      actionItems: actionItemsForPush,
      planName: tenant.plan,
    });
  } catch (pushErr) {
    console.warn(`[Intelligence Briefing] HubSpot auto-push setup failed for ${opts.tenantDomain}:`, pushErr);
    // Persist the setup-time failure on the briefing row too so the same
    // diagnostic surface covers all failure modes (helper-internal failures
    // already write through autoPushBriefing).
    try {
      const message = pushErr instanceof Error ? pushErr.message : String(pushErr);
      await storage.updateIntelligenceBriefing(opts.briefingId, {
        hubspotPushResult: {
          pushed: 0,
          skipped: 0,
          tasksPushed: 0,
          reason: "setup_error",
          error: message,
          at: new Date().toISOString(),
        },
      });
    } catch {
      /* ignore — best-effort */
    }
  }
}

/** Briefing generation phases reported to the UI for progress tracking. */
export type BriefingPhase =
  | "queued"
  | "loading_signals"
  | "synthesising"
  | "finalising"
  | "complete";

export interface BriefingProgress {
  phase: BriefingPhase;
  phaseLabel: string;
  percent: number;
}

export type BriefingProgressReporter = (progress: BriefingProgress) => void;

const PHASE_LABELS: Record<BriefingPhase, string> = {
  queued: "Queued",
  loading_signals: "Loading recent signals",
  synthesising: "Synthesising sections",
  finalising: "Finalising briefing",
  complete: "Complete",
};

const PHASE_PERCENT: Record<BriefingPhase, number> = {
  queued: 2,
  loading_signals: 10,
  synthesising: 60,
  finalising: 92,
  complete: 100,
};

function buildProgress(phase: BriefingPhase): BriefingProgress {
  return { phase, phaseLabel: PHASE_LABELS[phase], percent: PHASE_PERCENT[phase] };
}

export async function generateBriefingData(
  tenantDomain: string,
  periodDays: number = 7,
  marketId?: string,
  ctx?: ContextFilter,
  onProgress?: BriefingProgressReporter,
): Promise<{ briefingData: BriefingData; signalCount: number; competitorCount: number; competitorIds: string[] }> {
  const now = new Date();
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - periodDays);

  const reportPhase = (phase: BriefingPhase) => {
    try {
      onProgress?.(buildProgress(phase));
    } catch (err) {
      console.error("[Intelligence Briefing] Progress reporter error:", err);
    }
  };

  reportPhase("loading_signals");

  let activities: Activity[];
  let competitors: Competitor[];
  let baseline: CompanyProfile | undefined;

  if (ctx) {
    [activities, competitors, baseline] = await Promise.all([
      storage.getActivityByTenantForPeriod(tenantDomain, periodDays, marketId),
      storage.getCompetitorsByContext(ctx),
      storage.getCompanyProfileByContext(ctx).then(p => p || undefined),
    ]);
  } else if (marketId) {
    [activities, competitors, baseline] = await Promise.all([
      storage.getActivityByTenantForPeriod(tenantDomain, periodDays, marketId),
      storage.getCompetitorsByMarket(tenantDomain, marketId),
      storage.getCompanyProfileByTenant(tenantDomain),
    ]);
  } else {
    [activities, competitors, baseline] = await Promise.all([
      storage.getActivityByTenantForPeriod(tenantDomain, periodDays, marketId),
      storage.getCompetitorsByTenantDomain(tenantDomain),
      storage.getCompanyProfileByTenant(tenantDomain),
    ]);
  }

  reportPhase("synthesising");

  const uniqueCompetitorIds = new Set(
    activities.filter(a => a.competitorId).map(a => a.competitorId)
  );

  const signalSummary = buildSignalSummary(activities);
  const competitorContext = buildCompetitorContext(competitors, baseline || undefined);
  const noCompetitorsTracked = competitors.length === 0;

  // Competitor uploaded documents grounding
  const competitorDocCtx = await buildCompetitorDocumentContextForCompetitors(
    tenantDomain,
    competitors.map((c) => c.id),
  );
  const competitorDocsSection = competitorDocCtx.context
    ? `\n${competitorDocCtx.context.slice(0, 10000)}\n`
    : "";

  const periodLabel = periodDays === 7 
    ? "Weekly" 
    : periodDays === 14 
      ? "Bi-Weekly" 
      : `${periodDays}-Day`;

  const prompt = `You are a senior competitive intelligence analyst producing a ${periodLabel} Market Intelligence Briefing for ${baseline?.companyName || tenantDomain}.

${competitorContext}
${competitorDocsSection}

## SIGNALS DETECTED (${activities.length} total over the past ${periodDays} days):
${signalSummary}

${activities.length === 0 ? `
Note: No signals were detected this period. This could mean competitors are stable, or monitoring coverage needs expansion. Provide a briefing that acknowledges the quiet period and suggests what to watch for based on the competitive landscape.
` : ""}

${noCompetitorsTracked ? `
CRITICAL INSTRUCTION — ZERO COMPETITORS TRACKED:
There are NO tracked competitors for this company. This is a BASELINE-ONLY assessment.
- Do NOT invent, fabricate, or reference any competitor companies by name.
- Do NOT hallucinate competitor movements, scores, or activities.
- The "competitorMovements" array MUST be empty [].
- The "keyThemes" competitors arrays MUST be empty [].
- The "relatedCompetitors" arrays in actionItems MUST be empty [].
- Focus the briefing entirely on the baseline company's own positioning and market observations.
- Clearly state in the executiveSummary that no competitors are currently tracked and this is a baseline-only report.
- Recommend adding competitors as a key action item.
` : ""}

Produce a comprehensive intelligence briefing as JSON with this exact structure:
{
  "executiveSummary": "2-3 paragraphs: What happened this period, what it means strategically, and the overall market direction. Be specific — reference competitor names and concrete changes. End with the single most important takeaway.",
  "keyThemes": [
    {
      "title": "Short theme name (e.g., 'Enterprise Pivot', 'Price Compression')",
      "description": "2-3 sentences explaining this theme and why it matters",
      "competitors": ["Names of competitors exhibiting this theme"],
      "significance": "high|medium|low"
    }
  ],
  "competitorMovements": [
    {
      "name": "Competitor Name",
      "signals": ["List of specific changes observed"],
      "interpretation": "What these moves signal about their strategy — be analytical, not just descriptive",
      "threatLevel": "high|medium|low|none"
    }
  ],
  "actionItems": [
    {
      "title": "Specific action to take",
      "description": "Why this action matters and how to execute it",
      "urgency": "immediate|this_week|this_month|watch",
      "category": "messaging|product|marketing|pricing|strategy|content",
      "relatedCompetitors": ["Which competitor movements triggered this"]
    }
  ],
  "riskAlerts": [
    {
      "title": "Risk title",
      "description": "What the risk is and potential impact",
      "severity": "critical|warning|watch",
      "source": "What signal or pattern triggered this alert"
    }
  ],
  "signalDigest": {
    "totalSignals": ${activities.length},
    "byType": {},
    "byImpact": {},
    "highlights": ["Top 3-5 most noteworthy individual signals as brief descriptions"]
  }
}

Rules:
- Be strategic and analytical, not just descriptive. "So what?" matters more than "what."
- Action items must be specific enough to act on — not vague advice like "monitor closely."
- If there are no signals, still produce themes based on the competitive landscape and suggest proactive actions.
- Provide 3-5 key themes, movements for each active competitor, 3-5 action items, and risk alerts only when warranted.
- NEVER raise a riskAlert (or any theme/action) claiming the client is removing, abandoning, pivoting away from, deprioritizing, or walking back one of their OWN offerings based on a website/product "% change detected" signal, a missing page, or a failed/near-empty crawl. Those are automated-crawler artifacts, not strategic decisions. Own-site/own-product signals in the "OWN WEBSITE & PRODUCT CHANGES" section are situational awareness only.
- CRITICAL: "${baseline?.companyName || tenantDomain}" is YOUR company / the baseline — the company receiving this briefing. NEVER list it as a competitor. Do NOT include "${baseline?.companyName || tenantDomain}" in the "competitors" arrays in keyThemes, do NOT create a competitorMovement entry for it, and do NOT reference it as a competitor anywhere. It should only appear as "your company" or "your organization" when discussing your own positioning. The competitorMovements array must ONLY contain entries for actual tracked competitors, never the baseline company.
- CRITICAL: You may ONLY reference the following competitor names in the briefing. Do NOT invent, fabricate, or reference any company not in this list: [${competitors.map(c => `"${c.name}"`).join(", ")}]. Every name in competitorMovements, keyThemes.competitors, and actionItems.relatedCompetitors MUST come from this exact list.
- Return ONLY valid JSON, no markdown code fences.`;

  const allowedNames = new Set(competitors.map(c => c.name.toLowerCase()));

  let briefingData: BriefingData;

  try {
    reportPhase("synthesising");
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = response.content.find(block => block.type === "text");
    let raw = textBlock?.text || "";

    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    const parsed = JSON.parse(raw);

    reportPhase("finalising");

    const byType: Record<string, number> = {};
    const byImpact: Record<string, number> = {};
    for (const act of activities) {
      byType[act.type] = (byType[act.type] || 0) + 1;
      byImpact[act.impact || "Low"] = (byImpact[act.impact || "Low"] || 0) + 1;
    }

    const rawMovements = Array.isArray(parsed.competitorMovements) ? parsed.competitorMovements : [];
    const rawThemes = Array.isArray(parsed.keyThemes) ? parsed.keyThemes : [];
    const rawActionItems = Array.isArray(parsed.actionItems) ? parsed.actionItems : [];

    briefingData = {
      executiveSummary: parsed.executiveSummary || "Briefing generation completed but summary was empty.",
      keyThemes: rawThemes.map((t: any) => ({
        ...t,
        competitors: Array.isArray(t.competitors)
          ? t.competitors.filter((c: any) => typeof c === "string" && allowedNames.has(c.toLowerCase()))
          : t.competitors,
      })),
      competitorMovements: rawMovements.filter((m: any) => m.name && typeof m.name === "string" && allowedNames.has(m.name.toLowerCase())),
      actionItems: rawActionItems.map((item: any) => ({
        ...item,
        relatedCompetitors: Array.isArray(item.relatedCompetitors)
          ? item.relatedCompetitors.filter((c: any) => typeof c === "string" && allowedNames.has(c.toLowerCase()))
          : item.relatedCompetitors,
      })),
      riskAlerts: Array.isArray(parsed.riskAlerts) ? parsed.riskAlerts : [],
      signalDigest: {
        totalSignals: activities.length,
        byType,
        byImpact,
        highlights: parsed.signalDigest?.highlights || [],
      },
      newsArticles: [],
      periodLabel,
      generatedAt: now.toISOString(),
    };

    reportPhase("complete");
  } catch (error: any) {
    console.error("Error generating intelligence briefing data:", error);
    throw error;
  }

  return {
    briefingData,
    signalCount: activities.length,
    competitorCount: uniqueCompetitorIds.size,
    competitorIds: Array.from(uniqueCompetitorIds).filter((x): x is string => typeof x === "string"),
  };
}
