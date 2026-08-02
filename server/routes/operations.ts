import type { Express } from "express";
import { storage } from "../storage";
import { db } from "../db";
import { sql, and, count } from "drizzle-orm";
import { getRequestContext, ContextError } from "../context";
import { toContextFilter, hasAdminAccess, hasContentAccess, guardManualAction } from "./helpers";
import { getJobStatus, triggerPlannerSyncNow, invalidateMarketStatusCache, resetStuckJob, resetAllStuckJobs, cancelJob } from "../services/scheduled-jobs";
import Anthropic from "@anthropic-ai/sdk";
import type { Competitor, User } from "@shared/schema";
import { getCacheStats, invalidateTenantCache, clearCache as clearAICache } from "../services/ai-cache";
import { getDeadLetterJobs, dismissDeadLetterJob } from "../services/job-queue";

export function registerOperationsRoutes(app: Express) {
  // ==================== SCHEDULED JOBS (GLOBAL ADMIN) ====================

  app.get("/api/admin/jobs/status", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user || (user.role !== "Global Admin" && user.role !== "Domain Admin")) {
        return res.status(403).json({ error: "Access denied - Admin only" });
      }

      const status = getJobStatus();
      
      // Add schedule information with job intervals
      const scheduleInfo = {
        trialReminder: {
          ...status.trialReminder,
          description: "Sends trial expiration reminder emails",
          interval: "Every 6 hours",
        },
        weeklyDigest: {
          ...status.weeklyDigest,
          description: "Sends weekly competitive intelligence digest emails",
          interval: "Weekly (Mondays 9am ET)",
        },
        plannerSync: {
          ...status.plannerSync,
          description: "Two-way sync of marketing tasks with Microsoft Planner for all connected plans",
          interval: "Every 15 minutes",
        },
      };
      
      res.json(scheduleInfo);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Reset stuck jobs
  app.post("/api/admin/jobs/reset", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user || user.role !== "Global Admin") {
        return res.status(403).json({ error: "Access denied - Global Admin only" });
      }

      const { jobType } = req.body;
      
      if (jobType) {
        // Reset specific job
        const success = resetStuckJob(jobType);
        if (success) {
          res.json({ message: `Reset job: ${jobType}`, reset: [jobType] });
        } else {
          res.status(400).json({ error: `Unknown job type: ${jobType}` });
        }
      } else {
        // Reset all stuck jobs
        const resetJobs = resetAllStuckJobs();
        res.json({ message: `Reset ${resetJobs.length} stuck jobs`, reset: resetJobs });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get job run history
  app.get("/api/admin/jobs/history", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user || (user.role !== "Global Admin" && user.role !== "Domain Admin")) {
        return res.status(403).json({ error: "Access denied - Admin only" });
      }

      const limit = parseInt(req.query.limit as string) || 100;
      const jobType = req.query.jobType as string;
      
      let history;
      if (user.role === "Global Admin") {
        // Global admins see all job runs
        if (jobType) {
          history = await storage.getScheduledJobRunsByType(jobType, limit);
        } else {
          history = await storage.getScheduledJobRuns(limit);
        }
      } else {
        // Domain admins only see their tenant's job runs
        const userDomain = user.email.split("@")[1];
        history = await storage.getScheduledJobRunsByTenant(userDomain, limit);
        if (jobType) {
          history = history.filter(j => j.jobType === jobType);
        }
      }
      
      res.json(history);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/jobs/trigger-planner-sync", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user || user.role !== "Global Admin") {
        return res.status(403).json({ error: "Access denied - Global Admin only" });
      }

      triggerPlannerSyncNow();
      res.json({ success: true, message: "Planner two-way sync triggered for all connected marketing plans" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/jobs/cancel", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user || user.role !== "Global Admin") {
        return res.status(403).json({ error: "Access denied - Global Admin only" });
      }

      const { jobType } = req.body;
      if (!jobType) {
        return res.status(400).json({ error: "Job type is required" });
      }

      const result = cancelJob(jobType);
      console.log(`[Jobs] Cancel request for ${jobType} by ${user.email}: wasRunning=${result.wasRunning}`);
      res.json({ 
        success: true, 
        cancelled: result.cancelled,
        wasRunning: result.wasRunning,
        message: result.wasRunning ? `Job ${jobType} cancelled` : `Job ${jobType} was not running`
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/jobs/:jobId/cancel", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user || (user.role !== "Global Admin" && user.role !== "Domain Admin")) {
        return res.status(403).json({ error: "Access denied - Admin only" });
      }

      const { jobId } = req.params;
      const userTenantDomain = user.email.split("@")[1];

      const runningJobs = await storage.getRunningJobs();
      const existingJob = runningJobs.find(j => j.id === jobId);

      if (!existingJob) {
        return res.status(404).json({ error: "Running job not found" });
      }

      if (user.role !== "Global Admin") {
        if (!existingJob.tenantDomain) {
          return res.status(403).json({ error: "Access denied - only Global Admins can cancel system-wide jobs" });
        }
        if (existingJob.tenantDomain !== userTenantDomain) {
          return res.status(403).json({ error: "Access denied - cannot cancel jobs from other tenants" });
        }
      }

      const job = await storage.updateScheduledJobRun(jobId, {
        status: "failed",
        completedAt: new Date(),
        errorMessage: `Cancelled by ${user.name || user.email}`,
      });

      if (existingJob.jobType) {
        const scheduledResult = cancelJob(existingJob.jobType);
        console.log(`[Jobs] Cancelled job ${jobId} (${existingJob.jobType}) by ${user.email}, scheduled abort: ${scheduledResult.wasRunning}`);
      }

      res.json({ success: true, message: `Job cancelled` });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== ACTIVE JOBS STATUS (ALL USERS) ====================
  
  // Get active/running jobs for current user's active tenant
  app.get("/api/jobs/active", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const user = await storage.getUser(ctx.userId);

      const runningJobs = await storage.getRunningJobs();
      
      const relevantJobs = runningJobs.filter(job => 
        !job.tenantDomain ||
        job.tenantDomain === ctx.tenantDomain ||
        (user?.role === "Global Admin")
      );

      const activeJobs = relevantJobs.map(job => ({
        id: job.id,
        type: job.jobType,
        target: job.targetName || job.targetId,
        startedAt: job.startedAt,
        duration: job.startedAt ? Math.floor((Date.now() - new Date(job.startedAt).getTime()) / 1000) : 0,
      }));

      res.json({ 
        active: activeJobs,
        count: activeJobs.length 
      });
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error("Error fetching active jobs:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get recent job history for current user's active tenant
  app.get("/api/jobs/recent", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);

      const limit = parseInt(req.query.limit as string) || 10;
      
      const recentJobs = await storage.getScheduledJobRunsByTenant(ctx.tenantDomain, limit);
      
      res.json(recentJobs);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error("Error fetching recent jobs:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Admin endpoint to backfill marketId for existing activities
  app.post("/api/admin/backfill-activity-markets", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user || user.role !== "Global Admin") {
        return res.status(403).json({ error: "Access denied - Global Admin only" });
      }

      // Run SQL to backfill marketId based on competitor records
      const result = await db.execute(sql`
        UPDATE activity a
        SET market_id = c.market_id
        FROM competitors c
        WHERE a.market_id IS NULL 
          AND a.competitor_id IS NOT NULL
          AND c.id = a.competitor_id
      `);

      // Also backfill from company profiles for baseline-related activities
      const result2 = await db.execute(sql`
        UPDATE activity a
        SET market_id = cp.market_id
        FROM company_profiles cp
        WHERE a.market_id IS NULL 
          AND a.company_profile_id IS NOT NULL
          AND cp.id = a.company_profile_id
      `);

      res.json({ 
        success: true, 
        message: "Activity market IDs backfilled successfully",
        competitorLinked: result.rowCount || 0,
        baselineLinked: result2.rowCount || 0
      });
    } catch (error: any) {
      console.error("Backfill activity markets error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== COMMAND CENTER ROUTES ====================

  // Get Command Center data - aggregated view across all projects
  app.get("/api/command-center", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const ctxFilter = toContextFilter(ctx);

      // Get all projects for this tenant/market context
      const projects = await storage.getClientProjectsByContext(ctxFilter);
      
      // Get all competitors for this tenant/market context (including baseline)
      const allCompetitors = await storage.getCompetitorsByContext(ctxFilter);
      
      // Get all products for this tenant/market context
      const allProducts = await storage.getProductsByContext(ctxFilter);
      
      // Get all recommendations (action items)
      // Handle both new statuses (pending/accepted/dismissed) and legacy statuses (Open/In Progress)
      const allRecommendations = await storage.getRecommendationsByContext(ctxFilter);
      const pendingActions = allRecommendations.filter(r => 
        r.status === "pending" || r.status === "Open" || r.status === "In Progress" || !r.status
      );
      
      // Get recent activity
      const recentActivity = await storage.getActivityByContext(ctxFilter);
      
      // Get tenant users for assignment dropdown
      const tenantUsers = await storage.getUsersByDomain(ctx.tenantDomain);
      
      // Calculate aggregate health score (average of competitor scores where available)
      let totalScore = 0;
      let scoredCompetitors = 0;
      const competitorScores: Array<{id: string; name: string; score: number; lastAnalysis: string | null}> = [];
      
      for (const competitor of allCompetitors) {
        const analysisData = competitor.analysisData as any;
        if (analysisData?.competitiveScore) {
          totalScore += analysisData.competitiveScore;
          scoredCompetitors++;
          competitorScores.push({
            id: competitor.id,
            name: competitor.name,
            score: analysisData.competitiveScore,
            lastAnalysis: competitor.lastFullCrawl?.toISOString() || null
          });
        }
      }
      
      const averageHealthScore = scoredCompetitors > 0 ? Math.round(totalScore / scoredCompetitors) : null;
      
      // Count items needing attention
      const competitorsNeedingCrawl = allCompetitors.filter((c: Competitor) => {
        if (!c.lastFullCrawl) return true;
        const daysSinceCrawl = (Date.now() - new Date(c.lastFullCrawl).getTime()) / (1000 * 60 * 60 * 24);
        return daysSinceCrawl > 7;
      });
      
      const productsNeedingAnalysis = allProducts.filter(p => !p.analysisData);

      res.json({
        summary: {
          totalProjects: projects.length,
          activeProjects: projects.filter(p => p.status === "active").length,
          totalCompetitors: allCompetitors.length,
          totalProducts: allProducts.length,
          pendingActions: pendingActions.length,
          averageHealthScore,
          competitorsNeedingCrawl: competitorsNeedingCrawl.length,
          productsNeedingAnalysis: productsNeedingAnalysis.length,
        },
        actionItems: pendingActions.slice(0, 20).map(r => ({
          id: r.id,
          title: r.title,
          description: r.description,
          area: r.area,
          impact: r.impact,
          status: r.status,
          assignedTo: r.assignedTo,
          projectId: r.projectId,
          competitorId: r.competitorId,
          productId: r.productId,
          createdAt: r.createdAt,
        })),
        recentActivity: recentActivity.slice(0, 10),
        competitorScores: competitorScores.sort((a, b) => b.score - a.score).slice(0, 10),
        projects: projects.map(p => ({
          id: p.id,
          name: p.name,
          clientName: p.clientName,
          status: p.status,
          analysisType: p.analysisType,
        })),
        tenantUsers: tenantUsers.map((u: User) => ({
          id: u.id,
          name: u.name,
          email: u.email,
        })),
      });
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error("Command center error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Rebuild All - refresh all competitive intelligence (Admin only)
  app.post("/api/rebuild-all", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);

      const user = await storage.getUser(ctx.userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Only content-access roles can trigger rebuild
      if (!hasContentAccess(user.role)) {
        return res.status(403).json({ error: "Access denied - Admin only" });
      }

      if (!await guardManualAction(req, res, "regenerateAll")) return;

      // Use market context filter to get only competitors in active market
      const contextFilter = toContextFilter(ctx);

      // Get all competitors and products that need processing (filtered by market context)
      const allCompetitors = await storage.getCompetitorsByContext(contextFilter);
      const allProducts = await storage.getProductsByContext(contextFilter);
      const projects = await storage.getClientProjectsByContext(contextFilter);

      // Return immediately with job info - actual processing happens async
      const jobId = `rebuild-${Date.now()}`;
      
      // Get total battlecards count for projects
      let projectBattlecardCount = 0;
      for (const project of projects) {
        const battlecards = await storage.getProductBattlecardsByProject(project.id);
        projectBattlecardCount += battlecards.length;
      }

      // Track progress
      let processed = 0;
      const total = allCompetitors.length + allProducts.length + projectBattlecardCount;

      // Start async processing
      (async () => {
        const anthropic = new Anthropic({
          apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
          baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
        });

        // Process competitors - crawl and analyze
        for (const competitor of allCompetitors) {
          try {
            // Always process if never crawled (no analysisData)
            const hasBeenAnalyzed = competitor.analysisData && Object.keys(competitor.analysisData).length > 0;
            
            // Skip if recently crawled (within 24 hours) AND already has analysis data
            if (hasBeenAnalyzed && competitor.lastFullCrawl) {
              const hoursSinceCrawl = (Date.now() - new Date(competitor.lastFullCrawl).getTime()) / (1000 * 60 * 60);
              if (hoursSinceCrawl < 24) {
                processed++;
                continue;
              }
            }

            // Website crawl removed — skip crawl-dependent analysis
            console.log(`[Batch Analysis] Skipping crawl for ${competitor.name} (crawl feature removed)`);

          } catch (error) {
            console.error(`Error processing competitor ${competitor.name}:`, error);
          }
          processed++;
        }

        // Process products - analyze if needed
        for (const product of allProducts) {
          try {
            if (product.analysisData) {
              processed++;
              continue; // Already analyzed
            }

            if (!product.url) {
              processed++;
              continue; // No URL to crawl
            }

            // Website crawl removed — skip crawl-dependent analysis
            console.log(`[Batch Analysis] Skipping crawl for product ${product.name} (crawl feature removed)`);

          } catch (error) {
            console.error(`Error processing product ${product.name}:`, error);
          }
          processed++;
        }

        // Process projects - regenerate product battlecards
        for (const project of projects) {
          try {
            // Get existing product battlecards for this project
            const existingBattlecards = await storage.getProductBattlecardsByProject(project.id);
            
            for (const battlecard of existingBattlecards) {
              try {
                // Get the products
                const baselineProduct = await storage.getProduct(battlecard.baselineProductId);
                const competitorProduct = await storage.getProduct(battlecard.competitorProductId);
                
                if (!baselineProduct || !competitorProduct) continue;

                // Regenerate battlecard using updated product analysis data
                const battlecardPrompt = `Generate a competitive sales battlecard comparing these two products:

BASELINE PRODUCT (Our Product):
Name: ${baselineProduct.name}
Company: ${baselineProduct.companyName || "Unknown"}
Analysis: ${JSON.stringify(baselineProduct.analysisData || {}, null, 2)}

COMPETITOR PRODUCT:
Name: ${competitorProduct.name}
Company: ${competitorProduct.companyName || "Unknown"}  
Analysis: ${JSON.stringify(competitorProduct.analysisData || {}, null, 2)}

Generate a comprehensive battlecard in this JSON format:
{
  "strengths": ["competitor strength 1", "competitor strength 2"],
  "weaknesses": ["competitor weakness 1", "competitor weakness 2"],
  "ourAdvantages": ["our advantage 1", "our advantage 2"],
  "keyDifferentiators": [{"feature": "feature name", "ours": "our capability", "theirs": "their capability"}],
  "objections": [{"objection": "common objection", "response": "how to respond"}],
  "talkTracks": [{"scenario": "scenario name", "script": "what to say"}]
}`;

                const battlecardResponse = await anthropic.messages.create({
                  model: "claude-sonnet-4-5",
                  max_tokens: 3000,
                  messages: [{ role: "user", content: battlecardPrompt }],
                });

                const battlecardText = battlecardResponse.content[0].type === "text" 
                  ? battlecardResponse.content[0].text : "";
                
                let battlecardData: any = {};
                try {
                  const jsonMatch = battlecardText.match(/\{[\s\S]*\}/);
                  if (jsonMatch) {
                    battlecardData = JSON.parse(jsonMatch[0]);
                  }
                } catch (e) {
                  console.error("Failed to parse battlecard:", e);
                }

                await storage.updateProductBattlecard(battlecard.id, {
                  strengths: battlecardData.strengths || battlecard.strengths,
                  weaknesses: battlecardData.weaknesses || battlecard.weaknesses,
                  ourAdvantages: battlecardData.ourAdvantages || battlecard.ourAdvantages,
                  keyDifferentiators: battlecardData.keyDifferentiators || battlecard.keyDifferentiators,
                  objections: battlecardData.objections || battlecard.objections,
                  talkTracks: battlecardData.talkTracks || battlecard.talkTracks,
                  lastGeneratedAt: new Date(),
                });

              } catch (error) {
                console.error(`Error regenerating battlecard ${battlecard.id}:`, error);
              }
              processed++;
            }

          } catch (error) {
            console.error(`Error processing project ${project.name}:`, error);
          }
        }

        console.log(`Rebuild all completed: ${processed}/${total} items processed, ${projects.length} projects refreshed`);
      })();

      res.json({
        success: true,
        jobId,
        message: "Rebuild started",
        totalItems: total,
        competitors: allCompetitors.length,
        products: allProducts.length,
        projects: projects.length,
      });
    } catch (error: any) {
      console.error("Rebuild all error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Update recommendation status (accept/dismiss/assign)
  app.patch("/api/recommendations/:id", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const { status, assignedTo } = req.body;
      const tenantDomain = user.email.split("@")[1];

      // Validate status value
      const allowedStatuses = ["pending", "accepted", "dismissed"];
      if (status && !allowedStatuses.includes(status)) {
        return res.status(400).json({ error: `Invalid status. Must be one of: ${allowedStatuses.join(", ")}` });
      }

      const recommendation = await storage.getRecommendation(req.params.id);
      if (!recommendation) {
        return res.status(404).json({ error: "Recommendation not found" });
      }

      if (recommendation.tenantDomain !== tenantDomain && user.role !== "Global Admin") {
        return res.status(403).json({ error: "Access denied" });
      }

      // Validate assignedTo belongs to same tenant
      if (assignedTo) {
        const assignee = await storage.getUser(assignedTo);
        if (!assignee) {
          return res.status(400).json({ error: "Assigned user not found" });
        }
        const assigneeDomain = assignee.email.split("@")[1];
        if (assigneeDomain !== tenantDomain && user.role !== "Global Admin") {
          return res.status(400).json({ error: "Cannot assign to user outside your organization" });
        }
      }

      const updates: any = {};
      if (status) {
        updates.status = status;
        if (status === "accepted") updates.acceptedAt = new Date();
        if (status === "dismissed") updates.dismissedAt = new Date();
      }
      if (assignedTo !== undefined) {
        updates.assignedTo = assignedTo;
      }

      const updated = await storage.updateRecommendation(req.params.id, updates);
      res.json(updated);
    } catch (error: any) {
      console.error("Update recommendation error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Delete a recommendation
  app.delete("/api/recommendations/:id", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      
      const recommendation = await storage.getRecommendation(req.params.id);
      if (!recommendation) {
        return res.status(404).json({ error: "Recommendation not found" });
      }

      if (recommendation.tenantDomain !== ctx.tenantDomain && ctx.userRole !== "Global Admin") {
        return res.status(403).json({ error: "Access denied" });
      }

      await storage.deleteRecommendation(req.params.id);
      res.json({ success: true, message: "Recommendation deleted" });
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error("Delete recommendation error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Vote on a recommendation (thumbs up/down)
  app.post("/api/recommendations/:id/vote", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const { vote } = req.body; // "up" or "down"
      if (!vote || !["up", "down"].includes(vote)) {
        return res.status(400).json({ error: "Vote must be 'up' or 'down'" });
      }

      const tenantDomain = user.email.split("@")[1];
      const recommendation = await storage.getRecommendation(req.params.id);
      if (!recommendation) {
        return res.status(404).json({ error: "Recommendation not found" });
      }

      if (recommendation.tenantDomain !== tenantDomain && user.role !== "Global Admin") {
        return res.status(403).json({ error: "Access denied" });
      }

      const updates = vote === "up"
        ? { thumbsUp: (recommendation.thumbsUp || 0) + 1 }
        : { thumbsDown: (recommendation.thumbsDown || 0) + 1 };

      const updated = await storage.updateRecommendation(req.params.id, updates);
      res.json(updated);
    } catch (error: any) {
      console.error("Vote on recommendation error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Toggle priority on a recommendation
  app.post("/api/recommendations/:id/priority", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const tenantDomain = user.email.split("@")[1];
      const recommendation = await storage.getRecommendation(req.params.id);
      if (!recommendation) {
        return res.status(404).json({ error: "Recommendation not found" });
      }

      if (recommendation.tenantDomain !== tenantDomain && user.role !== "Global Admin") {
        return res.status(403).json({ error: "Access denied" });
      }

      const updated = await storage.updateRecommendation(req.params.id, {
        isPriority: !recommendation.isPriority,
      });
      res.json(updated);
    } catch (error: any) {
      console.error("Toggle priority error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Soft hide (dismiss) a recommendation with reason
  app.post("/api/recommendations/:id/hide", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const { reason } = req.body; // already_done, not_relevant, duplicate, other
      const allowedReasons = ["already_done", "not_relevant", "duplicate", "other"];
      if (reason && !allowedReasons.includes(reason)) {
        return res.status(400).json({ error: `Reason must be one of: ${allowedReasons.join(", ")}` });
      }

      const tenantDomain = user.email.split("@")[1];
      const recommendation = await storage.getRecommendation(req.params.id);
      if (!recommendation) {
        return res.status(404).json({ error: "Recommendation not found" });
      }

      if (recommendation.tenantDomain !== tenantDomain && user.role !== "Global Admin") {
        return res.status(403).json({ error: "Access denied" });
      }

      // Generate dedupe key from title + area (normalized)
      const dedupeKey = `${recommendation.title.toLowerCase().replace(/[^a-z0-9]/g, "")}_${recommendation.area.toLowerCase()}`;

      const updated = await storage.updateRecommendation(req.params.id, {
        status: "dismissed",
        dismissedAt: new Date(),
        dismissedReason: reason || "not_relevant",
        dismissedBy: user.id,
        dedupeKey,
      });
      res.json(updated);
    } catch (error: any) {
      console.error("Hide recommendation error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Restore a hidden recommendation
  app.post("/api/recommendations/:id/restore", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const tenantDomain = user.email.split("@")[1];
      const recommendation = await storage.getRecommendation(req.params.id);
      if (!recommendation) {
        return res.status(404).json({ error: "Recommendation not found" });
      }

      if (recommendation.tenantDomain !== tenantDomain && user.role !== "Global Admin") {
        return res.status(403).json({ error: "Access denied" });
      }

      const updated = await storage.updateRecommendation(req.params.id, {
        status: "pending",
        dismissedAt: null,
        dismissedReason: null,
        dismissedBy: null,
      });
      res.json(updated);
    } catch (error: any) {
      console.error("Restore recommendation error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Mark recommendation as actioned (content created from it)
  app.post("/api/recommendations/:id/action", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const tenantDomain = user.email.split("@")[1];
      const recommendation = await storage.getRecommendation(req.params.id);
      if (!recommendation) return res.status(404).json({ error: "Recommendation not found" });
      if (recommendation.tenantDomain !== tenantDomain && user.role !== "Global Admin") {
        return res.status(403).json({ error: "Access denied" });
      }

      const { actionType } = req.body;
      if (actionType !== undefined && typeof actionType !== "string") {
        return res.status(400).json({ error: "Invalid actionType; expected a string if provided." });
      }

      const updated = await storage.updateRecommendation(req.params.id, {
        status: "accepted",
        acceptedAt: new Date(),
      });
      res.json(updated);
    } catch (error: any) {
      console.error("Action recommendation error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== AI CACHE ADMIN ====================

  app.get("/api/admin/ai-cache/stats", async (req, res) => {
    try {
      if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
      const user = await storage.getUser(req.session.userId);
      if (!user || user.role !== "Global Admin") return res.status(403).json({ error: "Access denied" });
      res.json(getCacheStats());
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/ai-cache/invalidate", async (req, res) => {
    try {
      if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
      const user = await storage.getUser(req.session.userId);
      if (!user || user.role !== "Global Admin") return res.status(403).json({ error: "Access denied" });
      const { tenantDomain } = req.body as { tenantDomain?: string };
      if (tenantDomain) {
        const removed = invalidateTenantCache(tenantDomain);
        res.json({ removed, scope: tenantDomain });
      } else {
        const removed = clearAICache();
        res.json({ removed, scope: "all" });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== JOB DEAD-LETTER QUEUE ====================

  app.get("/api/admin/queue-dead-letter", async (req, res) => {
    try {
      if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
      const user = await storage.getUser(req.session.userId);
      if (!user || user.role !== "Global Admin") return res.status(403).json({ error: "Access denied" });
      res.json(getDeadLetterJobs());
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/admin/queue-dead-letter/:jobId", async (req, res) => {
    try {
      if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
      const user = await storage.getUser(req.session.userId);
      if (!user || user.role !== "Global Admin") return res.status(403).json({ error: "Access denied" });
      const removed = dismissDeadLetterJob(req.params.jobId);
      if (!removed) return res.status(404).json({ error: "Job not found in dead-letter queue" });
      res.json({ dismissed: true, jobId: req.params.jobId });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

}
