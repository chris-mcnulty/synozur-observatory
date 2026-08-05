import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { RedisStore } from "connect-redis";
import { createClient as createRedisClient } from "redis";
import fileUpload from "express-fileupload";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { registerSEORoutes, crawlerPrerender } from "./seo";
import { createServer } from "http";
import { startScheduledJobs } from "./services/scheduled-jobs";
import { storage } from "./storage";
import { setPersistenceHooks } from "./services/job-queue";
import { runMigrations } from "./db-migrate";
import { db } from "./db";
import { scheduledJobRuns } from "@shared/schema";
import { eq } from "drizzle-orm";
import pg from "pg";

const app = express();
const httpServer = createServer(app);

// Trust proxy for secure cookies behind reverse proxy (Replit, etc.)
app.set('trust proxy', 1);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

declare module "express-session" {
  interface SessionData {
    userId: string;
    activeTenantId?: string;
    activeMarketId?: string;
    // Optional same-origin path the user should land on after sign-in
    // (used to resume `/oauth/authorize` flows after Entra/local login).
    postLoginRedirect?: string;
    // Google OAuth state nonce + pending account-link payload (Task #105)
    googleOAuthState?: string;
    pendingGoogleLink?: {
      googleId: string;
      email: string;
      name: string;
      userId: string;
    };
  }
}

// Stripe webhook needs raw body for signature verification.
// Skip JSON parsing for those paths; the routes use express.raw().
app.use((req, res, next) => {
  if (req.path === "/api/stripe/webhook" || req.path === "/api/webhooks/stripe") {
    return next();
  }
  return express.json({
    verify: (req2, _res, buf) => {
      (req2 as any).rawBody = buf;
    },
  })(req, res, next);
});

app.use(express.urlencoded({ extended: false }));

// File upload middleware for logo uploads
app.use(fileUpload({
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit (matches validateDocumentUpload)
  abortOnLimit: true,
  useTempFiles: false,
}));

const PgSession = connectPgSimple(session);
const pgPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pgPool.on("error", (err) => {
  console.error("[PostgreSQL Pool] Unexpected client error:", err.message);
});

process.on("uncaughtException", (err) => {
  console.error("[Process] Uncaught exception (keeping alive):", err.message, err.stack);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Process] Unhandled rejection (keeping alive):", reason);
});

// ========== SESSION STORE ==========
// Use Redis when REDIS_URL is set; fall back to PostgreSQL for zero-config deployments.
function buildSessionStore(): session.Store {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const redisClient = createRedisClient({
        url: redisUrl,
        socket: {
          reconnectStrategy: (retries: number) => Math.min(retries * 100, 3000),
        },
      });
      redisClient.on("error", (err: Error) => {
        console.error("[Redis] Session store error:", err.message);
      });
      redisClient.connect().then(() => {
        log("Redis session store connected");
      }).catch((err: Error) => {
        console.error("[Redis] Failed to connect — sessions will fall back to in-memory:", err.message);
      });
      return new RedisStore({ client: redisClient as any, prefix: "orbit:sess:", ttl: 60 * 60 * 24 * 7 });
    } catch (err) {
      console.error("[Redis] Failed to initialise client, using PostgreSQL session store:", err);
    }
  }
  return new PgSession({
    pool: pgPool,
    tableName: "user_sessions",
    createTableIfMissing: true,
    pruneSessionInterval: 60 * 60, // prune expired sessions every hour
  });
}

