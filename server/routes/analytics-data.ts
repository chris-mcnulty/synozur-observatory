import type { Express } from "express";
import { createHash } from "crypto";
import { storage } from "../storage";
import { getRequestContext, ContextError } from "../context";
import { toContextFilter, validateResourceContext, hasAdminAccess, hasContentAccess, logAiUsage, guardFeature, guardManualAction } from "./helpers";
import Anthropic from "@anthropic-ai/sdk";
import type { Competitor } from "@shared/schema";

export function registerAnalyticsDataRoutes(app: Express) {
  // ==================== ANALYTICS ROUTES ====================

  // Simple in-memory cache for IP to country lookups
  const ipCountryCache = new Map<string, { country: string; expires: number }>();
  const IP_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

  async function getCountryFromIP(ip: string): Promise<string | null> {
    try {
      // Check cache first
      const cached = ipCountryCache.get(ip);
      if (cached && cached.expires > Date.now()) {
        return cached.country;
      }

      // Skip private/local IPs (RFC 1918 and RFC 4193)
      if (ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.') || 
          ip.startsWith('172.16.') || ip.startsWith('172.17.') || ip.startsWith('172.18.') ||
          ip.startsWith('172.19.') || ip.startsWith('172.20.') || ip.startsWith('172.21.') ||
          ip.startsWith('172.22.') || ip.startsWith('172.23.') || ip.startsWith('172.24.') ||
          ip.startsWith('172.25.') || ip.startsWith('172.26.') || ip.startsWith('172.27.') ||
          ip.startsWith('172.28.') || ip.startsWith('172.29.') || ip.startsWith('172.30.') ||
          ip.startsWith('172.31.') || ip === '::1' || ip === 'localhost' ||
          ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) {
        return null;
      }

      // Validate IP format (basic check)
      const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
      const ipv6Regex = /^[0-9a-fA-F:]+$/;
      if (!ipv4Regex.test(ip) && !ipv6Regex.test(ip)) {
        return null;
      }

      // Use ipapi.co (HTTPS, free tier: 1000 req/day)
      const response = await fetch(`https://ipapi.co/${ip}/json/`, {
        headers: { 'User-Agent': 'Orbit/1.0' },
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });
      if (!response.ok) return null;
      
      const data = await response.json();
      if (data.country_code && !data.error) {
        // Cache the result
        ipCountryCache.set(ip, { country: data.country_code, expires: Date.now() + IP_CACHE_TTL });
        return data.country_code;
      }
      return null;
    } catch (error) {
      // Silently fail - geolocation is best-effort
      return null;
    }
  }

  app.post("/api/analytics/page-view", async (req, res) => {
    try {
      const { path, sessionId, referrer, utmSource, utmMedium, utmCampaign } = req.body;
      
      if (!path || !sessionId) {
        return res.status(400).json({ error: "path and sessionId are required" });
      }

      const xForwardedFor = req.headers['x-forwarded-for'];
      const ip = Array.isArray(xForwardedFor) ? xForwardedFor[0] : (xForwardedFor?.split(',')[0]?.trim() || req.socket.remoteAddress || '');
      const ipHash = createHash('sha256').update(String(ip)).digest('hex').substring(0, 16);
      const userAgent = req.headers['user-agent'] || '';

      // Get country from IP (async, cached)
      const country = await getCountryFromIP(ip);

      await storage.createPageView({
        path,
        sessionId,
        ipHash,
        userAgent,
        referrer: referrer || null,
        utmSource: utmSource || null,
        utmMedium: utmMedium || null,
        utmCampaign: utmCampaign || null,
        country: country || null,
      });

      res.json({ success: true });
    } catch (error: any) {
      console.error("Page view tracking error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/analytics/usage", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user || !hasAdminAccess(user.role)) {
        return res.status(403).json({ error: "Access denied - Admin only" });
      }

      const days = parseInt(req.query.days as string) || 7;
      const stats = await storage.getPageViewStats(days);
      
      const conversionRate = stats.totalViews > 0 
        ? (stats.signupPageViews / stats.totalViews) * 100 
        : 0;

      res.json({
        ...stats,
        conversionRate,
      });
    } catch (error: any) {
      console.error("Usage stats error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Marketing Plans API - Enterprise feature
  app.get("/api/marketing-plans", async (req, res) => {
    if (!await guardFeature(req, res, "marketingPlanner")) return;
    try {
      const ctx = await getRequestContext(req);
      
      const plans = await storage.getMarketingPlans(toContextFilter(ctx));
      res.json(plans);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/marketing-plans/:id", async (req, res) => {
    if (!await guardFeature(req, res, "marketingPlanner")) return;
    try {
      const ctx = await getRequestContext(req);
      
      const plan = await storage.getMarketingPlan(req.params.id, toContextFilter(ctx));
      if (!plan) {
        return res.status(404).json({ error: "Marketing plan not found" });
      }
      
      // Get tasks for this plan
      const tasks = await storage.getMarketingTasks(plan.id, toContextFilter(ctx));
      
      res.json({ ...plan, tasks });
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/marketing-plans", async (req, res) => {
    if (!await guardFeature(req, res, "marketingPlanner")) return;
    try {
      const ctx = await getRequestContext(req);
      
      const { name, fiscalYear, description, configMatrix } = req.body;
      
      if (!name || !fiscalYear) {
        return res.status(400).json({ error: "Name and fiscal year are required" });
      }
      
      const plan = await storage.createMarketingPlan({
        tenantDomain: ctx.tenantDomain,
        marketId: ctx.marketId,
        name,
        fiscalYear,
        description: description || null,
        configMatrix: configMatrix || null,
        status: "draft",
        createdBy: ctx.userId,
      });
      
      res.json(plan);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/marketing-plans/:id", async (req, res) => {
    if (!await guardFeature(req, res, "marketingPlanner")) return;
    try {
      const ctx = await getRequestContext(req);
      
      const { name, description, configMatrix, status } = req.body;
      
      const updated = await storage.updateMarketingPlan(
        req.params.id,
        { name, description, configMatrix, status },
        toContextFilter(ctx)
      );
      
      if (!updated) {
        return res.status(404).json({ error: "Marketing plan not found" });
      }
      
      res.json(updated);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/marketing-plans/:id", async (req, res) => {
    if (!await guardFeature(req, res, "marketingPlanner")) return;
    try {
      const ctx = await getRequestContext(req);
      
      const deleted = await storage.deleteMarketingPlan(req.params.id, toContextFilter(ctx));
      if (!deleted) {
        return res.status(404).json({ error: "Marketing plan not found" });
      }
      
      res.json({ success: true });
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Marketing Tasks API
  app.get("/api/marketing-plans/:planId/tasks", async (req, res) => {
    if (!await guardFeature(req, res, "marketingPlanner")) return;
    try {
      const ctx = await getRequestContext(req);
      
      const plan = await storage.getMarketingPlan(req.params.planId, toContextFilter(ctx));
      if (!plan) {
        return res.status(404).json({ error: "Marketing plan not found" });
      }
      
      const tasks = await storage.getMarketingTasks(plan.id, toContextFilter(ctx));
      res.json(tasks);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/marketing-plans/:planId/tasks", async (req, res) => {
    if (!await guardFeature(req, res, "marketingPlanner")) return;
    try {
      const ctx = await getRequestContext(req);
      
      const plan = await storage.getMarketingPlan(req.params.planId, toContextFilter(ctx));
      if (!plan) {
        return res.status(404).json({ error: "Marketing plan not found" });
      }
      
      const { title, description, activityGroup, timeframe, priority, aiGenerated, sourceRecommendationId } = req.body;
      
      if (!title || !activityGroup || !timeframe) {
        return res.status(400).json({ error: "Title, activity group, and timeframe are required" });
      }
      
      const task = await storage.createMarketingTask({
        planId: plan.id,
        title,
        description: description || null,
        activityGroup,
        timeframe,
        priority: priority || "Medium",
        status: "suggested",
        aiGenerated: aiGenerated ?? false,
        sourceRecommendationId: sourceRecommendationId || null,
      }, toContextFilter(ctx));
      
      if (!task) {
        return res.status(404).json({ error: "Marketing plan not found or access denied" });
      }
      
      res.json(task);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/marketing-plans/:planId/tasks/:taskId", async (req, res) => {
    if (!await guardFeature(req, res, "marketingPlanner")) return;
    try {
      const ctx = await getRequestContext(req);
      
      const plan = await storage.getMarketingPlan(req.params.planId, toContextFilter(ctx));
      if (!plan) {
        return res.status(404).json({ error: "Marketing plan not found" });
      }
      
      const { title, description, activityGroup, timeframe, priority, status, assignedTo, dueDate } = req.body;
      
      const updated = await storage.updateMarketingTask(
        req.params.taskId,
        plan.id,
        { title, description, activityGroup, timeframe, priority, status, assignedTo, dueDate },
        toContextFilter(ctx)
      );
      
      if (!updated) {
        return res.status(404).json({ error: "Task not found" });
      }
      
      res.json(updated);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/marketing-plans/:planId/tasks/:taskId", async (req, res) => {
    if (!await guardFeature(req, res, "marketingPlanner")) return;
    try {
      const ctx = await getRequestContext(req);
      
      const plan = await storage.getMarketingPlan(req.params.planId, toContextFilter(ctx));
      if (!plan) {
        return res.status(404).json({ error: "Marketing plan not found" });
      }
      
      const deleted = await storage.deleteMarketingTask(req.params.taskId, plan.id, toContextFilter(ctx));
      if (!deleted) {
        return res.status(404).json({ error: "Task not found" });
      }
      
      res.json({ success: true });
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Generate AI-suggested marketing tasks
  app.post("/api/marketing-plans/:planId/generate-tasks", async (req, res) => {
    if (!await guardFeature(req, res, "marketingPlanner")) return;
    try {
      const ctx = await getRequestContext(req);
      
      const plan = await storage.getMarketingPlan(req.params.planId, toContextFilter(ctx));
      if (!plan) {
        return res.status(404).json({ error: "Marketing plan not found" });
      }

      const { categories = [], periods = [], deleteExisting = false } = req.body;
      
      if (!categories.length || !periods.length) {
        return res.status(400).json({ error: "Please select at least one category and one time period" });
      }

      // Handle data cleanup if requested
      if (deleteExisting) {
        // Delete all tasks for this plan
        const existingTasks = await storage.getMarketingTasks(plan.id, toContextFilter(ctx));
        for (const task of existingTasks) {
          await storage.deleteMarketingTask(task.id, plan.id, toContextFilter(ctx));
        }
      }

      // Get existing tasks to avoid duplicates (will be empty if deleteExisting was true)
      const existingTasks = await storage.getMarketingTasks(plan.id, toContextFilter(ctx));
      
      // Get competitive intelligence context
      const companyProfile = await storage.getCompanyProfileByContext(toContextFilter(ctx));
      const competitors = await storage.getCompetitorsByContext(toContextFilter(ctx));
      const recommendations = await storage.getRecommendationsByContext(toContextFilter(ctx));

      // Get GTM plan (long-form recommendation) if available
      let gtmPlan: any = null;
      let messagingFramework: any = null;
      if (companyProfile) {
        [gtmPlan, messagingFramework] = await Promise.all([
          storage.getLongFormRecommendationByType("gtm_plan", undefined, companyProfile.id),
          storage.getLongFormRecommendationByType("messaging_framework", undefined, companyProfile.id),
        ]);
      }
      
      // Category labels for the prompt
      const categoryLabels: Record<string, string> = {
        events: "Events & Trade Shows",
        digital_marketing: "Digital Marketing",
        outbound_campaigns: "Outbound Campaigns",
        content_marketing: "Content Marketing",
        social_media: "Social Media",
        email_marketing: "Email Marketing",
        seo_sem: "SEO/SEM",
        pr_comms: "PR & Communications",
        analyst_relations: "Analyst Relations",
        partner_marketing: "Partner Marketing",
        customer_marketing: "Customer Marketing",
        product_marketing: "Product Marketing",
        brand: "Brand",
        website: "Website",
        webinars: "Webinars",
        podcasts: "Podcasts",
        video: "Video",
        research: "Research & Insights",
        other: "Other",
      };

      const periodLabels: Record<string, string> = {
        steady_state: "Steady State (Ongoing)",
        Q1: "Q1",
        Q2: "Q2",
        Q3: "Q3",
        Q4: "Q4",
        future: "Future",
        q1: "Q1",
        q2: "Q2",
        q3: "Q3",
        q4: "Q4",
        h1: "H1 (First Half)",
        h2: "H2 (Second Half)",
        annual: "Full Year",
      };

      const selectedCategoryNames = categories.map((c: string) => categoryLabels[c] || c);
      const selectedPeriodNames = periods.map((p: string) => periodLabels[p] || p);

      // Get market business type for B2B vs B2C context
      let businessType = "b2b";
      if (ctx.marketId) {
        const market = await storage.getMarket(ctx.marketId);
        if (market?.businessType) businessType = market.businessType;
      }
      const isB2C = businessType === "b2c";

      // Build context for AI
      const companyName = companyProfile?.websiteUrl?.replace(/^https?:\/\//, '').replace(/\/$/, '') || "Unknown";
      let contextInfo = `Company: ${companyName}\n`;
      contextInfo += `Business Model: ${isB2C ? "B2C (Business-to-Consumer)" : "B2B (Business-to-Business)"}\n`;
      if (companyProfile?.description) {
        contextInfo += `Description: ${companyProfile.description}\n`;
      }
      if (competitors.length > 0) {
        contextInfo += `Key Competitors: ${competitors.slice(0, 5).map((c: any) => c.websiteUrl?.replace(/^https?:\/\//, '').replace(/\/$/, '') || c.id).join(", ")}\n`;
      }
      
      // Add GTM Plan context (most important input)
      let gtmPlanContext = "";
      if (gtmPlan?.content && gtmPlan.status === "generated") {
        // Truncate to ~3000 chars to leave room for other context
        const truncatedGtm = gtmPlan.content.length > 3000 
          ? gtmPlan.content.substring(0, 3000) + "..." 
          : gtmPlan.content;
        gtmPlanContext = `\n## Draft GTM Plan (Key Strategic Input)\n${truncatedGtm}\n`;
      }
      
      // Add messaging framework context
      let messagingContext = "";
      if (messagingFramework?.content && messagingFramework.status === "generated") {
        const truncatedMsg = messagingFramework.content.length > 2000
          ? messagingFramework.content.substring(0, 2000) + "..."
          : messagingFramework.content;
        messagingContext = `\n## Messaging & Positioning Framework\nAlign task messaging and content focus with this framework:\n${truncatedMsg}\n`;
      }

      // Add AI Recommendations context
      let recommendationsContext = "";
      const activeRecs = recommendations.filter((r: any) => r.status !== "dismissed").slice(0, 10);
      if (activeRecs.length > 0) {
        recommendationsContext = `\n## Strategic Recommendations\n`;
        activeRecs.forEach((r: any) => {
          recommendationsContext += `- [${r.area}] ${r.title}: ${r.description?.substring(0, 150) || ""}...\n`;
        });
      }

      // Add competitor insights if available
      let competitorInsights = "";
      const competitorsWithData = competitors.filter((c: any) => c.strengthsWeaknesses || c.lastAnalysisDate).slice(0, 3);
      if (competitorsWithData.length > 0) {
        competitorInsights = `\n## Competitor Insights\n`;
        competitorsWithData.forEach((c: any) => {
          const name = c.websiteUrl?.replace(/^https?:\/\//, '').replace(/\/$/, '') || "Competitor";
          if (c.strengthsWeaknesses) {
            const sw = typeof c.strengthsWeaknesses === 'string' ? c.strengthsWeaknesses : JSON.stringify(c.strengthsWeaknesses);
            competitorInsights += `${name}: ${sw.substring(0, 200)}...\n`;
          }
        });
      }

      // Build existing tasks context to avoid duplicates
      let existingTasksContext = "";
      if (existingTasks.length > 0) {
        existingTasksContext = `\n## EXISTING TASKS (DO NOT DUPLICATE)\nThe following tasks already exist in this plan. DO NOT generate similar or duplicate tasks:\n`;
        existingTasks.forEach((t: any) => {
          existingTasksContext += `- [${categoryLabels[t.activityGroup] || t.activityGroup}] "${t.title}"\n`;
        });
        existingTasksContext += `\nGenerate only NEW, unique tasks that are different from the above.\n`;
      }

      const b2cTaskGuidance = isB2C ? `
## B2C Market Context
This is a B2C (Business-to-Consumer) market. Generate tasks appropriate for consumer marketing:
- Prioritize social media campaigns, influencer partnerships, UGC strategies, and community building
- Focus on brand awareness, emotional storytelling, and lifestyle content over whitepapers and webinars
- For SEO/SEM, emphasize product-focused keywords, shopping ads, and consumer search intent
- For email marketing, focus on customer lifecycle, cart abandonment, loyalty programs, and personalization
- Events should be consumer-facing: pop-ups, sponsorships, experiential marketing — not trade shows
- Content should be visual, shareable, and platform-native (TikTok, Instagram Reels, YouTube Shorts)
- PR should target consumer media, lifestyle publications, and social media buzz — not trade press
- Product marketing should emphasize reviews, ratings, unboxing, and social proof
` : "";

      const prompt = `Generate marketing tasks for a ${plan.fiscalYear} marketing plan.

## Company Context
${contextInfo}
${gtmPlanContext}
${messagingContext}
${recommendationsContext}
${competitorInsights}
${existingTasksContext}
${b2cTaskGuidance}
## Task Generation Request
Selected Activity Categories: ${selectedCategoryNames.join(", ")}
Time Periods: ${selectedPeriodNames.join(", ")}

Generate 2-3 specific, actionable marketing tasks for EACH selected category. Each task should:
1. Be specific and measurable
2. DIRECTLY ALIGN with the Draft GTM Plan strategies and recommendations above
3. Address competitive gaps or opportunities identified in the strategic recommendations
4. Include a suggested priority (High, Medium, or Low)
5. Be assigned to one of the selected time periods (use "steady_state" for ongoing activities)
6. BE UNIQUE - DO NOT duplicate any existing tasks listed above
${isB2C ? "7. Be tailored for consumer audiences — avoid B2B-specific tactics like ABM, sales enablement decks, or enterprise webinars" : ""}

Respond in JSON format:
{
  "tasks": [
    {
      "title": "Task title",
      "description": "Brief description of the task and how it supports the GTM strategy",
      "activityGroup": "category_value",
      "priority": "High|Medium|Low",
      "timeframe": "period_value"
    }
  ]
}

Only use these activityGroup values: ${categories.join(", ")}
Only use these timeframe values: ${periods.join(", ")}`;

      // Call AI to generate tasks
      const anthropic = new Anthropic({
        apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
      });

      const message = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 8000,
        messages: [
          { 
            role: "user", 
            content: prompt 
          }
        ],
        system: "You are a marketing strategy expert. Generate practical, actionable marketing tasks based on the company's competitive landscape. Always respond with valid JSON only, no additional text.",
      });

      const aiResponse = message.content[0].type === "text" ? message.content[0].text : "";

      // Parse AI response with more robust handling
      let generatedTasks: any[] = [];
      console.log("AI Response length:", aiResponse.length);
      console.log("AI Response (first 500 chars):", aiResponse.substring(0, 500));
      
      // Strip markdown code fences if present
      let cleanedResponse = aiResponse.trim();
      if (cleanedResponse.startsWith("```json")) {
        cleanedResponse = cleanedResponse.slice(7);
      } else if (cleanedResponse.startsWith("```")) {
        cleanedResponse = cleanedResponse.slice(3);
      }
      if (cleanedResponse.endsWith("```")) {
        cleanedResponse = cleanedResponse.slice(0, -3);
      }
      cleanedResponse = cleanedResponse.trim();
      
      try {
        // First, try to parse the entire response as JSON
        if (cleanedResponse.startsWith("{")) {
          const parsed = JSON.parse(cleanedResponse);
          generatedTasks = parsed.tasks || [];
        } else if (cleanedResponse.startsWith("[")) {
          generatedTasks = JSON.parse(cleanedResponse);
        }
      } catch (firstParseError) {
        console.log("Direct parse failed, trying regex extraction...");
        try {
          // Try to find JSON object with tasks array (greedy match for the array)
          const jsonMatch = aiResponse.match(/\{[\s\S]*"tasks"\s*:\s*\[([\s\S]*)\]\s*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            generatedTasks = parsed.tasks || [];
          }
        } catch (parseError) {
          console.error("Failed to parse AI response:", parseError);
          console.error("AI Response (first 1000 chars):", aiResponse.substring(0, 1000));
          // Try a more lenient extraction - look for individual task objects
          try {
            const taskPattern = /\{\s*"title"\s*:\s*"[^"]+"\s*,\s*"description"\s*:\s*"[^"]*"\s*,\s*"activityGroup"\s*:\s*"[^"]+"\s*,\s*"priority"\s*:\s*"[^"]+"\s*,\s*"timeframe"\s*:\s*"[^"]+"\s*\}/g;
            const taskMatches = Array.from(aiResponse.matchAll(taskPattern));
            for (const match of taskMatches) {
              try {
                const task = JSON.parse(match[0]);
                if (task.title) {
                  generatedTasks.push(task);
                }
              } catch {}
            }
          } catch {}
        }
      }
      
      if (generatedTasks.length === 0) {
        console.error("No tasks extracted from AI response");
        return res.status(500).json({ error: "Failed to parse AI suggestions. Please try again." });
      }

      // Create the tasks in the database
      let tasksCreated = 0;
      for (const task of generatedTasks) {
        if (task.title && categories.includes(task.activityGroup) && periods.includes(task.timeframe)) {
          await storage.createMarketingTask({
            planId: plan.id,
            title: task.title,
            description: task.description || null,
            activityGroup: task.activityGroup,
            priority: task.priority || "Medium",
            status: "suggested",
            timeframe: task.timeframe,
            aiGenerated: true,
          }, toContextFilter(ctx));
          tasksCreated++;
        }
      }

      // Log AI usage
      await logAiUsage(ctx, "generate_marketing_tasks", "anthropic", "claude-sonnet-4-5", message.usage);

      res.json({ success: true, tasksCreated });
    } catch (error: any) {
      console.error("Generate tasks error:", error);
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/intelligence-briefings/source-freshness", async (req, res) => {
    if (!await guardFeature(req, res, "intelligenceBriefings")) return;
    try {
      const ctx = await getRequestContext(req);
      const ctxFilter = toContextFilter(ctx);

      const competitorsList = await storage.getCompetitorsByContext(ctxFilter);
      const companyProfile = await storage.getCompanyProfileByContext(ctxFilter);

      const orgIds = [
        ...competitorsList.map(c => c.organizationId),
        companyProfile?.organizationId,
      ].filter((id): id is string => Boolean(id));
      const orgMap = await storage.getOrganizationsByIds(orgIds);

      const pickFresher = (a: any, b: any) => {
        if (a && b) return new Date(b) > new Date(a) ? b : a;
        return a || b || null;
      };

      const competitorFreshness = competitorsList.map((c) => {
        const org = c.organizationId ? orgMap.get(c.organizationId) : null;
        return {
          id: c.id,
          name: c.name,
          lastCrawl: pickFresher(c.lastFullCrawl || c.lastCrawl, org?.lastFullCrawl || org?.lastCrawl),
          lastWebsiteMonitor: pickFresher(c.lastWebsiteMonitor, org?.lastWebsiteMonitor),
          lastSocialMonitor: pickFresher(c.lastSocialCrawl, org?.lastSocialCrawl),
        };
      });

      const baselineFreshness = companyProfile
        ? (() => {
            const org = companyProfile.organizationId ? orgMap.get(companyProfile.organizationId) : null;
            return {
              id: companyProfile.id,
              name: companyProfile.companyName,
              lastCrawl: pickFresher(companyProfile.lastFullCrawl || companyProfile.lastCrawl, org?.lastFullCrawl || org?.lastCrawl),
              lastWebsiteMonitor: pickFresher(companyProfile.lastWebsiteMonitor, org?.lastWebsiteMonitor),
              lastSocialMonitor: pickFresher(companyProfile.lastSocialCrawl, org?.lastSocialCrawl),
            };
          })()
        : null;

      const allTimestamps: (string | Date | null)[] = [];
      for (const c of competitorFreshness) {
        allTimestamps.push(c.lastCrawl, c.lastWebsiteMonitor, c.lastSocialMonitor);
      }
      if (baselineFreshness) {
        allTimestamps.push(baselineFreshness.lastCrawl, baselineFreshness.lastWebsiteMonitor, baselineFreshness.lastSocialMonitor);
      }

      let overallStaleness: "fresh" | "aging" | "stale" = "fresh";
      const now = Date.now();
      for (const ts of allTimestamps) {
        if (!ts) {
          overallStaleness = "stale";
          break;
        }
        const diffMs = now - new Date(ts).getTime();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        if (diffDays >= 7) {
          overallStaleness = "stale";
          break;
        } else if (diffDays >= 1 && overallStaleness === "fresh") {
          overallStaleness = "aging";
        }
      }

      res.json({
        competitors: competitorFreshness,
        baseline: baselineFreshness,
        overallStaleness,
      });
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/intelligence-briefings/latest", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const briefing = await storage.getLatestBriefingForTenant(ctx.tenantDomain, ctx.marketId);
      if (!briefing) {
        return res.status(404).json({ error: "No briefings found" });
      }
      res.json(briefing);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/intelligence-briefings/:id", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const briefing = await storage.getIntelligenceBriefing(req.params.id);
      if (!briefing) {
        return res.status(404).json({ error: "Briefing not found" });
      }
      if (briefing.tenantDomain !== ctx.tenantDomain) {
        return res.status(403).json({ error: "Access denied" });
      }
      res.json(briefing);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/intelligence-briefings/:id/pdf", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const briefingId = req.params.id;

      const briefing = await storage.getIntelligenceBriefing(briefingId);
      if (!briefing) {
        return res.status(404).json({ error: "Briefing not found" });
      }

      if (briefing.tenantDomain !== ctx.tenantDomain) {
        return res.status(403).json({ error: "Access denied" });
      }

      const { generateIntelligenceBriefingPdf } = await import("../services/pdf-generator");
      const { enqueuePdf } = await import("../services/job-queue");
      const { pdfBuffer } = await enqueuePdf(
        `briefing-pdf:${briefingId}`,
        (_signal, reportProgress) =>
          generateIntelligenceBriefingPdf(briefingId, ctx.tenantDomain, ctx.userId, reportProgress),
        undefined,
        { tenantDomain: ctx.tenantDomain, targetId: briefingId },
      );

      let contextName = "";
      const marketId = briefing.marketId || undefined;
      if (marketId) {
        const market = await storage.getMarket(marketId);
        if (market) contextName = market.name;
      }
      if (!contextName) {
        const profile = await storage.getCompanyProfileByContext({ tenantDomain: ctx.tenantDomain, marketId, isDefaultMarket: !marketId });
        if (profile) contextName = profile.companyName;
      }
      const safeName = contextName ? `_${contextName.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "_")}` : "";
      const filename = `Market_Intelligence${safeName}_${new Date(briefing.periodEnd).toISOString().split('T')[0]}.pdf`;
      
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(pdfBuffer);

      // Store to SPE (fire-and-forget)
      Promise.resolve().then(async () => {
        const t = await storage.getTenantByDomain(ctx.tenantDomain);
        if (!t?.speStorageEnabled) return;
        const { sharepointFileStorage } = await import("../services/sharepoint-file-storage.js");
        return sharepointFileStorage.storeFile(pdfBuffer, filename, "application/pdf", {
          documentType: "report",
          scope: "tenant",
          tenantDomain: ctx.tenantDomain,
          marketId: briefing.marketId || undefined,
          createdByUserId: ctx.userId,
          fileType: "pdf",
          originalFileName: filename,
          reportType: "intelligence_briefing",
        }, ctx.userId, briefingId, t.id);
      }).catch((err) => console.error("[SPE] Failed to store briefing PDF:", err));
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error("PDF generation error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/intelligence-briefings", async (req, res) => {
    if (!await guardFeature(req, res, "intelligenceBriefings")) return;
    try {
      const ctx = await getRequestContext(req);
      const rawLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
      const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 20 : rawLimit), 100);
      const briefings = await storage.getIntelligenceBriefingsByTenant(ctx.tenantDomain, limit, ctx.marketId);
      res.json(briefings);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/intelligence-briefings/generate", async (req, res) => {
    if (!await guardFeature(req, res, "intelligenceBriefings")) return;
    try {
      const ctx = await getRequestContext(req);
      if (!hasContentAccess(ctx.userRole)) {
        return res.status(403).json({ error: "Admin access required to generate briefings" });
      }
      if (!await guardManualAction(req, res, "manualBriefingRebuild")) return;
      const ALLOWED_PERIODS = [7, 14, 30];
      const rawPeriod = req.body.periodDays ? parseInt(req.body.periodDays, 10) : 7;
      const periodDays = ALLOWED_PERIODS.includes(rawPeriod) ? rawPeriod : 7;

      const now = new Date();
      const periodStart = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);
      const placeholder = await storage.createIntelligenceBriefing({
        tenantDomain: ctx.tenantDomain,
        marketId: ctx.marketId,
        periodStart: periodStart,
        periodEnd: now,
        status: "generating",
        briefingData: null,
        signalCount: 0,
        competitorCount: 0,
      });

      res.json(placeholder);

      const capturedCtx = { ...ctx };
      const capturedFilter = toContextFilter(ctx);
      (async () => {
        try {
          const { generateBriefingData, autoPushBriefingToHubspot } = await import("../services/intelligence-briefing-service");

          // Throttled progress writer — updates briefingData.progress so the
          // existing /api/intelligence-briefings/:id poller picks up the
          // current phase + percent without any new infrastructure.
          let lastProgressWrite = 0;
          const writeProgress = async (progress: { phase: string; phaseLabel: string; percent: number }) => {
            const nowTs = Date.now();
            // Always allow the first/last writes; otherwise throttle to 1s
            if (progress.percent === 100 || nowTs - lastProgressWrite > 1000) {
              lastProgressWrite = nowTs;
              try {
                await storage.updateIntelligenceBriefing(placeholder.id, {
                  briefingData: { progress } as any,
                });
              } catch (err: any) {
                console.warn(`[Intelligence Briefing] Progress write failed: ${err.message}`);
              }
            }
          };

          const result = await generateBriefingData(
            capturedCtx.tenantDomain,
            periodDays,
            capturedCtx.marketId,
            capturedFilter,
            (progress) => { void writeProgress(progress); },
          );
          
          const saveWithRetry = async (retries = 3, delayMs = 2000) => {
            for (let attempt = 1; attempt <= retries; attempt++) {
              try {
                await storage.updateIntelligenceBriefing(placeholder.id, {
                  status: "published",
                  briefingData: result.briefingData,
                  signalCount: result.signalCount,
                  competitorCount: result.competitorCount,
                });
                return;
              } catch (dbError: any) {
                console.error(`[Intelligence Briefing] DB save attempt ${attempt}/${retries} failed:`, dbError.message);
                if (attempt < retries) {
                  await new Promise(r => setTimeout(r, delayMs * attempt));
                } else {
                  throw dbError;
                }
              }
            }
          };
          
          await saveWithRetry();
          console.log(`[Intelligence Briefing] Generation complete for ${capturedCtx.tenantDomain} (${placeholder.id})`);

          // Task #112: best-effort auto-push of the new briefing to HubSpot
          // Companies as Notes. Goes through the same canonical service-level
          // helper as the scheduled-job path so both code paths share gating
          // and behaviour. Never throws.
          void autoPushBriefingToHubspot({
            tenantDomain: capturedCtx.tenantDomain,
            briefingId: placeholder.id,
            briefingData: result.briefingData,
            competitorIds: result.competitorIds,
          });
        } catch (error: any) {
          console.error(`[Intelligence Briefing] Background generation failed for ${capturedCtx.tenantDomain}:`, error);
          await storage.updateIntelligenceBriefing(placeholder.id, {
            status: "failed",
            briefingData: { error: error.message },
          }).catch(() => {});
        }
      })();
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error("Generate briefing error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // PATCH /api/intelligence-briefings/:id — remove an individual action item by index
  app.patch("/api/intelligence-briefings/:id", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const briefing = await storage.getIntelligenceBriefing(req.params.id);
      if (!briefing) return res.status(404).json({ error: "Briefing not found" });
      if (briefing.tenantDomain !== ctx.tenantDomain) return res.status(403).json({ error: "Access denied" });

      const { removeActionIndex } = req.body;
      if (typeof removeActionIndex !== "number") {
        return res.status(400).json({ error: "removeActionIndex must be a number" });
      }

      const bd = briefing.briefingData as any;
      const actionItems = Array.isArray(bd?.actionItems) ? bd.actionItems : [];
      const updated = { ...bd, actionItems: actionItems.filter((_: any, i: number) => i !== removeActionIndex) };

      const saved = await storage.updateIntelligenceBriefing(req.params.id, { briefingData: updated });
      res.json(saved);
    } catch (error: any) {
      if (error instanceof ContextError) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/intelligence-briefings/:id", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      if (!hasAdminAccess(ctx.userRole)) {
        return res.status(403).json({ error: "Admin access required to delete briefings" });
      }
      const briefing = await storage.getIntelligenceBriefing(req.params.id);
      if (!briefing) {
        return res.status(404).json({ error: "Briefing not found" });
      }
      if (briefing.tenantDomain !== ctx.tenantDomain) {
        return res.status(403).json({ error: "Access denied" });
      }
      await storage.deleteIntelligenceBriefing(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Share intelligence briefing via email
  app.post("/api/intelligence-briefings/:id/share", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const briefingId = req.params.id;
      const { emails } = req.body;

      if (!Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ error: "At least one email address is required" });
      }

      const briefing = await storage.getIntelligenceBriefing(briefingId);
      if (!briefing) {
        return res.status(404).json({ error: "Briefing not found" });
      }

      // Check context
      if (!validateResourceContext(briefing, ctx)) {
        return res.status(403).json({ error: "You do not have access to this briefing" });
      }

      const user = await storage.getUser(ctx.userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      let contextName = user.company || ctx.tenantDomain;
      if (briefing.marketId) {
        const market = await storage.getMarket(briefing.marketId);
        if (market?.name) contextName = market.name;
      }

      const periodStart = new Date(briefing.periodStart);
      const periodEnd = new Date(briefing.periodEnd);
      const periodDays = Math.round((periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24));
      const periodLabel = `${periodStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${periodEnd.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

      const protocol = req.headers["x-forwarded-proto"] || "http";
      const host = req.headers.host;
      const baseUrl = `${protocol}://${host}`;

      const { sendIntelligenceBriefingShareEmail } = await import("../services/email-service");

      const briefingData = briefing.briefingData as any;
      const digestData = {
        executiveSummary: briefingData.executiveSummary,
        actionItems: briefingData.actionItems || [],
        riskAlerts: briefingData.riskAlerts || [],
        briefingId: briefing.id,
        periodLabel,
        periodDays,
      };

      const results = await Promise.all(
        emails.map(async (email) => {
          const recipientUser = await storage.getUserByEmail(email);
          const recipientName = recipientUser?.name || "Team Member";
          
          return sendIntelligenceBriefingShareEmail(
            email,
            recipientName,
            user.name,
            contextName,
            digestData,
            baseUrl
          );
        })
      );

      const successCount = results.filter(Boolean).length;
      res.json({ 
        success: true, 
        message: `Successfully shared with ${successCount} out of ${emails.length} recipients` 
      });
    } catch (error: any) {
      console.error("[Briefing Share] Error:", error);
      res.status(500).json({ error: "Failed to share briefing" });
    }
  });


}
