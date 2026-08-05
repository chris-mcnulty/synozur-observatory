import { storage } from "../storage";
import { monitorCompetitorPricing, monitorBaselinePricing } from "./pricing-intelligence";
import { analyzeCompetitorWebsite, type LinkedInContext } from "../ai-service";
import { processTrialReminders } from "./trial-service";
import { sendWeeklyDigestEmail, sendScheduledBriefingEmail, type BriefingDigestData } from "./email-service";
import { generateBriefing, type BriefingData } from "./intelligence-briefing-service";
import { notifications } from "./notifications";
import { checkFeatureAccessAsync } from "./plan-policy";
import { identifySuggestedAssets } from "./asset-suggestion-service";
import {
  getValidGraphToken,
  renewGraphSubscription,
} from "./planner-graph-client";
import { tickMarketingPublishWorker, sweepMissedPosts } from "./marketing-publish-worker";
import { tickEmailSendWorker } from "./email-campaign-sender";
import { tickHubspotEmailSyncBackfill } from "./hubspot-email-backfill";
import { refreshSeoForContext } from "../routes/seo";
import { db } from "../db";
import { marketingPlans, seoMetrics, trackedKeywords, collaborationComments, collaborationThreads, annotations, generatedPosts, scheduledJobRuns, obsAssessments, obsApplications, obsPerformanceScans, type SeoMetric } from "@shared/schema";
import { eq, and, desc, isNull, lt, sql, inArray, ne } from "drizzle-orm";
import { isPerfScanDue, runScheduledPerfScan } from "./perf-scan-schedule-core";
import { enqueueMonitor } from "./job-queue";
import type { SeoMover } from "./webhook-formatters";

/** Minimum elapsed time before re-queuing a pricing monitor (7 days). */
const PRICING_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// Cache for market status to avoid repeated DB queries
const marketStatusCache: Map<string, { status: string; timestamp: number }> = new Map();
const CACHE_TTL_MS = 60 * 1000; // 1 minute (reduced TTL for faster response to status changes)

async function isMarketArchived(marketId: string | null): Promise<boolean> {
  if (!marketId) return false; // Default market or no market = not archived
  
  // Check cache first
  const cached = marketStatusCache.get(marketId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.status === "archived";
  }
  
  // Fetch from DB
  const market = await storage.getMarket(marketId);
  if (market) {
    marketStatusCache.set(marketId, { status: market.status, timestamp: Date.now() });
    return market.status === "archived";
  }
  
  return false;
}

// Invalidate cache entry when market status changes
export function invalidateMarketStatusCache(marketId: string): void {
  marketStatusCache.delete(marketId);
}

interface JobStatus {
  lastRun: Date | null;
  isRunning: boolean;
  nextRun: Date | null;
  abortController: AbortController | null;
}

interface JobRunContext {
  jobRunId: string;
  tenantDomain?: string;
  targetId?: string;
}

async function trackJobStart(
  jobType: string,
  tenantDomain?: string,
  targetId?: string,
  targetName?: string,
  jobLabel?: string,
): Promise<string> {
  try {
    // Job-lifecycle telemetry goes through the dedicated crawl pool, never the
    // primary pool — these writes fire on every scheduled crawl/monitor job and
    // must not compete with time-sensitive workers (publish/email).
    const [jobRun] = await db
      .insert(scheduledJobRuns)
      .values({
        jobType,
        tenantDomain: tenantDomain || null,
        targetId: targetId || null,
        targetName: targetName || null,
        jobLabel: jobLabel || null,
        status: "running",
        startedAt: new Date(),
      })
      .returning();
    return jobRun.id;
  } catch (error) {
    console.error(`[Job Tracking] Failed to track job start:`, error);
    return "";
  }
}

async function trackJobComplete(
  jobRunId: string,
  status: "completed" | "failed",
  result?: Record<string, any>,
  errorMessage?: string
): Promise<void> {
  if (!jobRunId) return;
  try {
    const [updated] = await db
      .update(scheduledJobRuns)
      .set({
        status,
        completedAt: new Date(),
        result: result || null,
        errorMessage: errorMessage || null,
      })
      .where(eq(scheduledJobRuns.id, jobRunId))
      .returning();

    if (status === "failed" && updated?.tenantDomain) {
      await notifications.dispatch(updated.tenantDomain, "job_failed", {
        jobType: updated.jobType || "scheduled_job",
        targetName: updated.targetName || undefined,
        error: errorMessage || "Unknown error",
        attempts: 1,
      });
    }
  } catch (error) {
    console.error(`[Job Tracking] Failed to track job completion:`, error);
  }
}

// Clean up jobs that have been running for too long (stuck jobs)
async function cleanupStuckJobs(): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  // Read/write stuck-job telemetry through the crawl pool (keeps the primary
  // pool free for time-sensitive work).
  const stuckJobs = await db
    .select()
    .from(scheduledJobRuns)
    .where(eq(scheduledJobRuns.status, "running"));
  
  const jobsToFail = stuckJobs.filter(job => {
    if (!job.startedAt) return true;
    return new Date(job.startedAt) < oneHourAgo;
  });
  
  if (jobsToFail.length > 0) {
    console.log(`[Scheduled Jobs] Cleaning up ${jobsToFail.length} stuck job(s)...`);
    for (const job of jobsToFail) {
      try {
        await db
          .update(scheduledJobRuns)
          .set({
            status: "failed",
            completedAt: new Date(),
            result: { error: "Job timed out - automatically marked as failed after running too long" },
            errorMessage: "Job timed out after 1 hour",
          })
          .where(eq(scheduledJobRuns.id, job.id));
        console.log(`[Scheduled Jobs] Marked stuck job ${job.id} (${job.jobType}) as failed`);
      } catch (error) {
        console.error(`[Scheduled Jobs] Failed to clean up stuck job ${job.id}:`, error);
      }
    }
  } else {
    console.log("[Scheduled Jobs] No stuck jobs to clean up");
  }
}

async function trackJobRun<T>(
  jobType: string,
  tenantDomain: string,
  targetId: string,
  targetName: string,
  work: () => Promise<T>,
  options?: { onError?: () => Promise<void> }
): Promise<string | null> {
  const jobRunId = await trackJobStart(jobType, tenantDomain, targetId, targetName);
  if (!jobRunId) return null;
  
  try {
    const result = await work();
    await trackJobComplete(jobRunId, "completed", result as Record<string, any>);
    return jobRunId;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await trackJobComplete(jobRunId, "failed", undefined, errorMessage);
    console.error(`[Scheduled Job] Job failed for ${targetName}:`, error);
    if (options?.onError) {
      try { await options.onError(); } catch (e) { console.error(`[Scheduled Job] onError callback failed:`, e); }
    }
    return jobRunId;
  }
}

const jobStatus: Record<string, JobStatus> = {
  pricingMonitor: { lastRun: null, isRunning: false, nextRun: null, abortController: null },
  trialReminder: { lastRun: null, isRunning: false, nextRun: null, abortController: null },
  weeklyDigest: { lastRun: null, isRunning: false, nextRun: null, abortController: null },
  seoRefresh: { lastRun: null, isRunning: false, nextRun: null, abortController: null },
  hubspotSync: { lastRun: null, isRunning: false, nextRun: null, abortController: null },
  outreachCadence: { lastRun: null, isRunning: false, nextRun: null, abortController: null },
};

function getIntervalMs(frequency: string): number {
  switch (frequency) {
    case "daily":
      return 24 * 60 * 60 * 1000;
    case "weekly":
      return 7 * 24 * 60 * 60 * 1000;
    default:
      return 0;
  }
}