app.use(
  session({
    store: buildSessionStore(),
    secret: process.env.SESSION_SECRET || "orbit-secret-key-change-in-production",
    resave: false,
    saveUninitialized: false,
    rolling: true, // Extend session TTL on every authenticated request
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
      sameSite: "lax",
    },
  })
);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        // Truncate response body to keep logs readable
        const jsonStr = JSON.stringify(capturedJsonResponse);
        const truncated = jsonStr.length > 200 ? jsonStr.substring(0, 200) + "...[truncated]" : jsonStr;
        logLine += ` :: ${truncated}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // ── Run database migrations ──────────────────────────────────────────────
  // runMigrations reads migrations/*.sql in order, tracks applied versions in
  // a _migrations ledger table, and throws (crashing startup) on any failure.
  // On the first boot of an existing database it backfills the ledger without
  // re-executing SQL. See server/db-migrate.ts for full details.
  await runMigrations(pgPool);

  // ── Post-migration business-logic housekeeping ───────────────────────────
  // These are data fixups, not schema changes, so they run after the runner.
  try {
    // Any tenant with a directly-assigned paid plan but no Stripe subscription
    // should be treated as manually managed so resolveEffectivePlan trusts it.
    await pgPool.query(`UPDATE tenants SET billing_managed_manually = true WHERE plan IN ('pro','enterprise','unlimited') AND billing_managed_manually = false AND (stripe_subscription_id IS NULL OR stripe_subscription_id = '')`);
    // Synozur is the app creator — always pin to unlimited
    await pgPool.query(`UPDATE tenants SET billing_managed_manually = true, plan = 'unlimited' WHERE domain = 'synozur.com' AND (billing_managed_manually = false OR plan != 'unlimited')`);
    // Mark briefings with empty/null core fields as failed so the UI shows
    // the failed-state recovery card instead of a blank/crashing detail page.
    await pgPool.query(`
      UPDATE intelligence_briefings
      SET status = 'failed',
          briefing_data = jsonb_set(
            COALESCE(briefing_data, '{}'::jsonb),
            '{error}',
            '"Briefing was generated with empty content. Please regenerate."'::jsonb,
            true
          )
      WHERE status = 'published'
        AND (
          briefing_data IS NULL
          OR briefing_data->'executiveSummary' IS NULL
          OR jsonb_typeof(briefing_data->'executiveSummary') = 'null'
        )
    `);
    // Seed Galaxy as the first registered OAuth client (idempotent)
    {
      const existing = await pgPool.query(`SELECT id FROM oauth_clients WHERE name = 'Galaxy' LIMIT 1`);
      if (existing.rows.length === 0) {
        const allScopes = [
          "read:battlecards",
          "read:briefings",
          "read:personas",
          "read:roadmap",
          "read:content-library",
          "read:brand-library",
          "read:campaigns",
          "read:reports",
          "read:posts",
        ];
        const galaxyRedirects = (process.env.GALAXY_OAUTH_REDIRECT_URIS || "https://galaxy.example.com/oauth/callback")
          .split(/[,\s]+/)
          .filter(Boolean);
        await pgPool.query(
          `INSERT INTO oauth_clients (name, description, contact_email, redirect_uris, allowed_scopes, status)
           VALUES ($1, $2, $3, $4, $5, 'active')`,
          [
            "Galaxy",
            "Official Galaxy partner portal — discovery and read-only sync of competitive intelligence.",
            "partners@galaxy.example.com",
            galaxyRedirects,
            allScopes,
          ]
        );
        log("Seeded Galaxy as the first OAuth client");
      }
    }
  } catch (err) {
    console.error("[Startup] Post-migration housekeeping error:", err);
  }

  // ── (Legacy inline startup block removed — see server/db-migrate.ts) ──
  // All schema creation previously in this file now lives in migrations/*.sql.
  // Add new tables/columns by editing shared/schema.ts and running:
  //   npm run db:generate   (generates the SQL file under migrations/)
  //   git commit the new file and deploy.

  // Wire job-queue persistence so all queued jobs write lifecycle events to
  // scheduled_job_runs. These writes go through the dedicated crawl pool
  // (db), NOT the primary pool. Job-lifecycle telemetry is non-urgent and
  // high-volume (every crawl/monitor job start + finish), so isolating it from
  // the primary pool keeps connections free for time-sensitive workers like the
  // marketing publish worker.
  setPersistenceHooks({
    async onCreate(job) {
      try {
        const [run] = await db
          .insert(scheduledJobRuns)
          .values({
            jobType: job.type,
            jobLabel: job.label,
            tenantDomain: job.ctx?.tenantDomain || null,
            targetId: job.ctx?.targetId || null,
            targetName: job.ctx?.targetName || job.label,
            status: "running",
            startedAt: job.startedAt,
          })
          .returning();
        return run.id;
      } catch (err) {
        console.error("[JobQueue persistence] createScheduledJobRun failed:", err);
        return "";
      }
    },
    async onComplete(dbRowId, status, errorMessage) {
      if (!dbRowId) return;
      try {
        const [updated] = await db
          .update(scheduledJobRuns)
          .set({
            status,
            completedAt: new Date(),
            errorMessage: errorMessage || null,
          })
          .where(eq(scheduledJobRuns.id, dbRowId))
          .returning();
        // Fan-out failed queued jobs (crawl/monitor/analysis/pdf) through
        // the central notifications dispatcher.
        if (status === "failed" && updated?.tenantDomain) {
          const { notifications } = await import("./services/notifications");
          await notifications.dispatch(updated.tenantDomain, "job_failed", {
            jobType: updated.jobType || "queued_job",
            targetName: updated.targetName || undefined,
            error: errorMessage || "Unknown error",
            attempts: 1,
          });
        }
      } catch (err) {
        console.error("[JobQueue persistence] updateScheduledJobRun failed:", err);
      }
    },
  });

  registerSEORoutes(app);

  app.use(crawlerPrerender);

  await registerRoutes(httpServer, app);
  
  // Seed default service plans if none exist
  await storage.seedDefaultServicePlans();
  
  // Backfill organizations for existing competitors/baselines
  storage.backfillOrganizations().catch(err => console.error("[Startup] Organization backfill error:", err));
  
  // Recover stuck "generating" briefings from previous server restarts
  storage.recoverStuckBriefings().catch(err => console.error("[Startup] Briefing recovery error:", err));
  
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
      
      // Start scheduled background jobs for website crawling and social monitoring
      // Jobs run in both development and production now
      startScheduledJobs();
      log("Scheduled jobs started");
    },
  );
})();
