/**
 * Campaign Ideation Service
 *
 * Combines the company's strategic grounding (with uploaded MPF/GTM taking
 * precedence over generated), the most recent intelligence-report indicators +
 * action items
 * into several candidate campaign ideas the user can adopt or bypass.
 */

import { storage } from "../storage";
import { loadStrategicContext, formatStrategicContextForPrompt } from "./strategic-context";
import { completeForFeature } from "./ai-provider";
import {
  buildIdeationPrompt,
  parseCampaignIdeas,
  getIdeationSystemPrompt,
  type CampaignIdea,
} from "./campaign-ideation-core";

export interface IdeateParams {
  tenantDomain: string;
  marketId?: string;
  isDefaultMarket?: boolean;
  message?: string;
  subjects?: string[];
  count?: number;
}

export interface IdeateResult {
  ideas: CampaignIdea[];
  intelAsOf: string | null;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

/**
 * Reads the most recent published intelligence briefing and formats its market
 * indicators (key themes, risk alerts, signal highlights) plus action items
 * into a prompt block. Returns { block, asOf }.
 */
async function loadIntelIndicators(
  tenantDomain: string,
  marketId?: string,
): Promise<{ block: string; asOf: string | null }> {
  const briefing = await storage.getLatestBriefingForTenant(tenantDomain, marketId);
  if (!briefing || briefing.status !== "published") return { block: "", asOf: null };

  const data = briefing.briefingData as any;
  if (!data) return { block: "", asOf: null };

  const parts: string[] = [];

  if (Array.isArray(data.keyThemes) && data.keyThemes.length) {
    const themes = data.keyThemes
      .slice(0, 5)
      .map((t: any) => `- ${t.title}${t.description ? `: ${String(t.description).slice(0, 160)}` : ""}`)
      .join("\n");
    parts.push(`Key market themes:\n${themes}`);
  }

  if (Array.isArray(data.riskAlerts) && data.riskAlerts.length) {
    const risks = data.riskAlerts
      .slice(0, 4)
      .map((r: any) => `- [${r.severity ?? "watch"}] ${r.title}`)
      .join("\n");
    parts.push(`Risk alerts:\n${risks}`);
  }

  if (data.signalDigest?.highlights?.length) {
    const hi = data.signalDigest.highlights.slice(0, 5).map((h: string) => `- ${h}`).join("\n");
    parts.push(`Signal highlights:\n${hi}`);
  }

  if (Array.isArray(data.actionItems) && data.actionItems.length) {
    const items = data.actionItems
      .slice(0, 8)
      .map((a: any) => `- [${a.urgency ?? "watch"}/${a.category ?? "strategy"}] ${a.title}${a.description ? `: ${String(a.description).slice(0, 150)}` : ""}`)
      .join("\n");
    parts.push(`Recommended action items:\n${items}`);
  }

  const asOf = data.generatedAt || (briefing.createdAt ? new Date(briefing.createdAt).toISOString() : null);
  if (parts.length === 0) return { block: "", asOf };

  return {
    block: `## Latest intelligence report indicators${asOf ? ` (as of ${asOf.slice(0, 10)})` : ""}\n${parts.join("\n\n")}`,
    asOf,
  };
}

export async function ideateCampaigns(params: IdeateParams): Promise<IdeateResult> {
  const count = Math.min(Math.max(params.count ?? 4, 2), 6);

  const strategicCtx = await loadStrategicContext(
    params.tenantDomain,
    params.marketId,
    params.isDefaultMarket,
  );
  const strategicBlock = formatStrategicContextForPrompt(strategicCtx);

  const { block: intelBlock, asOf } = await loadIntelIndicators(params.tenantDomain, params.marketId);

  const prompt = buildIdeationPrompt({
    message: params.message,
    strategicBlock,
    intelBlock,
    count,
  });

  const result = await completeForFeature("marketing_tasks", prompt, {
    tenantDomain: params.tenantDomain,
    systemPrompt: getIdeationSystemPrompt(),
    maxTokens: 4096,
  });

  return {
    ideas: parseCampaignIdeas(result.text),
    intelAsOf: asOf,
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    model: result.model,
  };
}