async function runPricingMonitorJob(): Promise<void> {
  if (jobStatus.pricingMonitor.isRunning) {
    console.log("[Scheduled Job] Pricing monitor already running, skipping...");
    return;
  }

  const abortController = new AbortController();
  jobStatus.pricingMonitor.abortController = abortController;
  jobStatus.pricingMonitor.isRunning = true;
  console.log("[Scheduled Job] Starting pricing monitor job...");

  const sweepMetrics = { totalChecked: 0, monitorsExecuted: 0, monitorsSkippedNoUrl: 0, monitorsSkippedFresh: 0, monitorsSkippedPlan: 0 };

  try {
    const tenants = await storage.getAllTenants();

    for (const tenant of tenants) {
      if (abortController.signal.aborted) {
        console.log("[Scheduled Job] Pricing monitor job was cancelled");
        break;
      }
      if (tenant.status !== "active") continue;

      // Plan gate — pricing intelligence is Pro+. Skip free / trial tenants.
      const planGate = await checkFeatureAccessAsync(tenant.plan, "pricingIntelligence");
      if (!planGate.allowed) {
        sweepMetrics.monitorsSkippedPlan++;
        continue;
      }

      const frequency = tenant.monitoringFrequency || "weekly";
      if (frequency === "disabled") continue;

      const competitors = await storage.getCompetitorsByTenantDomain(tenant.domain);

      for (const competitor of competitors) {
        sweepMetrics.totalChecked++;

        if (!competitor.pricingPageUrl) {
          sweepMetrics.monitorsSkippedNoUrl++;
          continue;
        }
        if (await isMarketArchived(competitor.marketId)) continue;
        if (competitor.excludeFromCrawl) continue;

        const lastCheck = competitor.lastPricingCheck
          ? new Date(competitor.lastPricingCheck).getTime()
          : 0;
        const now = Date.now();
        if (now - lastCheck < PRICING_MIN_INTERVAL_MS) {
          sweepMetrics.monitorsSkippedFresh++;
          continue;
        }

        sweepMetrics.monitorsExecuted++;
        console.log(`[Scheduled Job] Queuing pricing monitor for ${competitor.name}...`);

        enqueueMonitor(`pricing:${competitor.name}`, (signal) => trackJobRun(
          "pricingMonitor",
          tenant.domain,
          competitor.id,
          `Competitor: ${competitor.name}`,
          async () => {
            if (signal?.aborted) throw new Error("Pricing monitor aborted");
            const result = await monitorCompetitorPricing(competitor.id, {
              userId: competitor.userId,
              tenantDomain: tenant.domain,
              signal,
            });
            // Stamp lastPricingCheck on every outcome so persistently-failing
            // competitors don't re-queue every 6h. The service only stamps on
            // success (so the freshness UI reflects "last successful capture");
            // here we additionally stamp on no_content / error / no_url so the
            // scheduler's 7-day gate engages regardless of result.
            if (result.status !== "success") {
              await storage.updateCompetitor(competitor.id, { lastPricingCheck: new Date() })
                .catch((err) => console.error(`[Scheduled Job] lastPricingCheck stamp on ${result.status} failed for ${competitor.name}:`, err.message));
            }
            return {
              status: result.status,
              entityType: "competitor",
              url: competitor.pricingPageUrl,
              hasChanges: result.hasChanges,
              changeScore: result.changeScore,
            };
          },
        )).catch((err) => {
          console.error(`[Scheduled Job] Queued pricing monitor failed for ${competitor.name}:`, err.message);
        });
      }

      // Monitor baseline company pricing
      const companyProfiles = await storage.getCompanyProfilesByTenantDomain(tenant.domain);
      for (const profile of companyProfiles) {
        if (!profile.pricingPageUrl) continue;
        if (await isMarketArchived(profile.marketId)) continue;

        const lastCheck = profile.lastPricingCheck
          ? new Date(profile.lastPricingCheck).getTime()
          : 0;
        const now = Date.now();
        if (now - lastCheck < PRICING_MIN_INTERVAL_MS) continue;

        sweepMetrics.monitorsExecuted++;
        console.log(`[Scheduled Job] Queuing baseline pricing monitor for ${profile.companyName}...`);

        enqueueMonitor(`pricing:baseline:${profile.companyName}`, (signal) => trackJobRun(
          "pricingMonitor",
          tenant.domain,
          profile.id,
          `Baseline: ${profile.companyName}`,
          async () => {
            if (signal?.aborted) throw new Error("Baseline pricing monitor aborted");
            const result = await monitorBaselinePricing(profile.id, {
              userId: profile.userId,
              tenantDomain: tenant.domain,
              signal,
            });
            if (result.status !== "success") {
              await storage.updateCompanyProfile(profile.id, { lastPricingCheck: new Date() })
                .catch((err) => console.error(`[Scheduled Job] lastPricingCheck stamp on ${result.status} failed for baseline ${profile.companyName}:`, err.message));
            }
            return {
              status: result.status,
              entityType: "baseline",
              url: profile.pricingPageUrl,
              hasChanges: result.hasChanges,
              changeScore: result.changeScore,
            };
          },
        )).catch((err) => {
          console.error(`[Scheduled Job] Queued baseline pricing monitor failed for ${profile.companyName}:`, err.message);
        });
      }
    }
  } catch (error) {
    console.error("[Scheduled Job] Pricing monitor job failed:", error);
  } finally {
    jobStatus.pricingMonitor.isRunning = false;
    jobStatus.pricingMonitor.abortController = null;
    jobStatus.pricingMonitor.lastRun = new Date();
    console.log(
      `[Scheduled Job] Pricing monitor sweep completed — total checked: ${sweepMetrics.totalChecked}, ` +
      `queued: ${sweepMetrics.monitorsExecuted}, no_url: ${sweepMetrics.monitorsSkippedNoUrl}, ` +
      `fresh: ${sweepMetrics.monitorsSkippedFresh}, plan_blocked: ${sweepMetrics.monitorsSkippedPlan}`
    );
  }
}


async function runTrialReminderJob(): Promise<void> {
  if (jobStatus.trialReminder.isRunning) {
    console.log("[Scheduled Job] Trial reminder already running, skipping...");
    return;
  }

  jobStatus.trialReminder.isRunning = true;
  console.log("[Scheduled Job] Starting trial reminder job...");
  const jobRunId = await trackJobStart("trial_reminder");

  try {
    const baseUrl = process.env.REPLIT_DEV_DOMAIN 
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : process.env.REPLIT_DEPLOYMENT_URL 
        ? `https://${process.env.REPLIT_DEPLOYMENT_URL}`
        : 'https://orbit.synozur.com';
    
    const result = await processTrialReminders(baseUrl);
    console.log(`[Scheduled Job] Trial reminder job completed: ${result.processed} processed, ${result.errors} errors`);
    await trackJobComplete(jobRunId, "completed", { processed: result.processed, errors: result.errors });
  } catch (error) {
    console.error("[Scheduled Job] Trial reminder job failed:", error);
    await trackJobComplete(jobRunId, "failed", undefined, String(error));
  } finally {
    jobStatus.trialReminder.isRunning = false;
    jobStatus.trialReminder.lastRun = new Date();
  }
}

const WEEKLY_DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function checkAndRunWeeklyDigest(): Promise<void> {
  try {
    const recentRuns = await storage.getScheduledJobRunsByType("weeklyDigest");
    const lastCompleted = recentRuns.find((r: { status: string; completedAt: Date | null }) => r.status === "completed");
    
    if (lastCompleted?.completedAt) {
      const elapsed = Date.now() - new Date(lastCompleted.completedAt).getTime();
      if (elapsed < WEEKLY_DIGEST_INTERVAL_MS) {
        return;
      }
    }
    
    console.log("[Scheduled Job] Weekly digest is overdue, triggering now...");
    await runWeeklyDigestJob();
  } catch (err) {
    console.error("[Scheduled Job] Error checking weekly digest schedule:", err);
  }
}

const tenantBriefingCache: Map<string, { briefingId: string; briefingData: BriefingData } | null> = new Map();

async function generateBriefingForTenant(tenantDomain: string): Promise<{ briefingId: string; briefingData: BriefingData } | null> {
  if (tenantBriefingCache.has(tenantDomain)) {
    return tenantBriefingCache.get(tenantDomain) || null;
  }

  try {
    console.log(`[Scheduled Job] Generating intelligence briefing for tenant ${tenantDomain}...`);
    const briefing = await generateBriefing(tenantDomain, 7);
    const result = {
      briefingId: briefing.id,
      briefingData: briefing.briefingData as BriefingData,
    };
    tenantBriefingCache.set(tenantDomain, result);
    return result;
  } catch (error) {
    console.error(`[Scheduled Job] Failed to generate briefing for ${tenantDomain}:`, error);
    tenantBriefingCache.set(tenantDomain, null);
    return null;
  }
}

