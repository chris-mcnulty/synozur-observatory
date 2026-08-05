import type { Express } from "express";
import { db } from "../db";
import {
  campaigns,
  contentBriefs,
  contentAssets,
  generatedPosts,
  editorialCalendars,
  products,
  productFeatures,
  personas,
  CONTENT_BRIEF_FORMATS,
  type CampaignInterview,
  type CampaignType,
  type ContentBriefFormat,
  CAMPAIGN_TYPES,
} from "@shared/schema";
import { and, asc, desc, eq, ilike, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";
import { getRequestContext } from "../context";
import { guardFeature } from "./helpers";
import { generateInterviewBriefs, generateInterviewSocialPosts } from "../services/brief-interview-service";
import { formatPersonaContextForPrompt } from "../services/strategic-context";
import { draftFromBrief } from "../services/copywriter-service";
import { getPersonalVoiceProfile } from "../services/outbound-voice-service";
import {
  DEFAULT_FUNNEL_TARGETS,
  briefFormatToAssetType,
} from "../services/editorial-calendar-core";
import {
  clampAmplificationEnd,
  suggestReleaseWindows,
  suggestReleaseTempo,
  formatTempoForDisplay,
  distributeDates,
  scheduleAtLocalHour,
  deliverableTitle,
  categoriesForFormat,
  MAX_OUTPUTS_PER_ITEM,
  type BriefInterviewInput,
  type OutputPlanItem,
} from "../services/brief-interview-core";
import { formatToChannel, bestHourForChannel } from "../services/distribution-planner-core";

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 ? s : null;
};

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];

const parseDate = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Max deliverables one draft call will produce (keeps the request bounded). */
const MAX_DRAFTS_PER_CALL = 10;

