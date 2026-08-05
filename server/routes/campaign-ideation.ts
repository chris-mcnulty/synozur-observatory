import type { Express } from "express";
import { getRequestContext } from "../context";
import { guardFeature } from "./helpers";
import { ideateCampaigns } from "../services/campaign-ideation-service";

export function registerCampaignIdeationRoutes(app: Express) {
  // Suggest candidate campaign ideas from grounding + latest intelligence
  // indicators/action items + a news scan of named subjects. The user can
  // adopt an idea (prefilling the campaign form) or bypass it entirely.
  app.post("/api/campaigns/ideate", async (req, res) => {
    try {
      if (!(await guardFeature(req, res, "campaigns"))) return;
      const ctx = await getRequestContext(req);
      const { message, subjects, count } = req.body ?? {};

      const result = await ideateCampaigns({
        tenantDomain: ctx.tenantDomain,
        marketId: ctx.marketId,
        isDefaultMarket: ctx.isDefaultMarket,
        message: typeof message === "string" ? message : undefined,
        subjects: Array.isArray(subjects) ? subjects : undefined,
        count: count ? Number(count) : undefined,
      });

      res.json(result);
    } catch (err: any) {
      console.error("[campaigns ideate]", err);
      res.status(500).json({ error: err.message || "Failed to generate campaign ideas" });
    }
  });
}