async function runWeeklyDigestJob(): Promise<void> {
  if (jobStatus.weeklyDigest.isRunning) {
    console.log("[Scheduled Job] Weekly digest already running, skipping...");
    return;
  }

  jobStatus.weeklyDigest.isRunning = true;
  console.log("[Scheduled Job] Starting weekly digest job...");

  const jobRun = await storage.createScheduledJobRun({
    jobType: "weeklyDigest",
    status: "running",
    startedAt: new Date(),
  });

  try {
    const usersWithDigest = await storage.getUsersWithDigestEnabled();
    console.log(`[Scheduled Job] Found ${usersWithDigest.length} users with digest enabled`);

    tenantBriefingCache.clear();

    // Group recipients by tenant so the central dispatcher emails each
    // user and fires the tenant webhook exactly once per tenant per run.
    const tenantsToDigest = new Set<string>();
    for (const user of usersWithDigest) {
      const domain = user.email.split("@")[1];
      if (domain) tenantsToDigest.add(domain);
    }

    let dispatched = 0;
    let errorCount = 0;
    for (const domain of Array.from(tenantsToDigest)) {
      try {
        const ctx = await buildWeeklyDigestCtx(domain);
        if (!ctx) continue;
        await notifications.dispatch(domain, "weekly_digest", ctx);
        dispatched++;
      } catch (tenantErr) {
        console.error(`[Scheduled Job] Weekly digest dispatch failed for ${domain}:`, tenantErr);
        errorCount++;
      }
    }

    tenantBriefingCache.clear();

    console.log(`[Scheduled Job] Weekly digest job completed: ${dispatched} tenant(s), ${errorCount} errors`);
    await storage.updateScheduledJobRun(jobRun.id, {
      status: "completed",
      completedAt: new Date(),
      result: { tenantsDispatched: dispatched, errorCount },
    });
  } catch (error) {
    console.error("[Scheduled Job] Weekly digest job failed:", error);
    await storage.updateScheduledJobRun(jobRun.id, {
      status: "failed",
      completedAt: new Date(),
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  } finally {
    jobStatus.weeklyDigest.isRunning = false;
    jobStatus.weeklyDigest.lastRun = new Date();
    tenantBriefingCache.clear();
  }
}

function getBaseUrl(): string {
  return process.env.REPLIT_DEV_DOMAIN 
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : process.env.REPLIT_DEPLOYMENT_URL 
      ? `https://${process.env.REPLIT_DEPLOYMENT_URL}`
      : 'https://orbit.synozur.com';
}

/**
 * Build the activities + briefing payload for a tenant's weekly digest.
 * Returns null if the tenant is missing/inactive.
 */
async function buildWeeklyDigestCtx(tenantDomain: string): Promise<{
  activities: { competitorName: string; type: string; description: string; summary?: string }[];
  briefing?: BriefingDigestData;
} | null> {
  const tenant = await storage.getTenantByDomain(tenantDomain);
  if (!tenant || tenant.status !== "active") return null;

  const weeklyActivity = await storage.getWeeklyActivityByTenant(tenantDomain);
  const activities = weeklyActivity.map(act => ({
    competitorName: act.competitorName,
    type: act.type,
    description: act.description,
    summary: act.summary || undefined,
  }));

  const tenantBriefing = await generateBriefingForTenant(tenantDomain);
  const briefing = tenantBriefing ? {
    executiveSummary: tenantBriefing.briefingData.executiveSummary,
    actionItems: tenantBriefing.briefingData.actionItems || [],
    riskAlerts: tenantBriefing.briefingData.riskAlerts || [],
    briefingId: tenantBriefing.briefingId,
  } : undefined;

  return { activities, briefing };
}

/**
 * Admin-triggered "send digest now" for a single user. Bypasses the tenant
 * fan-out and webhook delivery — this is a UI action, not a tenant event.
 */
export async function sendDigestNowForUser(userId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await storage.getUser(userId);
    if (!user) return { success: false, error: "User not found" };

    const domain = user.email.split("@")[1];
    if (!domain) return { success: false, error: "Invalid email domain" };

    const tenant = await storage.getTenantByDomain(domain);
    if (!tenant || tenant.status !== "active") {
      return { success: false, error: "Tenant is not active" };
    }

    const ctx = await buildWeeklyDigestCtx(domain);
    if (!ctx) return { success: false, error: "Failed to build digest context" };

    const sent = await sendWeeklyDigestEmail({
      email: user.email,
      name: user.name,
      companyName: tenant.name,
      activities: ctx.activities,
      baseUrl: getBaseUrl(),
      briefing: ctx.briefing,
    });

    if (sent) return { success: true };
    return { success: false, error: "Failed to send email. Check that your tenant is active and email service is configured." };
  } catch (err) {
    console.error(`[Digest] Error sending on-demand digest for user ${userId}:`, err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

async function runScheduledBriefingJob(): Promise<void> {
  if (jobStatus.scheduledBriefing?.isRunning) {
    console.log("[Scheduled Job] Scheduled briefing already running, skipping...");
    return;
  }

  if (!jobStatus.scheduledBriefing) {
    jobStatus.scheduledBriefing = { lastRun: null, isRunning: false, nextRun: null, abortController: null };
  }
  jobStatus.scheduledBriefing.isRunning = true;
  console.log("[Scheduled Job] Starting scheduled briefing job...");

  const jobRun = await storage.createScheduledJobRun({
    jobType: "scheduledBriefing",
    status: "running",
    startedAt: new Date(),
  });

  try {
    const baseUrl = getBaseUrl();
    const enabledConfigs = await storage.getEnabledScheduledBriefingConfigs();
    if (enabledConfigs.length === 0) {
      console.log("[Scheduled Briefing] No enabled scheduled briefing configs found, skipping.");
      await storage.updateScheduledJobRun(jobRun.id, {
        status: "completed",
        completedAt: new Date(),
        result: { generatedCount: 0, emailsSent: 0, errorCount: 0, skipped: "no_configs" },
      });
      return;
    }

    let generatedCount = 0;
    let emailsSent = 0;
    let errorCount = 0;

    const configsByTenant = new Map<string, typeof enabledConfigs>();
    for (const config of enabledConfigs) {
      if (!configsByTenant.has(config.tenantDomain)) configsByTenant.set(config.tenantDomain, []);
      configsByTenant.get(config.tenantDomain)!.push(config);
    }

    for (const [tenantDomain, configs] of Array.from(configsByTenant.entries())) {
      const tenant = await storage.getTenantByDomain(tenantDomain);
      if (!tenant || tenant.status !== "active") continue;

      const featureCheck = await checkFeatureAccessAsync(tenant.plan, "scheduledBriefingUpdates");
      if (!featureCheck.allowed) continue;

      const podcastCheck = await checkFeatureAccessAsync(tenant.plan, "podcastBriefings");

      for (const config of configs) {
        const marketId = config.marketId || undefined;

        const subscribers = await storage.getEnabledBriefingSubscribers(tenantDomain, marketId);
        if (subscribers.length === 0) {
          console.log(`[Scheduled Briefing] No subscribers for ${tenantDomain} market=${marketId}, skipping.`);
          continue;
        }

        console.log(`[Scheduled Briefing] Processing ${tenantDomain} market=${marketId}: ${subscribers.length} subscribers`);

        try {
          const briefing = await generateBriefing(tenantDomain, 7, marketId);
          if (!briefing || !briefing.briefingData) {
            console.warn(`[Scheduled Briefing] No briefing data for ${tenantDomain} market=${marketId}`);
            continue;
          }
          generatedCount++;

          const briefingData = briefing.briefingData as BriefingData;

          // Look up baseline company for this market so emails clearly identify which market the report covers
          let baselineCompanyName: string | undefined;
          if (marketId) {
            try {
              const market = await storage.getMarket(marketId);
              const baselineProfile = await storage.getCompanyProfileByContext({
                tenantDomain,
                marketId,
                isDefaultMarket: false,
              });
              baselineCompanyName = baselineProfile?.companyName || market?.name || undefined;
            } catch {
              // non-fatal — email still sends without the anchor label
            }
          }

          let podcastUrl: string | undefined;

          if (podcastCheck.allowed) {
            try {
              const { generatePodcastAudio } = await import("./podcast-audio-generator");
              podcastUrl = await generatePodcastAudio(briefing.id, briefingData);
              console.log(`[Scheduled Briefing] Podcast generated for ${tenantDomain} market=${marketId}`);
            } catch (podcastErr) {
              console.error(`[Scheduled Briefing] Podcast generation failed for ${tenantDomain} market=${marketId}:`, podcastErr);
            }
          }

          for (const sub of subscribers) {
            try {
              const user = await storage.getUser(sub.userId);
              if (!user || !user.email) continue;

              const sent = await sendScheduledBriefingEmail(
                user.email,
                user.name,
                tenant.name,
                {
                  executiveSummary: briefingData.executiveSummary,
                  actionItems: briefingData.actionItems || [],
                  riskAlerts: briefingData.riskAlerts || [],
                  briefingId: briefing.id,
                  periodLabel: briefingData.periodLabel,
                  podcastUrl,
                  baselineCompanyName,
                },
                baseUrl,
              );
              if (sent) emailsSent++;
            } catch (emailErr) {
              console.error(`[Scheduled Briefing] Email failed for user ${sub.userId}:`, emailErr);
              errorCount++;
            }
          }
          // Note: briefing_ready webhook fan-out happens inside
          // intelligence-briefing-service.generateBriefing(), so on-demand
          // and scheduled briefings both fire the webhook from one place.
        } catch (tenantErr) {
          console.error(`[Scheduled Briefing] Failed for ${tenantDomain} market=${marketId}:`, tenantErr);
          errorCount++;
        }
      }
    }

    console.log(`[Scheduled Briefing] Job completed: ${generatedCount} briefings, ${emailsSent} emails, ${errorCount} errors`);
    await storage.updateScheduledJobRun(jobRun.id, {
      status: "completed",
      completedAt: new Date(),
      result: { generatedCount, emailsSent, errorCount },
    });
  } catch (error) {
    console.error("[Scheduled Briefing] Job failed:", error);
    await storage.updateScheduledJobRun(jobRun.id, {
      status: "failed",
      completedAt: new Date(),
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  } finally {
    jobStatus.scheduledBriefing.isRunning = false;
    jobStatus.scheduledBriefing.lastRun = new Date();
  }
}

async function checkAndRunScheduledBriefing(): Promise<void> {
  try {
    const recentRuns = await storage.getScheduledJobRunsByType("scheduledBriefing");
    const lastCompleted = recentRuns.find((r: { status: string; completedAt: Date | null }) => r.status === "completed");

    if (lastCompleted?.completedAt) {
      const elapsed = Date.now() - new Date(lastCompleted.completedAt).getTime();
      if (elapsed < WEEKLY_DIGEST_INTERVAL_MS) {
        return;
      }
    }

    console.log("[Scheduled Job] Scheduled briefing is overdue, triggering now...");
    await runScheduledBriefingJob();
  } catch (err) {
    console.error("[Scheduled Job] Error checking scheduled briefing:", err);
  }
}

// ---------------------------------------------------------------------------
// Planner sync job — syncs all marketing plans that have Planner connected
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Planner subscription auto-renewal — Graph subscriptions on Planner expire
// after ~3 days. We refresh anything within 12 hours of expiration so
// webhook delivery never lapses (Task #104).
// ---------------------------------------------------------------------------

async function runPlannerSubscriptionRenewalJob(): Promise<void> {
  try {
    const subs = await storage.getAllPlannerSubscriptions();
    const renewWindow = Date.now() + 12 * 60 * 60 * 1000;
    let renewed = 0;
    let failed = 0;
    for (const sub of subs) {
      if (sub.expiresAt.getTime() > renewWindow) continue;
      const plan = await db.query.marketingPlans.findFirst({
        where: (p, { eq }) => eq(p.id, sub.planId),
      });
      if (!plan || !plan.plannerConnectedBy) continue;
      const token = await getValidGraphToken(plan.plannerConnectedBy);
      if (!token) {
        await storage.updatePlannerSubscription(sub.planId, {
          lastError: "Planner consent unavailable for renewal",
        });
        failed += 1;
        continue;
      }
      try {
        const renewedSub = await renewGraphSubscription(token, sub.subscriptionId);
        await storage.updatePlannerSubscription(sub.planId, {
          expiresAt: new Date(renewedSub.expirationDateTime),
          lastRenewedAt: new Date(),
          lastError: null,
        });
        renewed += 1;
      } catch (err: any) {
        console.error(`[Planner] Renewal failed for plan ${sub.planId}:`, err.message);
        await storage.updatePlannerSubscription(sub.planId, {
          lastError: err.message,
        });
        failed += 1;
      }
    }
    if (renewed > 0 || failed > 0) {
      console.log(`[Planner Subscription] Renewal sweep: ${renewed} renewed, ${failed} failed`);
    }
  } catch (err: any) {
    console.error("[Planner Subscription] Renewal sweep error:", err.message);
  }
}

let plannerSubscriptionRenewalInterval: NodeJS.Timeout | null = null;

async function runPlannerSyncJob(): Promise<void> {
  if (jobStatus.plannerSync?.isRunning) {
    console.log("[Planner Sync] Job already running, skipping sweep");
    return;
  }
  if (!jobStatus.plannerSync) {
    jobStatus.plannerSync = { lastRun: null, isRunning: false, nextRun: null, abortController: null };
  }
  jobStatus.plannerSync.isRunning = true;
  jobStatus.plannerSync.lastRun = new Date();
  console.log("[Planner Sync] Starting auto-sync sweep...");
  let synced = 0;
  let failed = 0;
  try {
    // Find all marketing plans with Planner sync enabled across all tenants
    const enabledPlans = await db
      .select()
      .from(marketingPlans)
      .where(eq(marketingPlans.plannerSyncEnabled, true));

    const { queuePlannerSyncForPlan } = await import("./planner-service");
    for (const plan of enabledPlans) {
      try {
        const ctx = { tenantDomain: plan.tenantDomain, marketId: plan.marketId };
        // Hand off to the background queue (retry/back-off + DLQ) instead of
        // running sequentially and tying up the sweep on a single slow tenant.
        queuePlannerSyncForPlan(plan.id, ctx);
        synced += 1;
      } catch (planErr: any) {
        failed += 1;
        console.error(`[Planner Sync] Plan ${plan.id} (${plan.tenantDomain}) failed to enqueue:`, planErr.message);
      }
    }
    console.log(`[Planner Sync] Auto-sync sweep complete — ${synced} queued, ${failed} failed to enqueue out of ${enabledPlans.length} connected plans`);
  } catch (err: any) {
    console.error("[Planner Sync] Sweep failed:", err.message);
  } finally {
    jobStatus.plannerSync.isRunning = false;
  }
}

let pricingMonitorInterval: NodeJS.Timeout | null = null;
let trialReminderInterval: NodeJS.Timeout | null = null;
let weeklyDigestInterval: NodeJS.Timeout | null = null;
let scheduledBriefingInterval: NodeJS.Timeout | null = null;
let plannerSyncInterval: NodeJS.Timeout | null = null;
let seoRefreshInterval: NodeJS.Timeout | null = null;

// ---------------------------------------------------------------------------
// SEO refresh job — weekly per (tenant, market) sweep that re-runs SERP
// queries for every tracked keyword and records a row of seo_metrics.
// ---------------------------------------------------------------------------

const SEO_REFRESH_DEFAULT_INTERVAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function getTenantSeoIntervalMs(tenant: { seoRefreshIntervalDays?: number | null }): number {
  const days = tenant.seoRefreshIntervalDays ?? SEO_REFRESH_DEFAULT_INTERVAL_DAYS;
  const clamped = Math.max(1, Math.min(days, 90));
  return clamped * DAY_MS;
}

// ---------------------------------------------------------------------------
// Movement detection — compares the metrics just recorded by a market sweep
// against the most recent prior capture for each (keyword, entity) pair and
// returns the top gainers/losers ready for `notifications.dispatch`.
// ---------------------------------------------------------------------------

const SEO_MOVEMENT_RANK_DELTA_THRESHOLD = 5;
const SEO_MOVEMENT_PAGE_ONE_THRESHOLD = 10;
const SEO_MOVEMENT_TOP_N = 5;
// SerpAPI is queried with num=100, so the worst observable rank is 100.
// Any sentinel beyond that is "worse than not appearing in results", which
// guarantees `null -> rank` is always a positive delta (gain) and
// `rank -> null` is always negative (loss), regardless of the rank value.
const SEO_MOVEMENT_NULL_SENTINEL = 1000;

function isSignificantMovement(prev: number | null, curr: number | null): boolean {
  if (prev === null && curr === null) return false;
  // Entry to / exit from page 1 is always notable.
  const prevOnPageOne = prev !== null && prev <= SEO_MOVEMENT_PAGE_ONE_THRESHOLD;
  const currOnPageOne = curr !== null && curr <= SEO_MOVEMENT_PAGE_ONE_THRESHOLD;
  if (prevOnPageOne !== currOnPageOne) return true;
  // Newly ranked or fell out of results entirely.
  if (prev === null || curr === null) return true;
  // Otherwise require at least the rank-delta threshold.
  return Math.abs(prev - curr) >= SEO_MOVEMENT_RANK_DELTA_THRESHOLD;
}

function moverDelta(prev: number | null, curr: number | null): number {
  // Positive = improvement (rank got smaller). Use a sentinel that is worse
  // than any observable rank so a transition into the SERP from `null` is
  // always a gain and a transition out of the SERP to `null` is always a
  // loss — independent of how deep in the results the ranked side sits.
  const p = prev ?? SEO_MOVEMENT_NULL_SENTINEL;
  const c = curr ?? SEO_MOVEMENT_NULL_SENTINEL;
  return p - c;
}

async function computeSeoMoversForMarket(opts: {
  tenantDomain: string;
  marketId: string | null;
  isDefaultMarket: boolean;
  sweepStart: Date;
}): Promise<{ topGainers: SeoMover[]; topLosers: SeoMover[] }> {
  const { tenantDomain, marketId, isDefaultMarket, sweepStart } = opts;

  const marketCondition = isDefaultMarket
    ? isNull(seoMetrics.marketId)
    : marketId
      ? eq(seoMetrics.marketId, marketId)
      : isNull(seoMetrics.marketId);

  // Pull every metric for the (tenant, market) sorted newest-first. We dedupe
  // down to the latest two rows per (keyword, entity) pair below, so an
  // explicit time cutoff would risk silently hiding the previous capture for
  // tenants whose `seoRefreshIntervalDays` is set to the cadence cap (90)
  // or who skipped a run. Keeping the dataset trim is the responsibility of
  // SEO retention; alerting must work whatever the cadence is.
  const rows = await db
    .select()
    .from(seoMetrics)
    .where(
      and(
        eq(seoMetrics.tenantDomain, tenantDomain),
        marketCondition,
      ),
    )
    .orderBy(desc(seoMetrics.capturedAt));

  if (rows.length === 0) return { topGainers: [], topLosers: [] };

  // Fetch keyword text in one shot for display.
  const keywordIds = Array.from(new Set(rows.map((r) => r.keywordId)));
  const keywordRows = keywordIds.length === 0
    ? []
    : await db.select().from(trackedKeywords).where(
        eq(trackedKeywords.tenantDomain, tenantDomain),
      );
  const keywordById = new Map(keywordRows.map((k) => [k.id, k.keyword]));

  type Pair = { current: SeoMetric; previous: SeoMetric | null };
  const byPair = new Map<string, Pair>();
  for (const row of rows) {
    if (!row.entityId) continue;
    const key = `${row.keywordId}::${row.entityId}`;
    const existing = byPair.get(key);
    if (!existing) {
      byPair.set(key, { current: row, previous: null });
    } else if (existing.previous === null && row.id !== existing.current.id) {
      existing.previous = row;
    }
  }

  const movers: SeoMover[] = [];
  for (const { current, previous } of Array.from(byPair.values())) {
    // Only consider pairs where the current row is actually from this sweep —
    // otherwise we'd alert on stale data for an entity that wasn't refreshed.
    if (new Date(current.capturedAt).getTime() < sweepStart.getTime()) continue;
    if (!previous) continue;
    if (!isSignificantMovement(previous.rank, current.rank)) continue;

    const entityType: "baseline" | "competitor" =
      current.entityType === "baseline" ? "baseline" : "competitor";
    movers.push({
      keyword: keywordById.get(current.keywordId) ?? "(unknown keyword)",
      entityName: current.entityName,
      entityType,
      previousRank: previous.rank,
      currentRank: current.rank,
      delta: moverDelta(previous.rank, current.rank),
    });
  }

  const sorted = movers.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const topGainers = sorted.filter((m) => m.delta > 0).slice(0, SEO_MOVEMENT_TOP_N);
  const topLosers = sorted.filter((m) => m.delta < 0).slice(0, SEO_MOVEMENT_TOP_N);
  return { topGainers, topLosers };
}

async function runSeoRefreshJob(): Promise<void> {
  if (jobStatus.seoRefresh.isRunning) {
    console.log("[SEO Refresh] Job already running, skipping sweep");
    return;
  }

  jobStatus.seoRefresh.isRunning = true;
  console.log("[SEO Refresh] Starting weekly SEO refresh sweep...");

  let tenantsProcessed = 0;
  let marketsProcessed = 0;
  let keywordsProcessed = 0;
  let rowsRecorded = 0;
  let errorCount = 0;

  try {
    const tenants = await storage.getAllTenants();
    for (const tenant of tenants) {
      if (tenant.status !== "active") continue;

      const featureCheck = await checkFeatureAccessAsync(tenant.plan, "seoTracking");
      if (!featureCheck.allowed) continue;

      const allKeywords = await storage.getTrackedKeywordsByTenant(tenant.domain);
      if (allKeywords.length === 0) continue;

      const tenantIntervalMs = getTenantSeoIntervalMs(tenant);
      const tenantRuns = await storage.getScheduledJobRunsByTenant(tenant.domain, 50);
      const lastTenantRun = tenantRuns.find((r) => r.jobType === "seoRefresh" && r.status === "completed");
      if (lastTenantRun?.completedAt) {
        const elapsed = Date.now() - new Date(lastTenantRun.completedAt).getTime();
        if (elapsed < tenantIntervalMs) continue;
      }

      // Group keywords by their market context so we can run one sweep per market.
      const marketGroups = new Map<string | null, typeof allKeywords>();
      for (const k of allKeywords) {
        const key = k.marketId ?? null;
        if (!marketGroups.has(key)) marketGroups.set(key, []);
        marketGroups.get(key)!.push(k);
      }

      tenantsProcessed += 1;

      const defaultMarket = await storage.getDefaultMarket(tenant.id);
      for (const [marketId] of Array.from(marketGroups.entries())) {
        if (await isMarketArchived(marketId)) {
          console.log(`[SEO Refresh] Skipping archived market ${marketId} for ${tenant.domain}`);
          continue;
        }

        const isDefault = marketId === null;
        const effectiveMarketId = isDefault ? (defaultMarket?.id ?? "") : marketId;
        if (isDefault && !effectiveMarketId) {
          console.log(`[SEO Refresh] Skipping ${tenant.domain} default-market keywords — no default market found`);
          continue;
        }

        const targetName = `${tenant.domain}/${marketId ?? "default"}`;
        await trackJobRun(
          "seoRefresh",
          tenant.domain,
          marketId ?? "default",
          targetName,
          async () => {
            const sweepStart = new Date();
            const result = await refreshSeoForContext({
              tenantDomain: tenant.domain,
              tenantId: tenant.id,
              marketId: effectiveMarketId,
              isDefaultMarket: isDefault,
            });
            keywordsProcessed += result.keywordsProcessed;
            rowsRecorded += result.rowsRecorded;
            marketsProcessed += 1;

            // Detect significant week-over-week movement and fan out alerts
            // through the central notifications dispatcher. Failures here must
            // never abort the sweep — alerting is best-effort.
            try {
              if (result.rowsRecorded > 0) {
                const { topGainers, topLosers } = await computeSeoMoversForMarket({
                  tenantDomain: tenant.domain,
                  marketId: isDefault ? null : marketId,
                  isDefaultMarket: isDefault,
                  sweepStart,
                });
                if (topGainers.length > 0 || topLosers.length > 0) {
                  let marketName: string | undefined;
                  if (!isDefault && effectiveMarketId) {
                    const m = await storage.getMarket(effectiveMarketId);
                    marketName = m?.name;
                  } else if (defaultMarket) {
                    marketName = defaultMarket.name;
                  }
                  await notifications.dispatch(tenant.domain, "seo_movement", {
                    marketId: isDefault ? null : marketId,
                    marketName,
                    topGainers,
                    topLosers,
                  });
                }
              }
            } catch (err) {
              console.error(`[SEO Refresh] Movement alert dispatch failed for ${targetName}:`, err);
            }

            return result;
          },
        ).catch((err) => {
          errorCount += 1;
          console.error(`[SEO Refresh] Failed for ${targetName}:`, err);
        });
      }
    }
    console.log(`[SEO Refresh] Sweep complete — tenants=${tenantsProcessed}, markets=${marketsProcessed}, keywords=${keywordsProcessed}, rows=${rowsRecorded}, errors=${errorCount}`);
  } catch (err) {
    console.error("[SEO Refresh] Sweep failed:", err);
  } finally {
    jobStatus.seoRefresh.isRunning = false;
    jobStatus.seoRefresh.lastRun = new Date();
  }
}

async function checkAndRunSeoRefresh(): Promise<void> {
  try {
    await runSeoRefreshJob();
  } catch (err) {
    console.error("[SEO Refresh] Error checking schedule:", err);
  }
}

export async function triggerSeoRefreshNow(): Promise<void> {
  runSeoRefreshJob();
}

// ───────────────────────────────────────────────────────────────────────────
// HubSpot daily sync (Task #100)
// ───────────────────────────────────────────────────────────────────────────

let hubspotSyncInterval: NodeJS.Timeout | null = null;
let outreachCadenceInterval: NodeJS.Timeout | null = null;
let collabCleanupInterval: NodeJS.Timeout | null = null;
let perfScanSchedulerInterval: NodeJS.Timeout | null = null;

/**
 * Sales outreach cadence sweep — advances due cadence steps + reply-floor for
 * every active tenant, then reads each seller's mailbox to auto-detect sends and
 * replies. Best-effort; tenants without outreach or mailbox consent are no-ops.
 */
async function runOutreachCadenceJob(): Promise<void> {
  if (jobStatus.outreachCadence.isRunning) {
    console.log("[Outreach Cadence] Already running, skipping...");
    return;
  }
  jobStatus.outreachCadence.isRunning = true;
  try {
    const { runCadenceForTenant } = await import("./cadence-service");
    const tenants = await storage.getAllTenants();
    let advanced = 0, replies = 0;
    for (const tenant of tenants) {
      if (tenant.status !== "active") continue;
      const planAllows = await checkFeatureAccessAsync(tenant.plan, "outreachCadence");
      if (!planAllows.allowed) continue;
      try {
        const r = await runCadenceForTenant(tenant.domain);
        advanced += r.prospectsAdvanced;
        replies += r.repliesDetected;
      } catch (err) {
        console.error(`[Outreach Cadence] ${tenant.domain} failed:`, err);
      }
    }
    console.log(`[Outreach Cadence] Sweep complete — stepsAdvanced=${advanced}, repliesDetected=${replies}`);
  } catch (err) {
    console.error("[Outreach Cadence] Sweep failed:", err);
  } finally {
    jobStatus.outreachCadence.isRunning = false;
    jobStatus.outreachCadence.lastRun = new Date();
  }
}

export async function triggerOutreachCadenceNow(): Promise<void> {
  runOutreachCadenceJob();
}

async function runHubspotSyncJob(): Promise<void> {
  if (jobStatus.hubspotSync.isRunning) {
    console.log("[HubSpot Sync] Already running, skipping...");
    return;
  }
  jobStatus.hubspotSync.isRunning = true;
  console.log("[HubSpot Sync] Starting daily HubSpot sync sweep...");
  try {
    const { syncTenant, isHubspotOauthConfigured } = await import("./hubspot-integration");
    if (!isHubspotOauthConfigured()) {
      console.log("[HubSpot Sync] OAuth not configured — skipping");
      return;
    }
    const connections = await storage.listAllHubspotConnections();
    let okCount = 0;
    let failCount = 0;
    for (const conn of connections) {
      const tenant = await storage.getTenantByDomain(conn.tenantDomain).catch(() => null);
      if (!tenant) continue;
      const planAllowsSync = await checkFeatureAccessAsync(tenant.plan, "hubspotIntegration");
      if (!planAllowsSync.allowed) {
        console.log(`[HubSpot Sync] Skipping ${conn.tenantDomain} — plan ${tenant.plan} no longer permits HubSpot integration`);
        continue;
      }
      await trackJobRun(
        "hubspotSync",
        conn.tenantDomain,
        conn.hubspotPortalId ?? conn.id,
        `${conn.tenantDomain}/hubspot`,
        async () => {
          const stats = await syncTenant(conn.tenantDomain);
          okCount += 1;
          return stats;
        },
        {
          onError: async () => {
            failCount += 1;
            try {
              await storage.markHubspotSyncResult(conn.tenantDomain, { stats: null, error: "Daily sync failed" });
            } catch { /* ignore */ }
          },
        },
      );
    }
    console.log(`[HubSpot Sync] Sweep complete — connections=${connections.length}, ok=${okCount}, failed=${failCount}`);
  } catch (err) {
    console.error("[HubSpot Sync] Sweep failed:", err);
  } finally {
    jobStatus.hubspotSync.isRunning = false;
    jobStatus.hubspotSync.lastRun = new Date();
  }
}

export async function triggerHubspotSyncNow(): Promise<void> {
  runHubspotSyncJob();
}

/**
 * Task #123 — Collaboration data hygiene.
 *
 * Hard-deletes comments that have been soft-deleted for 30+ days, then
 * removes orphaned threads (no remaining comments) that aren't tied to an
 * annotation. Annotation-owned threads stay intact since their lifecycle is
 * driven by the annotation row — deleting an annotation also removes its
 * thread (and the thread's comments cascade) via the explicit DELETE in
 * the annotation route.
 */
export async function runCollaborationCleanupJob(): Promise<{
  commentsDeleted: number;
  threadsDeleted: number;
}> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let commentsDeleted = 0;
  let threadsDeleted = 0;
  try {
    const removed = await db
      .delete(collaborationComments)
      .where(
        and(
          lt(collaborationComments.deletedAt, cutoff),
          sql`${collaborationComments.deletedAt} IS NOT NULL`,
        ),
      )
      .returning({ id: collaborationComments.id });
    commentsDeleted = removed.length;

    // Find threads with no remaining comments and not referenced by an
    // annotation. Skip annotation-targeted threads regardless.
    const orphaned = await db.execute<{ id: string }>(sql`
      SELECT t.id FROM ${collaborationThreads} t
      WHERE t.target_kind <> 'annotation'
        AND NOT EXISTS (
          SELECT 1 FROM ${collaborationComments} c WHERE c.thread_id = t.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${annotations} a WHERE a.thread_id = t.id
        )
    `);
    const orphanIds = (orphaned.rows as Array<{ id: string }>).map((r) => r.id);
    if (orphanIds.length > 0) {
      const finalRemoved = await db
        .delete(collaborationThreads)
        .where(sql`${collaborationThreads.id} = ANY(${orphanIds})`)
        .returning({ id: collaborationThreads.id });
      threadsDeleted = finalRemoved.length;
    }

    if (commentsDeleted > 0 || threadsDeleted > 0) {
      console.log(
        `[Collab Cleanup] Hard-deleted ${commentsDeleted} comment(s) and ${threadsDeleted} orphaned thread(s)`,
      );
    }
  } catch (err) {
    console.error("[Collab Cleanup] Sweep failed:", (err as Error).message);
  }
  return { commentsDeleted, threadsDeleted };
}

// WS5: keep the social-post backlog tidy. Archive draft posts that were
// generated at scale but never scheduled within ARCHIVE_AFTER_DAYS, then
// permanently purge archived/rejected/deleted posts older than PURGE_AFTER_DAYS.
// Archived posts are already excluded from planning/calendar/export.
const STALE_DRAFT_ARCHIVE_AFTER_DAYS = 30;
const STALE_DRAFT_PURGE_AFTER_DAYS = 90;

export async function runStaleDraftCleanupJob(): Promise<{ archived: number; purged: number }> {
  const now = Date.now();
  const archiveCutoff = new Date(now - STALE_DRAFT_ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000);
  const purgeCutoff = new Date(now - STALE_DRAFT_PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000);
  let archived = 0;
  let purged = 0;
  try {
    const archivedRows = await db
      .update(generatedPosts)
      .set({ status: "archived", updatedAt: new Date() })
      .where(and(
        eq(generatedPosts.status, "draft"),
        isNull(generatedPosts.scheduledDate),
        lt(generatedPosts.createdAt, archiveCutoff),
      ))
      .returning({ id: generatedPosts.id });
    archived = archivedRows.length;

    const purgedRows = await db
      .delete(generatedPosts)
      .where(and(
        inArray(generatedPosts.status, ["archived", "rejected", "deleted"]),
        lt(generatedPosts.updatedAt, purgeCutoff),
      ))
      .returning({ id: generatedPosts.id });
    purged = purgedRows.length;

    if (archived > 0 || purged > 0) {
      console.log(`[Draft Cleanup] Archived ${archived} stale draft(s), purged ${purged} old post(s)`);
    }
  } catch (err) {
    console.error("[Draft Cleanup] Sweep failed:", (err as Error).message);
  }
  return { archived, purged };
}

// ---------------------------------------------------------------------------
// Performance scan scheduler — hourly sweep that triggers automated headless
// scans for assessments with scan_schedule = 'daily' or 'weekly'.
// Uses the overdue-check pattern: runs hourly, proceeds only when
// elapsed >= interval. Stamp-before pattern for lastAutoScanAt.
// ---------------------------------------------------------------------------

export async function runPerfScanSchedulerJob(): Promise<void> {
  if (jobStatus.perfScanScheduler?.isRunning) {
    console.log("[PerfScan Scheduler] Sweep already running, skipping");
    return;
  }
  if (!jobStatus.perfScanScheduler) {
    jobStatus.perfScanScheduler = { lastRun: null, isRunning: false, nextRun: null, abortController: null };
  }
  jobStatus.perfScanScheduler.isRunning = true;
  console.log("[PerfScan Scheduler] Starting sweep...");

  let total = 0;
  let queued = 0;
  let skippedFresh = 0;
  let skippedNoUrl = 0;
  let skippedInFlight = 0;
  let skippedPlan = 0;

  try {
    // Iterate active tenants with plan gate — same pattern as other sweeps.
    const tenants = await storage.getAllTenants();

    for (const tenant of tenants) {
      if (tenant.status !== "active") continue;

      // Plan gate: Observatory feature required.
      const planGate = await checkFeatureAccessAsync(tenant.plan, "observatory");
      if (!planGate.allowed) {
        skippedPlan++;
        continue;
      }

      // Find all performance assessments with a non-disabled scan schedule for this tenant.
      const assessments = await db
        .select({
          id: obsAssessments.id,
          applicationId: obsAssessments.applicationId,
          versionId: obsAssessments.versionId,
          title: obsAssessments.title,
          scanSchedule: obsAssessments.scanSchedule,
          lastAutoScanAt: obsAssessments.lastAutoScanAt,
        })
        .from(obsAssessments)
        .where(
          and(
            eq(obsAssessments.tenantDomain, tenant.domain),
            eq(obsAssessments.type, "performance"),
            ne(obsAssessments.scanSchedule, "disabled"),
          ),
        );

      const now = Date.now();

      for (const assessment of assessments) {
        total++;

        const schedule = assessment.scanSchedule as "daily" | "weekly";
        if (!isPerfScanDue({
          scanSchedule: schedule,
          lastAutoScanAt: assessment.lastAutoScanAt,
          nowMs: now,
        })) {
          skippedFresh++;
          continue;
        }

        // Skip if a scan (manual or automated) is already in-flight.
        const { getJobStatusByLabel } = await import("./job-queue");
        const existing = getJobStatusByLabel(`perf-scan:${assessment.id}`, tenant.domain);
        if (existing.status === "active" || existing.status === "pending") {
          skippedInFlight++;
          continue;
        }

        // Resolve the application URL and extra pages.
        const [appRow] = await db
          .select()
          .from(obsApplications)
          .where(
            and(
              eq(obsApplications.id, assessment.applicationId),
              eq(obsApplications.tenantDomain, tenant.domain),
            ),
          );
        const url = (appRow as any)?.appUrl as string | null;
        if (!url?.trim()) {
          skippedNoUrl++;
          continue;
        }

        // SSRF guard on primary URL — skip dangerous targets rather than crashing the sweep.
        const { assertScanUrlSafe } = await import("./ssrf-guard");
        try {
          await assertScanUrlSafe(url.trim());
        } catch {
          skippedNoUrl++;
          continue;
        }

        // Resolve and SSRF-validate extra URLs (silently drop any that fail).
        const rawExtraUrls: string[] = ((appRow as any)?.perfExtraUrls as string[] | null) ?? [];
        const extraUrls: string[] = [];
        for (const u of rawExtraUrls) {
          try {
            await assertScanUrlSafe(u.trim());
            extraUrls.push(u.trim());
          } catch {
            console.warn(`[PerfScan Scheduler] Skipping extra URL ${u} — SSRF check failed`);
          }
        }

        // ── Stamp lastAutoScanAt before enqueuing (stamp-before pattern). ──
        // This prevents the sweep from re-queuing the same assessment on the
        // next hourly tick if the scan is still running or if it fails.
        await db
          .update(obsAssessments)
          .set({ lastAutoScanAt: new Date(), updatedAt: new Date() })
          .where(eq(obsAssessments.id, assessment.id));

        // Resolve SLA config (saved on the application, or platform defaults).
        const { DEFAULT_PERF_SLA } = await import("./performance-scanner");
        const savedSla = (appRow as any)?.perfSlaConfig ?? null;
        const slaConfig = savedSla && typeof savedSla === "object"
          ? { ...DEFAULT_PERF_SLA, ...savedSla }
          : DEFAULT_PERF_SLA;

        // Create a "running" scan row immediately.
        const [scanRow] = await db
          .insert(obsPerformanceScans)
          .values({
            tenantDomain: tenant.domain,
            assessmentId: assessment.id,
            applicationId: assessment.applicationId,
            scanUrl: url.trim(),
            status: "running",
            slaConfig,
            triggeredBy: null, // automated
            scanSource: "scheduled",
          })
          .returning();

        // Enqueue the scan with retries for transient failures.
        // runScheduledPerfScan awaits the enqueue Promise so telemetry is
        // only marked completed/failed after the scan actually finishes.
        const { enqueue } = await import("./job-queue");
        const { executePerfScan } = await import("../routes/observatory-performance");

        const urlCount = 1 + extraUrls.length;
        await runScheduledPerfScan(
          tenant.domain,
          assessment.id,
          assessment.title,
          () => executePerfScan({
            tenantDomain: tenant.domain,
            assessment: {
              id: assessment.id,
              applicationId: assessment.applicationId,
              versionId: assessment.versionId,
              title: assessment.title,
            },
            scanRow,
            url: url.trim(),
            extraUrls,
            slaConfig,
            scanSource: "scheduled",
            triggeredByUserId: null,
          }),
          {
            enqueue: (label, work, opts) =>
              enqueue("other", label, work, {
                ...opts,
                ctx: { tenantDomain: tenant.domain, targetId: assessment.id, targetName: assessment.title },
              }),
          },
          urlCount,
          // Transition the batch row to "failed" if the queue rejects before
          // work ever ran (infrastructure failure) or after all retries are
          // exhausted. The WHERE status='running' guard makes this idempotent:
          // if executePerfScan already marked the row failed, this is a no-op.
          async () => {
            // Mark the batch as failed if it's still running (idempotent: the
            // WHERE status='running' guard is a no-op if executePerfScan already
            // updated the row). Only update status and scanError — completedAt
            // is not a column on obs_performance_scans.
            await db
              .update(obsPerformanceScans)
              .set({
                status: "failed",
                scanError: "Scan queue rejected: all retries exhausted or queue infrastructure failure",
              })
              .where(
                and(
                  eq(obsPerformanceScans.id, scanRow.id),
                  eq(obsPerformanceScans.status, "running"),
                ),
              );
          },
        );

        queued++;
        console.log(`[PerfScan Scheduler] Queued ${schedule} scan for "${assessment.title}" (${tenant.domain})`);
      }
    }
  } catch (err) {
    console.error("[PerfScan Scheduler] Sweep failed:", err);
  } finally {
    jobStatus.perfScanScheduler.isRunning = false;
    jobStatus.perfScanScheduler.lastRun = new Date();
    console.log(
      `[PerfScan Scheduler] Sweep complete — total=${total} queued=${queued} ` +
      `fresh=${skippedFresh} in_flight=${skippedInFlight} no_url=${skippedNoUrl} plan_blocked=${skippedPlan}`,
    );
  }
}

export function startScheduledJobs(): void {
  console.log("[Scheduled Jobs] Initializing scheduled jobs...");

  // Keep the Neon compute alive. Neon auto-suspends idle connections after
  // ~5 minutes; a lightweight ping every 4 minutes prevents that and stops
  // the "Connection terminated due to administrator command" cascade that
  // kills every background worker simultaneously.
  setInterval(async () => {
    try {
      await db.execute(sql`SELECT 1`);
    } catch (err: any) {
      console.warn("[DB Keepalive] Ping failed (will retry next tick):", err?.message);
    }
  }, 4 * 60 * 1000);

  if (pricingMonitorInterval) clearInterval(pricingMonitorInterval);
  if (trialReminderInterval) clearInterval(trialReminderInterval);
  if (weeklyDigestInterval) clearInterval(weeklyDigestInterval);
  if (scheduledBriefingInterval) clearInterval(scheduledBriefingInterval);
  if (plannerSyncInterval) clearInterval(plannerSyncInterval);
  if (seoRefreshInterval) clearInterval(seoRefreshInterval);
  if (hubspotSyncInterval) clearInterval(hubspotSyncInterval);
  if (outreachCadenceInterval) clearInterval(outreachCadenceInterval);

  // Sales outreach cadence sweep — hourly (advances due steps + mailbox detection).
  outreachCadenceInterval = setInterval(() => {
    runOutreachCadenceJob();
  }, 60 * 60 * 1000);

  jobStatus.scheduledBriefing = { lastRun: null, isRunning: false, nextRun: null, abortController: null };
  jobStatus.plannerSync = { lastRun: null, isRunning: false, nextRun: null, abortController: null };
  jobStatus.seoRefresh = { lastRun: null, isRunning: false, nextRun: null, abortController: null };
  jobStatus.hubspotSync = { lastRun: null, isRunning: false, nextRun: null, abortController: null };

  // HubSpot daily sync — runs every 24 hours after a 2 minute warm-up.
  hubspotSyncInterval = setInterval(() => {
    runHubspotSyncJob();
  }, 24 * 60 * 60 * 1000);

  // Pricing monitor: check every 6 hours, but each competitor is gated to a
  // minimum 7-day interval inside the job (PRICING_MIN_INTERVAL_MS).
  pricingMonitorInterval = setInterval(() => {
    runPricingMonitorJob();
  }, 6 * 60 * 60 * 1000);

  trialReminderInterval = setInterval(() => {
    runTrialReminderJob();
  }, 6 * 60 * 60 * 1000);

  weeklyDigestInterval = setInterval(() => {
    checkAndRunWeeklyDigest();
  }, 60 * 60 * 1000);

  scheduledBriefingInterval = setInterval(() => {
    checkAndRunScheduledBriefing();
  }, 60 * 60 * 1000);

  // Planner two-way sync — runs every 15 minutes for all connected plans
  plannerSyncInterval = setInterval(() => {
    runPlannerSyncJob();
  }, 15 * 60 * 1000);

  // SEO refresh — checks every hour but only runs when 7+ days since last run
  seoRefreshInterval = setInterval(() => {
    checkAndRunSeoRefresh();
  }, 60 * 60 * 1000);

  // Task #86: Persistent rate limit bucket cleanup — drops expired rows so
  // the table doesn't accumulate stale per-IP / per-email keys. Runs every
  // 6 hours; cheap WHERE reset_at < now() query backed by an index.
  setInterval(() => {
    import("./rate-limiter")
      .then(({ cleanupExpiredBuckets }) => cleanupExpiredBuckets())
      .catch((err) => console.error("[rate-limiter] cleanup error:", err?.message || err));
  }, 6 * 60 * 60 * 1000);

  // WS5: stale social-draft cleanup (archive unscheduled, purge old) — daily.
  setInterval(() => {
    runStaleDraftCleanupJob().catch((err) =>
      console.error("[Draft Cleanup] error:", err?.message || err),
    );
  }, 24 * 60 * 60 * 1000);

  // Task #102: Sentiment & tone backfill — drains rows where analyzedAt IS
  // NULL in small batches so the analyzer does not spike LLM spend. Runs
  // every 15 minutes; each tick processes up to 50 rows captured in the
  // last 90 days.
  setInterval(() => {
    import("./sentiment-backfill")
      .then(({ backfillSentiment }) => backfillSentiment({ limit: 50, sinceDays: 90 }))
      .catch((err) => console.error("[Sentiment Backfill] Tick error:", err?.message || err));
  }, 15 * 60 * 1000);
  // Task #101: Outcome metrics — daily GA4/UTM analytics pull (runs hourly,
  // each call is idempotent for the date being pulled). Weekly Orbit Score
  // computation runs every 6 hours; benchmark aggregation runs nightly.
  setInterval(() => {
    import("./ga-client").then(({ runDailyAnalyticsPull }) =>
      runDailyAnalyticsPull().catch((err) => console.error("[Outcome Metrics] daily pull error:", err?.message || err)),
    );
  }, 60 * 60 * 1000);
  setInterval(() => {
    import("./orbit-score").then(({ runWeeklyOrbitScoreJob }) =>
      runWeeklyOrbitScoreJob().catch((err) => console.error("[Orbit Score] weekly job error:", err?.message || err)),
    );
  }, 6 * 60 * 60 * 1000);
  setInterval(() => {
    import("./orbit-score").then(({ runBenchmarkAggregationJob }) =>
      runBenchmarkAggregationJob().catch((err) => console.error("[Orbit Score] benchmark job error:", err?.message || err)),
    );
  }, 24 * 60 * 60 * 1000);
  // Initial sweep ~ 2 minutes after boot
  setTimeout(() => {
    import("./ga-client").then(({ runDailyAnalyticsPull }) =>
      runDailyAnalyticsPull().catch((err) => console.error("[Outcome Metrics] initial daily pull error:", err?.message || err)),
    );
    import("./orbit-score").then(({ runWeeklyOrbitScoreJob }) =>
      runWeeklyOrbitScoreJob().catch((err) => console.error("[Orbit Score] initial weekly job error:", err?.message || err)),
    );
  }, 2 * 60 * 1000);

  // Task #104 — Planner Graph subscription renewal — runs hourly
  if (plannerSubscriptionRenewalInterval) clearInterval(plannerSubscriptionRenewalInterval);
  plannerSubscriptionRenewalInterval = setInterval(() => {
    runPlannerSubscriptionRenewalJob();
  }, 60 * 60 * 1000);
  setTimeout(() => {
    runPlannerSubscriptionRenewalJob();
  }, 45 * 1000);

  // Task #97: Marketing publish worker — picks up approved+scheduled posts on
  // auto-publish accounts every 2 minutes. First tick delayed to 3.5 minutes
  // after startup so it doesn't collide with the pricing / HubSpot initial
  // sweeps that fire at T+2min and saturate the connection pool.
  setTimeout(() => {
    const runPublishTick = () => {
      tickMarketingPublishWorker().catch(err => {
        console.error("[Marketing Publish Worker] Tick error:", err?.message || err);
      });
    };
    runPublishTick();
    setInterval(runPublishTick, 2 * 60 * 1000);
  }, 3.5 * 60 * 1000);

  // Missed-post sweep — marks approved posts whose scheduledDate is more than
  // 5 days in the past as "missed" so operators can review them. Runs every
  // 5 minutes; the update is a no-op when nothing qualifies.
  setInterval(() => {
    sweepMissedPosts().catch(err => {
      console.error("[Missed Post Sweep] Error:", err?.message || err);
    });
  }, 5 * 60 * 1000);
  // Run once on startup to catch anything that aged out while the server was down.
  setTimeout(() => {
    sweepMissedPosts().catch(err => {
      console.error("[Missed Post Sweep] Startup error:", err?.message || err);
    });
  }, 10_000);

  // Task #97: Email send worker — processes scheduled email_sends rows
  // whose scheduledAt has elapsed. First tick at T+4.5min, staggered from
  // the publish worker (T+3.5min) to avoid simultaneous pool contention.
  setTimeout(() => {
    const runEmailTick = () => {
      const baseUrl = process.env.PUBLIC_APP_URL || `http://localhost:${process.env.PORT || 5000}`;
      tickEmailSendWorker({ baseUrl }).catch(err => {
        console.error("[Email Send Worker] Tick error:", err?.message || err);
      });
    };
    runEmailTick();
    setInterval(runEmailTick, 2 * 60 * 1000);
  }, 4.5 * 60 * 1000);

  // HubSpot marketing-email sync backfill (Phase 4) — retries pending/errored
  // contact resolution for recent sends, and re-pushes email_sent timeline
  // events. Resolution runs for any connected, feature-enabled tenant;
  // timeline pushes additionally require templates to be configured. The tick
  // returns early (cheap) when no recipients are pending/errored.
  setInterval(() => {
    tickHubspotEmailSyncBackfill().catch(err => {
      console.error("[HubSpot Email Backfill] Tick error:", err?.message || err);
    });
  }, 10 * 60 * 1000);

  // CRITICAL: Clean up any stuck jobs from previous runs
  cleanupStuckJobs().catch(err => {
    console.error("[Scheduled Jobs] Error cleaning up stuck jobs:", err);
  });

  // Periodic stuck job cleanup every 15 minutes (catches jobs that get stuck while server is running)
  setInterval(() => {
    cleanupStuckJobs().catch(err => {
      console.error("[Scheduled Jobs] Periodic stuck job cleanup error:", err);
    });
  }, 15 * 60 * 1000);

  // Task #123: Collaboration data hygiene — daily sweep that hard-deletes
  // soft-deleted comments older than 30 days plus orphaned threads.
  // Performance scan scheduler — hourly sweep, runs when assessment is overdue.
  if (perfScanSchedulerInterval) clearInterval(perfScanSchedulerInterval);
  perfScanSchedulerInterval = setInterval(() => {
    runPerfScanSchedulerJob().catch((err) =>
      console.error("[PerfScan Scheduler] Interval error:", err?.message || err),
    );
  }, 60 * 60 * 1000);
  // Initial sweep at T+90s — staggered after other startup sweeps.
  setTimeout(() => {
    runPerfScanSchedulerJob().catch((err) =>
      console.error("[PerfScan Scheduler] Initial sweep error:", err?.message || err),
    );
  }, 90 * 1000);

  if (collabCleanupInterval) clearInterval(collabCleanupInterval);
  collabCleanupInterval = setInterval(() => {
    runCollaborationCleanupJob().catch((err) =>
      console.error("[Collab Cleanup] Tick error:", err?.message || err),
    );
  }, 24 * 60 * 60 * 1000);
  setTimeout(() => {
    runCollaborationCleanupJob().catch((err) =>
      console.error("[Collab Cleanup] Initial sweep error:", err?.message || err),
    );
  }, 3 * 60 * 1000);
  
  console.log("[Scheduled Jobs] Running initial job sweep for any overdue items...");
  
  setTimeout(() => {
    console.log("[Scheduled Jobs] Starting pricing monitor job sweep...");
    runPricingMonitorJob();
  }, 5 * 1000);

  setTimeout(() => {
    console.log("[Scheduled Jobs] Starting trial reminder job sweep...");
    runTrialReminderJob();
  }, 15 * 1000);

  setTimeout(() => {
    console.log("[Scheduled Jobs] Checking if weekly digest is overdue...");
    checkAndRunWeeklyDigest();
  }, 20 * 1000);

  setTimeout(() => {
    console.log("[Scheduled Jobs] Checking if scheduled briefing is overdue...");
    checkAndRunScheduledBriefing();
  }, 25 * 1000);

  setTimeout(() => {
    console.log("[Scheduled Jobs] Checking if SEO refresh is overdue...");
    checkAndRunSeoRefresh();
  }, 35 * 1000);

  // hourly sweep — downgrade tenants whose payment grace window has expired
  setInterval(async () => {
    try {
      const { sweepExpiredGraceWindows } = await import("./billing-service");
      const n = await sweepExpiredGraceWindows();
      if (n > 0) console.log(`[Scheduled Jobs] Billing grace sweep: downgraded ${n} tenant(s)`);
    } catch (err) {
      console.error("[Scheduled Jobs] Billing grace sweep failed:", err);
    }
  }, 60 * 60 * 1000);

  setTimeout(() => {
    console.log("[Scheduled Jobs] Starting initial HubSpot sync sweep...");
    runHubspotSyncJob();
  }, 120 * 1000);

  console.log("[Scheduled Jobs] Jobs scheduled - pricing monitor (every 6 hours), trial reminders (every 6 hours), weekly digest (checks hourly, runs when 7+ days since last), scheduled briefing (checks hourly), Planner two-way sync (every 15 minutes), SEO refresh (weekly)");
  console.log("[Scheduled Jobs] Initial job sweep will start in 5 seconds to process any overdue items");
}

export function stopScheduledJobs(): void {
  if (perfScanSchedulerInterval) {
    clearInterval(perfScanSchedulerInterval);
    perfScanSchedulerInterval = null;
  }
  if (trialReminderInterval) {
    clearInterval(trialReminderInterval);
    trialReminderInterval = null;
  }
  if (weeklyDigestInterval) {
    clearInterval(weeklyDigestInterval);
    weeklyDigestInterval = null;
  }
  if (scheduledBriefingInterval) {
    clearInterval(scheduledBriefingInterval);
    scheduledBriefingInterval = null;
  }
  if (plannerSyncInterval) {
    clearInterval(plannerSyncInterval);
    plannerSyncInterval = null;
  }
  if (seoRefreshInterval) {
    clearInterval(seoRefreshInterval);
    seoRefreshInterval = null;
  }
  if (hubspotSyncInterval) {
    clearInterval(hubspotSyncInterval);
    hubspotSyncInterval = null;
  }
  if (outreachCadenceInterval) {
    clearInterval(outreachCadenceInterval);
    outreachCadenceInterval = null;
  }
  console.log("[Scheduled Jobs] All scheduled jobs stopped");
}

export async function triggerWeeklyDigestNow(): Promise<void> {
  runWeeklyDigestJob();
}

export async function triggerPlannerSyncNow(): Promise<void> {
  runPlannerSyncJob();
}

export function getJobStatus(): Record<string, Omit<JobStatus, 'abortController'>> {
  const result: Record<string, Omit<JobStatus, 'abortController'>> = {};
  for (const [key, status] of Object.entries(jobStatus)) {
    result[key] = {
      lastRun: status.lastRun,
      isRunning: status.isRunning,
      nextRun: status.nextRun,
    };
  }
  return result;
}

export function resetStuckJob(jobType: string): boolean {
  if (jobStatus[jobType]) {
    // Abort if there's an active controller
    if (jobStatus[jobType].abortController) {
      jobStatus[jobType].abortController!.abort();
      jobStatus[jobType].abortController = null;
    }
    jobStatus[jobType].isRunning = false;
    console.log(`[Scheduled Job] Reset stuck job: ${jobType}`);
    return true;
  }
  return false;
}

export function resetAllStuckJobs(): string[] {
  const resetJobs: string[] = [];
  for (const [key, status] of Object.entries(jobStatus)) {
    if (status.isRunning) {
      // Abort if there's an active controller
      if (status.abortController) {
        status.abortController.abort();
        status.abortController = null;
      }
      status.isRunning = false;
      resetJobs.push(key);
      console.log(`[Scheduled Job] Reset stuck job: ${key}`);
    }
  }
  return resetJobs;
}

export function cancelJob(jobType: string): { cancelled: boolean; wasRunning: boolean } {
  const job = jobStatus[jobType];
  if (!job) {
    return { cancelled: false, wasRunning: false };
  }
  
  const wasRunning = job.isRunning;
  
  if (job.abortController) {
    job.abortController.abort();
    job.abortController = null;
    console.log(`[Scheduled Job] Cancelled running job: ${jobType}`);
  }
  
  job.isRunning = false;
  
  return { cancelled: true, wasRunning };
}