export function registerBriefInterviewRoutes(app: Express) {
  // Check a product name against Orbit: fuzzy-match the tenant's own
  // (baseline) products and return each match with its known features, so the
  // interview can confirm "we already have this product in the system".
  app.get("/api/campaign-interview/product-match", async (req, res) => {
    try {
      if (!(await guardFeature(req, res, "editorialCalendar"))) return;
      const ctx = await getRequestContext(req);
      const q = str(req.query.q);
      if (!q || !ctx.marketId) return res.json({ matches: [] });

      const rows = await db
        .select({
          id: products.id,
          name: products.name,
          description: products.description,
          url: products.url,
        })
        .from(products)
        .where(
          and(
            eq(products.tenantDomain, ctx.tenantDomain),
            eq(products.marketId, ctx.marketId),
            eq(products.isBaseline, true),
            ilike(products.name, `%${q}%`),
          ),
        )
        .orderBy(asc(products.name))
        .limit(5);

      if (rows.length === 0) return res.json({ matches: [] });

      const features = await db
        .select({
          productId: productFeatures.productId,
          name: productFeatures.name,
          description: productFeatures.description,
          status: productFeatures.status,
        })
        .from(productFeatures)
        .where(inArray(productFeatures.productId, rows.map((r) => r.id)));

      const matches = rows.map((p) => ({
        ...p,
        features: features
          .filter((f) => f.productId === p.id)
          .slice(0, 20)
          .map((f) => ({ name: f.name, description: f.description, status: f.status })),
      }));

      res.json({ matches });
    } catch (err: any) {
      console.error("[campaign-interview product-match]", err);
      res.status(500).json({ error: err.message || "Failed to match product" });
    }
  });

  // Suggested ramp-up/amplification windows + tempo for a release date. The
  // interview UI calls this when the user enters the date; the amplification
  // floor (release + 30 days) is enforced here and again at generation time.
  app.get("/api/campaign-interview/release-windows", async (req, res) => {
    try {
      if (!(await guardFeature(req, res, "editorialCalendar"))) return;
      const releaseDate = parseDate(req.query.releaseDate);
      if (!releaseDate) return res.status(400).json({ error: "releaseDate is required" });
      const windows = suggestReleaseWindows(releaseDate);
      const tempo = suggestReleaseTempo();
      res.json({
        rampUpStart: windows.rampUpStart.toISOString(),
        releaseDate: windows.releaseDate.toISOString(),
        amplificationEnd: windows.amplificationEnd.toISOString(),
        minAmplificationEnd: clampAmplificationEnd(releaseDate, null).toISOString(),
        tempo,
        tempoText: formatTempoForDisplay(tempo),
      });
    } catch (err: any) {
      console.error("[campaign-interview release-windows]", err);
      res.status(500).json({ error: err.message || "Failed to suggest windows" });
    }
  });

  // The interview's main step: create (or reuse) the campaign from the
  // interview answers and generate 5-10 format-agnostic concept briefs, each
  // carrying an AI voice/topic fit assessment for the curation step.
  app.post("/api/campaign-interview/generate", async (req, res) => {
    try {
      if (!(await guardFeature(req, res, "editorialCalendar"))) return;
      const ctx = await getRequestContext(req);
      const body = req.body ?? {};

      const campaignType: CampaignType = (CAMPAIGN_TYPES as readonly string[]).includes(body.campaignType)
        ? body.campaignType
        : "theme";

      const themes = strArray(body.themes);
      if (themes.length === 0) {
        return res.status(400).json({ error: "At least one theme is required" });
      }

      // Product-release window math, server-enforced: ramp-up defaults to 6
      // weeks before release; amplification always ends ≥30 days after it.
      const releaseDate = campaignType === "product_release" ? parseDate(body.releaseDate) : null;
      if (campaignType === "product_release" && !releaseDate) {
        return res.status(400).json({ error: "releaseDate is required for a product release" });
      }
      let rampUpStart = parseDate(body.rampUpStart);
      let amplificationEnd = parseDate(body.amplificationEnd);
      if (releaseDate) {
        const suggested = suggestReleaseWindows(releaseDate);
        if (!rampUpStart || rampUpStart.getTime() >= releaseDate.getTime()) {
          rampUpStart = suggested.rampUpStart;
        }
        amplificationEnd = clampAmplificationEnd(releaseDate, amplificationEnd);
      }

      const newsItems = strArray(body.newsItems).slice(0, 6);
      const eventDate = parseDate(body.eventDate);
      const timeframeStart = parseDate(body.timeframeStart);
      const timeframeEnd = parseDate(body.timeframeEnd);

      // Verify any claimed Orbit product against the tenant's own products and
      // pull its features from the database rather than trusting the client.
      let product: { productId: string | null; productName: string; matchedFeatures: string[] } | null = null;
      const claimedProductName = str(body.product?.productName);
      const claimedProductId = str(body.product?.productId);
      if (claimedProductId) {
        const [row] = await db
          .select({ id: products.id, name: products.name })
          .from(products)
          .where(
            and(
              eq(products.id, claimedProductId),
              eq(products.tenantDomain, ctx.tenantDomain),
              eq(products.isBaseline, true),
            ),
          );
        if (!row) return res.status(400).json({ error: "Unknown product" });
        const featureRows = await db
          .select({ name: productFeatures.name })
          .from(productFeatures)
          .where(eq(productFeatures.productId, row.id))
          .limit(20);
        product = { productId: row.id, productName: row.name, matchedFeatures: featureRows.map((f) => f.name) };
      } else if (claimedProductName) {
        product = { productId: null, productName: claimedProductName, matchedFeatures: [] };
      }

      const tempo = str(body.tempo) ?? (releaseDate ? formatTempoForDisplay(suggestReleaseTempo()) : null);

      // Load explicitly selected personas so the AI targets the right audience.
      const personaIds = strArray(body.personaIds);
      let explicitPersonasBlock: string | undefined;
      if (personaIds.length > 0) {
        const personaRows = await db
          .select({
            name: personas.name,
            role: personas.role,
            industry: personas.industry,
            companySize: personas.companySize,
            painPoints: personas.painPoints,
            goals: personas.goals,
            objections: personas.objections,
            preferredChannels: personas.preferredChannels,
            notes: personas.notes,
          })
          .from(personas)
          .where(
            and(
              inArray(personas.id, personaIds),
              eq(personas.tenantDomain, ctx.tenantDomain),
            ),
          );
        if (personaRows.length > 0) {
          explicitPersonasBlock = formatPersonaContextForPrompt(personaRows);
        }
      }

      const interview: BriefInterviewInput = {
        campaignType,
        name: str(body.name),
        themes,
        timeframeStart: timeframeStart?.toISOString() ?? null,
        timeframeEnd: timeframeEnd?.toISOString() ?? null,
        eventDate: eventDate?.toISOString() ?? null,
        releaseDate: releaseDate?.toISOString() ?? null,
        rampUpStart: rampUpStart?.toISOString() ?? null,
        amplificationEnd: amplificationEnd?.toISOString() ?? null,
        tempo,
        newsItems,
        product: product
          ? { productId: product.productId, productName: product.productName, features: product.matchedFeatures }
          : null,
        notes: str(body.notes),
        briefCount: body.briefCount != null ? Number(body.briefCount) : undefined,
        personaIds: personaIds.length ? personaIds : undefined,
      };

      const { briefs: drafted, model } = await generateInterviewBriefs({
        tenantDomain: ctx.tenantDomain,
        marketId: ctx.marketId,
        isDefaultMarket: ctx.isDefaultMarket,
        interview,
        explicitPersonasBlock,
      });
      if (drafted.length === 0) {
        return res.status(502).json({ error: "The AI did not return any usable briefs. Please try again." });
      }

      // Campaign span: a release runs ramp-up → amplification end; an event
      // runs up to its date; otherwise the stated timeframe.
      const startDate = releaseDate ? rampUpStart : timeframeStart;
      const endDate = releaseDate ? amplificationEnd : (eventDate ?? timeframeEnd);
      const fallbackName = product?.productName
        ? `${product.productName} release`
        : `${themes[0].slice(0, 60)} — content plan`;

      const interviewSnapshot: CampaignInterview = {
        capturedAt: new Date().toISOString(),
        themes,
        newsItems,
        eventDate: eventDate?.toISOString() ?? null,
        releaseDate: releaseDate?.toISOString() ?? null,
        rampUpStart: releaseDate ? rampUpStart?.toISOString() ?? null : null,
        amplificationEnd: releaseDate ? amplificationEnd?.toISOString() ?? null : null,
        tempo,
        product,
        notes: str(body.notes),
      };

      const existingCampaignId = str(body.campaignId);

      const created = await db.transaction(async (tx) => {
        let campaign;
        if (existingCampaignId) {
          [campaign] = await tx
            .select()
            .from(campaigns)
            .where(
              and(
                eq(campaigns.id, existingCampaignId),
                eq(campaigns.tenantDomain, ctx.tenantDomain),
                eq(campaigns.marketId, ctx.marketId),
              ),
            );
          if (!campaign) throw new Error("Campaign not found");
        } else {
          [campaign] = await tx
            .insert(campaigns)
            .values({
              id: randomUUID(),
              tenantDomain: ctx.tenantDomain,
              marketId: ctx.marketId || null,
              name: str(body.name) ?? fallbackName,
              campaignType,
              status: "draft",
              objective: themes.join("; "),
              startDate,
              endDate,
              productIds: product?.productId ? [product.productId] : null,
              interview: interviewSnapshot,
              createdBy: ctx.userId,
            })
            .returning();
        }

        // Find-or-create the campaign's content-plan calendar.
        let [calendar] = await tx
          .select()
          .from(editorialCalendars)
          .where(
            and(
              eq(editorialCalendars.campaignId, campaign.id),
              eq(editorialCalendars.tenantDomain, ctx.tenantDomain),
            ),
          )
          .limit(1);
        if (!calendar) {
          [calendar] = await tx
            .insert(editorialCalendars)
            .values({
              id: randomUUID(),
              tenantDomain: ctx.tenantDomain,
              marketId: ctx.marketId || null,
              name: `${campaign.name} — Content Plan`,
              description: campaign.objective || null,
              campaignId: campaign.id,
              periodStart: startDate ?? campaign.startDate ?? null,
              periodEnd: endDate ?? campaign.endDate ?? null,
              funnelTargets: DEFAULT_FUNNEL_TARGETS,
              focus: themes.join("; "),
              status: "active",
              createdBy: ctx.userId,
            })
            .returning();
        }

        const existing = await tx
          .select({ sortOrder: contentBriefs.sortOrder })
          .from(contentBriefs)
          .where(eq(contentBriefs.calendarId, calendar.id))
          .orderBy(desc(contentBriefs.sortOrder))
          .limit(1);
        const baseSort = existing.length ? existing[0].sortOrder + 1 : 0;

        const briefRows = await tx
          .insert(contentBriefs)
          .values(
            drafted.map((b, i) => ({
              id: randomUUID(),
              calendarId: calendar.id,
              tenantDomain: ctx.tenantDomain,
              marketId: ctx.marketId || null,
              title: b.title,
              format: b.format,
              summary: b.summary,
              formCategories: b.formCategories,
              fitAssessment: b.fitAssessment,
              targetKeyword: b.targetKeyword,
              demandSignal: b.demandSignal,
              funnelStage: b.funnelStage,
              differentiationAngle: b.differentiationAngle,
              targetReader: b.targetReader,
              cta: b.cta,
              channels: b.channels.length ? b.channels : null,
              estimatedHours: b.estimatedHours,
              status: "suggested",
              aiGenerated: true,
              campaignId: campaign.id,
              sortOrder: baseSort + i,
            })),
          )
          .returning();

        return { campaign, calendar, briefs: briefRows };
      });

      res.status(201).json({
        ...created,
        model,
        windows: releaseDate
          ? {
              rampUpStart: rampUpStart?.toISOString(),
              releaseDate: releaseDate.toISOString(),
              amplificationEnd: amplificationEnd?.toISOString(),
            }
          : null,
      });
    } catch (err: any) {
      console.error("[campaign-interview generate]", err);
      res.status(500).json({ error: err.message || "Failed to generate interview briefs" });
    }
  });

  // Expand accepted concept briefs into dated, per-format deliverable briefs.
  // Body: { items: [{ briefId, format, count, windowStart, windowEnd }] }.
  // Each deliverable lands on the marketing calendar via scheduledAt and points
  // back at its concept via derivedFromBriefId.
  app.post("/api/campaign-interview/:campaignId/expand-plan", async (req, res) => {
    try {
      if (!(await guardFeature(req, res, "editorialCalendar"))) return;
      const ctx = await getRequestContext(req);

      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, req.params.campaignId),
            eq(campaigns.tenantDomain, ctx.tenantDomain),
            eq(campaigns.marketId, ctx.marketId),
          ),
        );
      if (!campaign) return res.status(404).json({ error: "Campaign not found" });

      const rawItems: OutputPlanItem[] = Array.isArray(req.body?.items) ? req.body.items : [];
      const items = rawItems.filter(
        (it) =>
          str(it?.briefId) &&
          (CONTENT_BRIEF_FORMATS as readonly string[]).includes(it?.format) &&
          parseDate(it?.windowStart) &&
          parseDate(it?.windowEnd),
      );
      if (items.length === 0) {
        return res.status(400).json({ error: "No valid plan items provided" });
      }

      const conceptIds = Array.from(new Set(items.map((it) => it.briefId)));
      const concepts = await db
        .select()
        .from(contentBriefs)
        .where(
          and(
            inArray(contentBriefs.id, conceptIds),
            eq(contentBriefs.tenantDomain, ctx.tenantDomain),
            eq(contentBriefs.campaignId, campaign.id),
          ),
        );
      const conceptMap = new Map(concepts.map((c) => [c.id, c]));
      const missing = conceptIds.filter((id) => !conceptMap.has(id));
      if (missing.length) {
        return res.status(400).json({ error: "Some briefs do not belong to this campaign" });
      }

      // Only curated concepts can be expanded — rejected ("removed") or
      // still-uncurated ("suggested") briefs would bypass the curation step.
      // "in_progress" is allowed so a plan can be re-run with more formats.
      const notCurated = concepts.filter((c) => c.status !== "accepted" && c.status !== "in_progress");
      if (notCurated.length) {
        return res.status(400).json({
          error: `Briefs must be accepted before planning outputs: ${notCurated.map((c) => c.title).join("; ")}`,
        });
      }

      // Local-day fidelity: window bounds arrive as calendar days; the client's
      // tz offset places each piece at a sensible local posting hour (mirrors
      // the distribution planner's convention).
      const rawTz = Number(req.body?.tzOffsetMinutes);
      const tzOffsetMinutes = Number.isFinite(rawTz) ? rawTz : 0;

      const created = await db.transaction(async (tx) => {
        const rows: (typeof contentBriefs.$inferSelect)[] = [];

        // Continue sortOrder after everything already in the affected calendars
        // so deliverables never interleave with existing briefs.
        const calendarIds = Array.from(new Set(concepts.map((c) => c.calendarId)));
        const [maxRow] = await tx
          .select({ sortOrder: contentBriefs.sortOrder })
          .from(contentBriefs)
          .where(inArray(contentBriefs.calendarId, calendarIds))
          .orderBy(desc(contentBriefs.sortOrder))
          .limit(1);
        let sortBase = (maxRow?.sortOrder ?? -1) + 1;

        for (const item of items) {
          const concept = conceptMap.get(item.briefId)!;
          const start = parseDate(item.windowStart)!;
          const end = parseDate(item.windowEnd)!;
          const count = Math.min(Math.max(Math.round(Number(item.count) || 1), 1), MAX_OUTPUTS_PER_ITEM);
          const format = item.format as ContentBriefFormat;
          const postingHour = bestHourForChannel(formatToChannel(format));
          const dates = distributeDates(start, end, count).map((d) =>
            scheduleAtLocalHour(d, postingHour, tzOffsetMinutes),
          );

          const inserted = await tx
            .insert(contentBriefs)
            .values(
              dates.map((scheduledAt, i) => ({
                id: randomUUID(),
                calendarId: concept.calendarId,
                tenantDomain: ctx.tenantDomain,
                marketId: ctx.marketId || null,
                title: deliverableTitle(concept.title, format, i, dates.length),
                format,
                summary: concept.summary,
                formCategories: categoriesForFormat(format),
                targetKeyword: concept.targetKeyword,
                demandSignal: concept.demandSignal,
                funnelStage: concept.funnelStage,
                differentiationAngle: concept.differentiationAngle,
                targetReader: concept.targetReader,
                targetPersonaId: concept.targetPersonaId,
                cta: concept.cta,
                status: "accepted",
                aiGenerated: true,
                campaignId: campaign.id,
                solutionAreaId: concept.solutionAreaId,
                derivedFromBriefId: concept.id,
                scheduledAt,
                sortOrder: sortBase++,
              })),
            )
            .returning();
          rows.push(...inserted);
        }

        // Concept briefs move to in_progress once their plan is expanded so
        // they read as "being produced" rather than awaiting curation.
        await tx
          .update(contentBriefs)
          .set({ status: "in_progress", updatedAt: new Date() })
          .where(
            and(
              inArray(contentBriefs.id, conceptIds),
              eq(contentBriefs.tenantDomain, ctx.tenantDomain),
              eq(contentBriefs.status, "accepted"),
            ),
          );

        return rows;
      });

      res.status(201).json({ briefs: created });
    } catch (err: any) {
      console.error("[campaign-interview expand-plan]", err);
      res.status(500).json({ error: err.message || "Failed to expand the output plan" });
    }
  });

  // Expand a concept's SOCIAL plan into real, schedulable posts. Unlike
  // expand-plan (which creates document deliverable briefs), this generates
  // platform-tailored copy per channel and lands it directly in the
  // generated_posts pipeline — one row per channel per scheduled date — so the
  // posts are immediately schedulable without a draft → repurpose round trip.
  app.post("/api/campaign-interview/:campaignId/expand-social", async (req, res) => {
    try {
      if (!(await guardFeature(req, res, "editorialCalendar"))) return;
      const ctx = await getRequestContext(req);

      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, req.params.campaignId),
            eq(campaigns.tenantDomain, ctx.tenantDomain),
            eq(campaigns.marketId, ctx.marketId),
          ),
        );
      if (!campaign) return res.status(404).json({ error: "Campaign not found" });

      const SUPPORTED_CHANNELS = ["linkedin", "twitter", "facebook", "instagram"];
      const rawItems: any[] = Array.isArray(req.body?.items) ? req.body.items : [];
      const items = rawItems
        .map((it) => ({
          briefId: str(it?.briefId),
          channels: strArray(it?.channels)
            .map((c) => (c === "x" ? "twitter" : c))
            .filter((c) => SUPPORTED_CHANNELS.includes(c)),
          count: Math.min(Math.max(Math.round(Number(it?.count) || 1), 1), MAX_OUTPUTS_PER_ITEM),
          windowStart: parseDate(it?.windowStart),
          windowEnd: parseDate(it?.windowEnd),
        }))
        .filter((it) => it.briefId && it.channels.length > 0 && it.windowStart && it.windowEnd);
      if (items.length === 0) {
        return res.status(400).json({ error: "No valid social plan items provided" });
      }

      const conceptIds = Array.from(new Set(items.map((it) => it.briefId!)));
      const concepts = await db
        .select()
        .from(contentBriefs)
        .where(
          and(
            inArray(contentBriefs.id, conceptIds),
            eq(contentBriefs.tenantDomain, ctx.tenantDomain),
            eq(contentBriefs.campaignId, campaign.id),
          ),
        );
      const conceptMap = new Map(concepts.map((c) => [c.id, c]));
      const missing = conceptIds.filter((id) => !conceptMap.has(id));
      if (missing.length) {
        return res.status(400).json({ error: "Some briefs do not belong to this campaign" });
      }
      const notCurated = concepts.filter((c) => c.status !== "accepted" && c.status !== "in_progress");
      if (notCurated.length) {
        return res.status(400).json({
          error: `Briefs must be accepted before planning outputs: ${notCurated.map((c) => c.title).join("; ")}`,
        });
      }

      const rawTz = Number(req.body?.tzOffsetMinutes);
      const tzOffsetMinutes = Number.isFinite(rawTz) ? rawTz : 0;

      // Generate copy per concept in parallel; per-concept failures are reported
      // but never abort the batch.
      const perConcept = await Promise.allSettled(
        items.map(async (item) => {
          const concept = conceptMap.get(item.briefId!)!;
          const posts = await generateInterviewSocialPosts({
            tenantDomain: ctx.tenantDomain,
            concept: {
              title: concept.title,
              summary: concept.summary,
              differentiationAngle: concept.differentiationAngle,
              targetReader: concept.targetReader,
              cta: concept.cta,
              demandSignal: concept.demandSignal,
            },
            channels: item.channels,
            countPerChannel: item.count,
          });
          return { item, concept, posts };
        }),
      );

      const rows: Array<typeof generatedPosts.$inferInsert> = [];
      const errors: string[] = [];
      for (let i = 0; i < perConcept.length; i++) {
        const outcome = perConcept[i];
        if (outcome.status === "rejected") {
          errors.push(items[i].briefId!);
          continue;
        }
        const { item, concept, posts } = outcome.value;
        // Bucket the generated copy by platform, then place each channel's posts
        // across the window at that channel's best local hour.
        const byPlatform = new Map<string, string[]>();
        for (const p of posts) {
          const arr = byPlatform.get(p.platform) ?? [];
          arr.push(p.content);
          byPlatform.set(p.platform, arr);
        }
        for (const channel of item.channels) {
          const copies = byPlatform.get(channel) ?? [];
          if (copies.length === 0) continue;
          const dates = distributeDates(item.windowStart!, item.windowEnd!, item.count).map((d) =>
            scheduleAtLocalHour(d, bestHourForChannel(channel), tzOffsetMinutes),
          );
          for (let d = 0; d < dates.length; d++) {
            const content = copies[d] ?? copies[copies.length - 1];
            rows.push({
              id: randomUUID(),
              campaignId: campaign.id,
              tenantDomain: ctx.tenantDomain,
              platform: channel,
              content,
              status: "draft",
              postFormat: "single",
              solutionAreaId: concept.solutionAreaId ?? null,
              scheduledDate: dates[d],
            });
          }
        }
      }

      const created = rows.length
        ? await db.insert(generatedPosts).values(rows).returning()
        : [];

      // Mark involved concepts as in_progress (idempotent with expand-plan).
      await db
        .update(contentBriefs)
        .set({ status: "in_progress", updatedAt: new Date() })
        .where(
          and(
            inArray(contentBriefs.id, conceptIds),
            eq(contentBriefs.tenantDomain, ctx.tenantDomain),
            eq(contentBriefs.status, "accepted"),
          ),
        );

      res.status(201).json({ posts: created, failedConceptIds: errors });
    } catch (err: any) {
      console.error("[campaign-interview expand-social]", err);
      res.status(500).json({ error: err.message || "Failed to expand the social plan" });
    }
  });

  // Draft content for a batch of deliverable briefs (≤10 per call; the client
  // batches). Each success creates a content asset in the brief's format —
  // webinars produce the deck outline, press releases the newswire draft —
  // and links it back to the brief. Per-item failures don't abort the batch.
  app.post("/api/campaign-interview/:campaignId/draft", async (req, res) => {
    try {
      if (!(await guardFeature(req, res, "editorialCalendar"))) return;
      const ctx = await getRequestContext(req);

      const briefIds = strArray(req.body?.briefIds).slice(0, MAX_DRAFTS_PER_CALL);
      if (briefIds.length === 0) return res.status(400).json({ error: "briefIds is required" });

      const briefs = await db
        .select()
        .from(contentBriefs)
        .where(
          and(
            inArray(contentBriefs.id, briefIds),
            eq(contentBriefs.tenantDomain, ctx.tenantDomain),
            eq(contentBriefs.campaignId, req.params.campaignId),
          ),
        );
      const briefMap = new Map(briefs.map((b) => [b.id, b]));

      const results: Array<{ briefId: string; ok: boolean; assetId?: string; error?: string }> = [];
      for (const briefId of briefIds) {
        const brief = briefMap.get(briefId);
        if (!brief) {
          results.push({ briefId, ok: false, error: "Not found" });
          continue;
        }
        if (brief.contentAssetId) {
          results.push({ briefId, ok: true, assetId: brief.contentAssetId });
          continue;
        }
        try {
          const voiceProfile = await getPersonalVoiceProfile(ctx.userId);
          const draft = await draftFromBrief(brief, {
            isDefaultMarket: ctx.isDefaultMarket,
            soundLikeMeInstructions: voiceProfile?.soundLikeMeInstructions ?? null,
          });
          if (!draft.body?.trim()) throw new Error("The AI did not return a usable draft");

          const linked = await db.transaction(async (tx) => {
            const [asset] = await tx
              .insert(contentAssets)
              .values({
                id: randomUUID(),
                tenantDomain: ctx.tenantDomain,
                marketId: ctx.marketId || null,
                title: draft.title || brief.title,
                description: draft.meta || null,
                content: draft.body,
                subtitle: draft.subtitle || null,
                overview: draft.overview || null,
                postTags: draft.tags || null,
                assetType: briefFormatToAssetType(draft.format as any),
                status: "active",
                // Output points back at the brief that motivated it; the
                // brief-side contentAssetId write below stays in sync for
                // back-compat (asset-owned link is authoritative).
                sourceBriefId: brief.id,
                createdBy: ctx.userId,
              })
              .returning();
            await tx
              .update(contentBriefs)
              .set({ contentAssetId: asset.id, status: "drafted", updatedAt: new Date() })
              .where(
                and(
                  eq(contentBriefs.id, brief.id),
                  eq(contentBriefs.tenantDomain, ctx.tenantDomain),
                ),
              );
            return asset;
          });
          results.push({ briefId, ok: true, assetId: linked.id });
        } catch (err: any) {
          console.error(`[campaign-interview draft] brief ${briefId}:`, err);
          results.push({ briefId, ok: false, error: err.message || "Draft failed" });
        }
      }

      res.json({ results });
    } catch (err: any) {
      console.error("[campaign-interview draft]", err);
      res.status(500).json({ error: err.message || "Failed to draft content" });
    }
  });
}
