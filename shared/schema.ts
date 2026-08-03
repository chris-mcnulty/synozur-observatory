import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, jsonb, serial, boolean, check, index, uniqueIndex, real, primaryKey, type AnyPgColumn } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { relations } from "drizzle-orm";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  name: text("name").notNull(),
  // Valid roles: "Standard User" | "Analyst" | "Domain Admin" | "Consultant" | "Global Admin"
  // Standard User: read-only. Analyst: content authoring + intelligence building (no user/billing mgmt).
  // Domain Admin: full tenant admin. Consultant: cross-tenant read (Synozur staff). Global Admin: superadmin.
  role: text("role").notNull().default("Standard User"),
  company: text("company").notNull(),
  companySize: text("company_size"),
  jobTitle: text("job_title"),
  industry: text("industry"),
  country: text("country"),
  avatar: text("avatar").notNull(),
  entraId: text("entra_id"),
  googleId: text("google_id"),
  authProvider: text("auth_provider").default("local"),
  emailVerified: boolean("email_verified").default(false),
  status: text("status").default("active"), // active, pending_verification, suspended
  weeklyDigestEnabled: boolean("weekly_digest_enabled").default(true), // Opt-in for weekly competitor digest emails
  alertsEnabled: boolean("alerts_enabled").default(false), // Opt-in for real-time competitor change alerts (in-app)
  alertThreshold: text("alert_threshold").default("high"), // "high" | "medium" | "all" — minimum significance to trigger alert
  alertEmailEnabled: boolean("alert_email_enabled").default(false), // Opt-in for competitor change alert emails
  mentionEmailEnabled: boolean("mention_email_enabled").default(true), // Email when @mentioned in a comment
  assignmentEmailEnabled: boolean("assignment_email_enabled").default(true), // Email when assigned an action item
  lastDismissedChangelogVersion: varchar("last_dismissed_changelog_version"),
  // Microsoft Graph delegated tokens for user-context Graph operations
  // (Planner sync, mailbox actions). Captured via incremental consent.
  graphAccessToken: text("graph_access_token"),
  graphRefreshToken: text("graph_refresh_token"),
  graphTokenExpiresAt: timestamp("graph_token_expires_at"),
  graphScopes: text("graph_scopes"), // space-separated scopes granted
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const emailVerificationTokens = pgTable("email_verification_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  token: text("token").notNull().unique(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  company: text("company").notNull(),
  entraId: text("entra_id"),
  azureTenantId: text("azure_tenant_id"),
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  token: text("token").notNull().unique(),
  userId: varchar("user_id").notNull().references(() => users.id),
  email: text("email").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const tenantInvites = pgTable("tenant_invites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  token: text("token").notNull().unique(),
  email: text("email").notNull(),
  tenantDomain: text("tenant_domain").notNull(),
  invitedRole: text("invited_role").notNull().default("Standard User"),
  invitedBy: varchar("invited_by").notNull().references(() => users.id),
  status: text("status").notNull().default("pending"), // pending, accepted, expired, revoked
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const tenants = pgTable("tenants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  domain: text("domain").notNull().unique(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("trial"), // trial, free, pro, enterprise
  status: text("status").notNull().default("active"),
  trialStartDate: timestamp("trial_start_date"), // When trial period began
  trialEndsAt: timestamp("trial_ends_at"), // When trial period expires (60 days from start)
  lastTrialReminderSent: text("last_trial_reminder_sent"), // Track which reminder was last sent: day7, day30, day46, day53, day57, day59, day60
  userCount: integer("user_count").notNull().default(0),
  competitorLimit: integer("competitor_limit").notNull().default(3),
  analysisLimit: integer("analysis_limit").notNull().default(5),
  adminUserLimit: integer("admin_user_limit").notNull().default(1),
  readWriteUserLimit: integer("read_write_user_limit").notNull().default(2),
  readOnlyUserLimit: integer("read_only_user_limit").notNull().default(5),
  monitoringFrequency: text("monitoring_frequency").default("weekly"), // weekly, daily, disabled
  socialMonitoringEnabled: boolean("social_monitoring_enabled").default(false), // Premium feature
  logoUrl: text("logo_url"),
  faviconUrl: text("favicon_url"),
  primaryColor: text("primary_color").default("#810FFB"),
  secondaryColor: text("secondary_color").default("#E60CB3"),
  // Extended brand palette for graphics generation
  accentColor: text("accent_color"), // tertiary accent (e.g. chart highlights, CTA)
  neutralColor: text("neutral_color"), // background/neutral tint (e.g. off-white, light grey)
  // Tenant-level Entra ID configuration (Domain Admin editable)
  entraClientId: text("entra_client_id"), // Azure AD App Registration Client ID
  entraTenantId: text("entra_tenant_id"), // Azure AD Tenant ID
  entraClientSecret: text("entra_client_secret"), // Azure AD App Registration Client Secret (encrypted)
  entraEnabled: boolean("entra_enabled").default(false), // Whether tenant-level Entra SSO is enabled
  // Allowed auth providers (subset of: "entra", "google", "password").
  // Empty array means "no restriction" — frontend treats null/empty as default of all three.
  allowedAuthProviders: text("allowed_auth_providers").array().default(sql`ARRAY['entra','google','password']::text[]`),
  // Multi-market settings (Enterprise tier feature)
  multiMarketEnabled: boolean("multi_market_enabled").default(false), // Whether tenant can create multiple markets
  marketLimit: integer("market_limit"), // Maximum number of markets allowed (NULL = unlimited)
  // SharePoint Embedded (SPE) file storage — tenant-level container configuration
  speContainerIdDev: text("spe_container_id_dev"), // SPE container ID for development environment
  speContainerIdProd: text("spe_container_id_prod"), // SPE container ID for production environment
  speStorageEnabled: boolean("spe_storage_enabled").default(false), // Whether SPE storage is active for this tenant
  speMigrationStatus: text("spe_migration_status"), // pending | in_progress | completed | failed
  speMigrationStartedAt: timestamp("spe_migration_started_at"), // When SPE migration began
  // SEO tracking refresh cadence (in days) — null falls back to platform default of 7
  seoRefreshIntervalDays: integer("seo_refresh_interval_days").default(7),
  // Stripe billing
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  subscriptionStatus: text("subscription_status"), // active | trialing | past_due | canceled | incomplete | unpaid | null
  currentPeriodEnd: timestamp("current_period_end"),
  seatCount: integer("seat_count"), // Stripe subscription quantity (paid seats)
  paymentGraceUntil: timestamp("payment_grace_until"), // 7-day grace after payment_failed
  billingManagedManually: boolean("billing_managed_manually").notNull().default(false), // Global Admin override
  // Vega Launchpad direct-push integration (Task #117)
  vegaLaunchpadUrl: text("vega_launchpad_url"), // Base URL of the Vega Launchpad API the tenant pushes to
  vegaLaunchpadApiKey: text("vega_launchpad_api_key"), // API key (or OAuth token) used for push auth
  vegaLaunchpadWorkspaceId: text("vega_launchpad_workspace_id"), // Optional Vega-side workspace/tenant identifier
  vegaLaunchpadConnectedAt: timestamp("vega_launchpad_connected_at"),
  // Public/anonymous endpoint rate limit override (requests per minute).
  // NULL falls back to the platform default (10 rpm).
  publicRateLimitPerMinute: integer("public_rate_limit_per_minute"),
  // Naturalistic posting delay: when true (default) the publish worker adds a
  // random 0–600 s offset to each post so they don't land at exactly :00.
  // Tenants can disable this globally; individual posts can override with
  // exactSchedule = true regardless of this setting.
  socialPostingJitterEnabled: boolean("social_posting_jitter_enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Persistent rate limit buckets — survives server restarts and works across
// multiple processes. Keyed by (tenant_domain, scope, key). Use the literal
// "_global" tenant_domain for non-tenant-scoped limits (e.g. signup by IP).
export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  tenantDomain: text("tenant_domain").notNull(),
  scope: text("scope").notNull(),
  key: text("key").notNull(),
  count: integer("count").notNull().default(0),
  resetAt: timestamp("reset_at").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.tenantDomain, t.scope, t.key] }),
}));

export type RateLimitBucket = typeof rateLimitBuckets.$inferSelect;

// Billing event audit log — provides idempotency for Stripe webhooks
export const billingEvents = pgTable("billing_events", {
  id: text("id").primaryKey(), // Stripe event id (evt_*)
  type: text("type").notNull(),
  tenantId: varchar("tenant_id"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  payload: jsonb("payload"),
  processedAt: timestamp("processed_at").notNull().defaultNow(),
});

export type BillingEvent = typeof billingEvents.$inferSelect;

export const domainBlocklist = pgTable("domain_blocklist", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  domain: text("domain").notNull().unique(),
  reason: text("reason"), // e.g., "Personal email provider", "Generic domain"
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Service Plans - defines plan templates with default limits
export const servicePlans = pgTable("service_plans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(), // e.g., "trial", "free", "pro", "enterprise"
  displayName: text("display_name").notNull(), // e.g., "Trial", "Free", "Pro", "Enterprise"
  description: text("description"),
  // Usage limits
  competitorLimit: integer("competitor_limit").notNull().default(3),
  analysisLimit: integer("analysis_limit").notNull().default(5),
  // User limits
  adminUserLimit: integer("admin_user_limit").notNull().default(1),
  readWriteUserLimit: integer("read_write_user_limit").notNull().default(2),
  readOnlyUserLimit: integer("read_only_user_limit").notNull().default(5),
  // Multi-market settings
  multiMarketEnabled: boolean("multi_market_enabled").notNull().default(false),
  marketLimit: integer("market_limit"), // NULL = unlimited
  // Premium features - Monitoring controls
  monitoringFrequency: text("monitoring_frequency").default("weekly"), // weekly, daily, disabled (controls website crawls)
  socialMonitoringEnabled: boolean("social_monitoring_enabled").default(false),
  websiteMonitorEnabled: boolean("website_monitor_enabled").default(false), // AI-powered website change detection
  productMonitorEnabled: boolean("product_monitor_enabled").default(false), // Standalone product URL monitoring
  // Feature access flags - flexible JSONB for easy extensibility
  // Keys are feature identifiers, values are booleans. See FEATURE_REGISTRY in plan-policy.ts.
  features: jsonb("features").notNull().default({}),
  // Trial settings
  trialDays: integer("trial_days"), // Only applicable for trial plan
  // Pricing (for display purposes)
  monthlyPrice: integer("monthly_price"), // In cents, NULL = free or contact sales
  annualPrice: integer("annual_price"), // In cents, NULL = free or contact sales
  // Status
  isActive: boolean("is_active").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false), // Default plan for new signups
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertServicePlanSchema = createInsertSchema(servicePlans).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertServicePlan = z.infer<typeof insertServicePlanSchema>;
export type ServicePlan = typeof servicePlans.$inferSelect;

// Markets - a "market" is a context containing a baseline company, competitors, and projects
// Enterprise tenants can have multiple markets for different client work
export const markets = pgTable("markets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  businessType: text("business_type").notNull().default("b2b"),
  isDefault: boolean("is_default").notNull().default(false),
  status: text("status").notNull().default("active"), // active, archived
  // Per-market brand colors — used by the event image compositor and PDF renderer.
  // When set, these override the tenant-level primaryColor / secondaryColor.
  primaryColor: text("primary_color"),
  secondaryColor: text("secondary_color"),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  lastVisitedAt: timestamp("last_visited_at"),
});

// Consultant access grants - allows consultants to access specific tenants
export const consultantAccess = pgTable("consultant_access", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tenantId: varchar("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("active"), // active, revoked
  grantedBy: varchar("granted_by").notNull().references(() => users.id),
  grantedAt: timestamp("granted_at").notNull().defaultNow(),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const clientProjects = pgTable("client_projects", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(), // e.g., "Rightpoint Q1 2026 Analysis"
  clientName: text("client_name").notNull(), // e.g., "Rightpoint"
  clientDomain: text("client_domain"), // optional: rightpoint.com
  description: text("description"),
  analysisType: text("analysis_type").notNull().default("company"), // company, product
  status: text("status").notNull().default("active"), // active, completed, archived
  notifyOnUpdates: boolean("notify_on_updates").default(false), // Notify when competitor site/social updates detected
  tenantDomain: text("tenant_domain").notNull(), // owner tenant (e.g., synozur.com)
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }), // Market context (nullable for migration)
  ownerUserId: varchar("owner_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const products = pgTable("products", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  productType: text("product_type").notNull().default("product"),
  url: text("url"), // Product page URL
  companyName: text("company_name"), // Company that makes this product
  competitorId: varchar("competitor_id").references(() => competitors.id, { onDelete: "set null" }), // Optional link to competitor
  companyProfileId: varchar("company_profile_id").references(() => companyProfiles.id, { onDelete: "set null" }), // Link to baseline company (for your products)
  isBaseline: boolean("is_baseline").default(false), // True for your products, false for competitor products
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }), // Market context (nullable for migration)
  createdBy: varchar("created_by").notNull().references(() => users.id),
  crawlData: jsonb("crawl_data"), // Crawled product page data
  analysisData: jsonb("analysis_data"), // AI analysis of product
  linkedInUrl: text("linkedin_url"), // Product-specific LinkedIn page
  instagramUrl: text("instagram_url"), // Product-specific Instagram
  twitterUrl: text("twitter_url"), // Product-specific Twitter/X
  socialCheckFrequency: text("social_check_frequency").default("daily"), // hourly, daily, weekly
  lastSocialCrawl: timestamp("last_social_crawl"), // When social was last checked
  previousWebsiteContent: text("previous_website_content"), // Previous crawl content for change detection
  lastWebsiteMonitor: timestamp("last_website_monitor"), // When website was last monitored for changes
  competitivePositionSummary: text("competitive_position_summary"), // AI-generated 2-3 sentence summary of competitive positioning
  summaryGeneratedAt: timestamp("summary_generated_at"), // When the summary was last generated
  sourceContentAssetId: varchar("source_content_asset_id").references(() => contentAssets.id, { onDelete: "set null" }),
  excludeFromCrawl: boolean("exclude_from_crawl").notNull().default(false),
  consecutiveCrawlFailures: integer("consecutive_crawl_failures").notNull().default(0),
  crawlFlaggedAt: timestamp("crawl_flagged_at"),
  publicFeedbackEnabled: boolean("public_feedback_enabled").notNull().default(false),
  publicFeedbackToken: text("public_feedback_token"),
  feedbackEmailNotificationsEnabled: boolean("feedback_email_notifications_enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Product Features - for tracking product capabilities
export const productFeatures = pgTable("product_features", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  productId: varchar("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category"), // e.g., Security, Analytics, UX, Integration
  status: text("status").notNull().default("planned"), // backlog, planned, in_progress, released
  priority: text("priority").default("medium"), // high, medium, low
  targetQuarter: text("target_quarter"), // Q1, Q2, Q3, Q4 or null
  targetYear: integer("target_year"),
  competitorParity: jsonb("competitor_parity"), // JSON array of competitor IDs that have similar features
  sourceType: text("source_type").notNull().default("manual"), // manual, csv, parsed, scraped
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Roadmap Items - for product roadmap management
export const roadmapItems = pgTable("roadmap_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  productId: varchar("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  featureId: varchar("feature_id").references(() => productFeatures.id, { onDelete: "set null" }),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description"),
  quarter: text("quarter"), // Q1, Q2, Q3, Q4, or null for unscheduled
  year: integer("year"),
  effort: text("effort"), // xs, s, m, l, xl
  status: text("status").notNull().default("planned"), // planned, in_progress, completed, deferred
  aiRecommended: boolean("ai_recommended").default(false),
  fromFeedback: boolean("from_feedback").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Customer Feedback - user-submitted feature requests/feedback per product
export const productFeedback = pgTable("product_feedback", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  productId: varchar("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description"),
  category: text("category"), // optional grouping label
  status: text("status").notNull().default("new"), // new, planned, shipped, declined
  source: text("source").notNull().default("internal"), // internal, public
  submitterUserId: varchar("submitter_user_id").references(() => users.id, { onDelete: "set null" }),
  submitterEmail: text("submitter_email"),
  submitterName: text("submitter_name"),
  submitterIp: text("submitter_ip"),
  promotedFeatureId: varchar("promoted_feature_id").references(() => productFeatures.id, { onDelete: "set null" }),
  voteCount: integer("vote_count").notNull().default(0),
  embedding: jsonb("embedding"), // optional cached embedding/keywords for similarity grouping
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const productFeedbackVotes = pgTable("product_feedback_votes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  feedbackId: varchar("feedback_id").notNull().references(() => productFeedback.id, { onDelete: "cascade" }),
  productId: varchar("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  voterUserId: varchar("voter_user_id").references(() => users.id, { onDelete: "set null" }),
  voterEmail: text("voter_email"),
  voterIp: text("voter_ip"),
  voterKey: text("voter_key").notNull(), // dedupe key: user id, hashed email or hashed ip
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Feature Recommendations - AI-generated suggestions
export const featureRecommendations = pgTable("feature_recommendations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  productId: varchar("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  type: text("type").notNull(), // gap, opportunity, priority, risk
  title: text("title").notNull(),
  explanation: text("explanation").notNull(), // Detailed AI rationale
  relatedCompetitors: jsonb("related_competitors"), // JSON array of competitor IDs
  suggestedPriority: text("suggested_priority"), // high, medium, low
  suggestedQuarter: text("suggested_quarter"),
  status: text("status").notNull().default("pending"), // pending, accepted, dismissed
  assignedToUserId: varchar("assigned_to_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  assignedToIdx: index("feature_rec_assigned_to_idx").on(table.assignedToUserId),
}));

export const projectProducts = pgTable("project_products", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: varchar("project_id").notNull().references(() => clientProjects.id, { onDelete: "cascade" }),
  productId: varchar("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("competitor"), // baseline, competitor, optional
  source: text("source").notNull().default("manual"), // manual, suggested
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const organizations = pgTable("organizations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  canonicalDomain: text("canonical_domain").notNull().unique(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  status: text("status").notNull().default("active"),
  faviconUrl: text("favicon_url"),
  screenshotUrl: text("screenshot_url"),
  linkedInUrl: text("linkedin_url"),
  instagramUrl: text("instagram_url"),
  twitterUrl: text("twitter_url"),
  facebookUrl: text("facebook_url"),
  blogUrl: text("blog_url"),
  headquarters: text("headquarters"),
  founded: text("founded"),
  employeeCount: text("employee_count"),
  revenue: text("revenue"),
  fundingRaised: text("funding_raised"),
  industry: text("industry"),
  description: text("description"),
  category: text("category"),
  sicCode: text("sic_code"),
  crawlData: jsonb("crawl_data"),
  previousWebsiteContent: text("previous_website_content"),
  linkedInContent: text("linkedin_content"),
  instagramContent: text("instagram_content"),
  twitterContent: text("twitter_content"),
  facebookContent: text("facebook_content"),
  linkedInEngagement: jsonb("linkedin_engagement"),
  instagramEngagement: jsonb("instagram_engagement"),
  twitterEngagement: jsonb("twitter_engagement"),
  facebookEngagement: jsonb("facebook_engagement"),
  blogSnapshot: jsonb("blog_snapshot"),
  lastFullCrawl: timestamp("last_full_crawl"),
  lastWebsiteMonitor: timestamp("last_website_monitor"),
  lastSocialCrawl: timestamp("last_social_crawl"),
  lastCrawl: text("last_crawl"),
  archivedAt: timestamp("archived_at"),
  deletedAt: timestamp("deleted_at"),
  activeReferenceCount: integer("active_reference_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertOrganizationSchema = createInsertSchema(organizations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Organization = typeof organizations.$inferSelect;
export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;

export const competitors = pgTable("competitors", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  url: text("url").notNull(),
  linkedInUrl: text("linkedin_url"),
  instagramUrl: text("instagram_url"),
  twitterUrl: text("twitter_url"), // Twitter/X profile URL
  facebookUrl: text("facebook_url"), // Facebook page URL
  blogUrl: text("blog_url"), // Blog or RSS feed URL
  pricingPageUrl: text("pricing_page_url"), // Pricing/plans page URL for pricing intelligence tracker
  faviconUrl: text("favicon_url"), // URL to stored favicon/logo
  screenshotUrl: text("screenshot_url"), // URL to stored homepage screenshot
  lastCrawl: text("last_crawl"),
  lastSocialCrawl: timestamp("last_social_crawl"),
  linkedInContent: text("linkedin_content"), // Last crawled LinkedIn page content for diff (messaging only)
  instagramContent: text("instagram_content"), // Last crawled Instagram page content for diff (messaging only)
  twitterContent: text("twitter_content"), // Last crawled Twitter/X page content for diff
  facebookContent: text("facebook_content"), // Last crawled Facebook page content for diff
  linkedInEngagement: jsonb("linkedin_engagement"), // Snapshot: {followers, posts, reactions, comments}
  instagramEngagement: jsonb("instagram_engagement"), // Snapshot: {followers, posts, likes, comments}
  twitterEngagement: jsonb("twitter_engagement"), // Snapshot: {followers, tweets, retweets, likes}
  facebookEngagement: jsonb("facebook_engagement"), // Snapshot: {followers, likes, posts}
  blogSnapshot: jsonb("blog_snapshot"), // Snapshot: {postCount, latestTitles, capturedAt}
  crawlData: jsonb("crawl_data"), // Multi-page crawl results: {pages[], totalWordCount, crawledAt}
  lastFullCrawl: timestamp("last_full_crawl"), // Timestamp of last multi-page crawl
  previousWebsiteContent: text("previous_website_content"), // Previous crawl content for change detection
  lastWebsiteMonitor: timestamp("last_website_monitor"), // Timestamp of last website change monitoring
  lastPricingCheck: timestamp("last_pricing_check"), // Timestamp of last pricing snapshot capture (drives scheduled pricing monitor cadence)
  socialCheckFrequency: text("social_check_frequency").notNull().default("daily"), // "hourly", "daily", "weekly"
  excludeFromCrawl: boolean("exclude_from_crawl").notNull().default(false),
  status: text("status").notNull().default("Active"),
  userId: varchar("user_id").notNull().references(() => users.id),
  organizationId: varchar("organization_id").references(() => organizations.id, { onDelete: "set null" }),
  tenantDomain: text("tenant_domain"),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }), // Market context (nullable for migration)
  projectId: varchar("project_id").references(() => clientProjects.id, { onDelete: "set null" }), // Optional: for client project work
  analysisData: jsonb("analysis_data"), // AI analysis results
  // Company profile fields (for battlecard capsule overview)
  headquarters: text("headquarters"), // City, State/Country
  founded: text("founded"), // Year founded
  employeeCount: text("employee_count"), // Approximate number or range, e.g., "50-100" or "500+"
  revenue: text("revenue"), // Revenue range or estimate (e.g., "$10M-$50M", "Series B")
  fundingRaised: text("funding_raised"), // Total funding raised (e.g., "$25M")
  industry: text("industry"), // Industry/sector
  consecutiveCrawlFailures: integer("consecutive_crawl_failures").notNull().default(0),
  crawlFlaggedAt: timestamp("crawl_flagged_at"),
  // Task #100: HubSpot CRM enrichment
  hubspotCompanyId: text("hubspot_company_id"), // HubSpot Company object ID for matched competitor
  hubspotLifecycleStage: text("hubspot_lifecycle_stage"),
  hubspotOpenDealCount: integer("hubspot_open_deal_count").notNull().default(0),
  hubspotOpenDealValue: integer("hubspot_open_deal_value").notNull().default(0), // total amount across open deals (whole units of portal currency)
  hubspotLastSyncAt: timestamp("hubspot_last_sync_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const TONE_LABELS = [
  "confident",
  "defensive",
  "aggressive",
  "measured",
  "promotional",
  "technical",
  "empathetic",
  "urgent",
] as const;
export type ToneLabel = (typeof TONE_LABELS)[number];

export const activity = pgTable("activity", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: text("type").notNull(), // change, new_page, blog_post, social_update, product_update
  sourceType: text("source_type").notNull().default("competitor"), // competitor | baseline
  competitorId: varchar("competitor_id").references(() => competitors.id, { onDelete: "cascade" }), // Nullable for baseline activity
  companyProfileId: varchar("company_profile_id").references(() => companyProfiles.id, { onDelete: "cascade" }), // For baseline activity
  competitorName: text("competitor_name").notNull(), // Display name (works for both competitor and baseline)
  description: text("description").notNull(), // Brief description
  summary: text("summary"), // AI-generated summary of what changed
  details: jsonb("details"), // Structured data: {oldContent, newContent, pagesAffected[], blogTitles[], etc.}
  date: text("date").notNull(),
  impact: text("impact").notNull(),
  userId: varchar("user_id").references(() => users.id),
  tenantDomain: text("tenant_domain"),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }), // Market context
  // Task #102: Sentiment & tone analysis (analyzer always runs server-side regardless of plan)
  sentimentScore: real("sentiment_score"), // -1.0 (very negative) .. +1.0 (very positive)
  toneLabel: text("tone_label"), // one of TONE_LABELS
  toneNote: text("tone_note"), // one-sentence rationale from analyzer
  analyzedAt: timestamp("analyzed_at"),
  analyzerVersion: text("analyzer_version"), // e.g. "claude-sonnet-4-5", "mock-1"
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  competitorAnalyzedIdx: index("activity_competitor_analyzed_idx").on(table.competitorId, table.analyzedAt),
  competitorCreatedIdx: index("activity_competitor_created_idx").on(table.competitorId, table.createdAt),
}));

export const ENGAGEMENT_PLATFORMS = ["linkedin", "instagram", "twitter", "facebook"] as const;
export type EngagementPlatform = (typeof ENGAGEMENT_PLATFORMS)[number];

// Time-series engagement metrics per competitor + platform. One row per crawl so we can
// chart trends in the visualization dashboard. Latest values still live on the
// `competitors` JSONB engagement columns for fast single-record reads.
export const competitorEngagementSnapshots = pgTable("competitor_engagement_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  competitorId: varchar("competitor_id").notNull().references(() => competitors.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(), // one of ENGAGEMENT_PLATFORMS
  followers: integer("followers"),
  posts: integer("posts"),
  reactions: integer("reactions"),
  comments: integer("comments"),
  likes: integer("likes"),
  // Platform-specific extras (tweets count, shares, etc.) without growing the column set.
  raw: jsonb("raw"),
  capturedAt: timestamp("captured_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  competitorPlatformCapturedIdx: index("competitor_engagement_snapshots_competitor_platform_idx").on(
    table.competitorId, table.platform, table.capturedAt
  ),
  tenantCapturedIdx: index("competitor_engagement_snapshots_tenant_captured_idx").on(
    table.tenantDomain, table.capturedAt
  ),
}));

// Pricing intelligence: structured snapshots of competitor pricing pages over time.
// Each row captures the extracted tier structure plus the raw content used for diffing
// the next run. Change summaries are AI-generated when significant changes are detected.
export const competitorPricingSnapshots = pgTable("competitor_pricing_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  competitorId: varchar("competitor_id").references(() => competitors.id, { onDelete: "cascade" }),
  companyProfileId: varchar("company_profile_id").references(() => companyProfiles.id, { onDelete: "cascade" }),
  pricingUrl: text("pricing_url").notNull(),
  // Extracted tiers: [{name, price, billingPeriod, currency, features[], cta, isHighlighted}]
  tiers: jsonb("tiers").notNull(),
  // Free-text fields extracted alongside tiers
  pricingModel: text("pricing_model"), // e.g. "subscription", "usage-based", "perpetual", "freemium"
  currency: text("currency"), // ISO 4217, e.g. "USD"
  hasFreeTier: boolean("has_free_tier"),
  rawContent: text("raw_content"), // Normalised page text used for diffing
  changeScore: integer("change_score").notNull().default(0), // 0..100 from prior snapshot
  changeSummary: text("change_summary"), // AI narrative of change vs. previous snapshot
  // Structured change analysis: {changes: [{kind, description, significance}], categories[]}
  changeAnalysis: jsonb("change_analysis"),
  crawlMethod: text("crawl_method"), // "headless" | "http"
  capturedAt: timestamp("captured_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  competitorCapturedIdx: index("competitor_pricing_snapshots_competitor_captured_idx").on(
    table.competitorId, table.capturedAt
  ),
  tenantCapturedIdx: index("competitor_pricing_snapshots_tenant_captured_idx").on(
    table.tenantDomain, table.capturedAt
  ),
}));

export const recommendations = pgTable("recommendations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  description: text("description").notNull(),
  area: text("area").notNull(),
  impact: text("impact").notNull(),
  status: text("status").notNull().default("pending"), // pending, accepted, dismissed
  assignedTo: varchar("assigned_to").references(() => users.id),
  dismissedAt: timestamp("dismissed_at"),
  acceptedAt: timestamp("accepted_at"),
  competitorId: varchar("competitor_id").references(() => competitors.id, { onDelete: "set null" }),
  productId: varchar("product_id").references(() => products.id, { onDelete: "set null" }),
  projectId: varchar("project_id").references(() => clientProjects.id, { onDelete: "set null" }),
  userId: varchar("user_id").references(() => users.id),
  tenantDomain: text("tenant_domain"),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }), // Market context
  // Feedback and prioritization
  thumbsUp: integer("thumbs_up").notNull().default(0),
  thumbsDown: integer("thumbs_down").notNull().default(0),
  isPriority: boolean("is_priority").notNull().default(false),
  // Soft hide with duplicate prevention
  dedupeKey: text("dedupe_key"), // Normalized key for duplicate detection
  dismissedReason: text("dismissed_reason"), // already_done, not_relevant, duplicate, other
  dismissedBy: varchar("dismissed_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const reports = pgTable("reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  date: text("date").notNull(),
  type: text("type").notNull(),
  size: text("size").notNull(),
  author: text("author").notNull(),
  status: text("status").notNull(),
  scope: text("scope").notNull().default("baseline"), // "baseline" | "project"
  projectId: varchar("project_id").references(() => clientProjects.id),
  tenantDomain: text("tenant_domain"),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }), // Market context
  createdBy: varchar("created_by").references(() => users.id),
  fileUrl: text("file_url"),
  generatedFromDataAsOf: timestamp("generated_from_data_as_of"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const analysis = pgTable("analysis", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  tenantDomain: text("tenant_domain"),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }), // Market context
  themes: jsonb("themes").notNull(),
  messaging: jsonb("messaging").notNull(),
  gaps: jsonb("gaps").notNull(),
  previousContent: jsonb("previous_content"), // UX3: Snapshot of prior {themes, messaging, gaps} before regeneration
  generatedFromDataAsOf: timestamp("generated_from_data_as_of"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const battlecards = pgTable("battlecards", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  competitorId: varchar("competitor_id").notNull().references(() => competitors.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }), // Market context
  strengths: jsonb("strengths"), // Array of competitor strengths
  weaknesses: jsonb("weaknesses"), // Array of competitor weaknesses
  ourAdvantages: jsonb("our_advantages"), // How we beat this competitor
  comparison: jsonb("comparison"), // Harvey ball feature comparison: [{category, us, them, notes}]
  objections: jsonb("objections"), // Common objections and responses: [{objection, response}]
  talkTracks: jsonb("talk_tracks"), // Sales conversation guides: [{scenario, script}]
  quickStats: jsonb("quick_stats"), // {pricing, marketPosition, targetAudience, keyProducts}
  customNotes: text("custom_notes"), // Free-form notes
  previousContent: jsonb("previous_content"), // UX3: Snapshot of prior battlecard data before regeneration
  status: text("status").notNull().default("draft"), // draft, published
  lastGeneratedAt: timestamp("last_generated_at"),
  generatedFromDataAsOf: timestamp("generated_from_data_as_of"),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const productBattlecards = pgTable("product_battlecards", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  baselineProductId: varchar("baseline_product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  competitorProductId: varchar("competitor_product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  projectId: varchar("project_id").notNull().references(() => clientProjects.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }), // Market context
  strengths: jsonb("strengths"), // Array of competitor product strengths
  weaknesses: jsonb("weaknesses"), // Array of competitor product weaknesses
  ourAdvantages: jsonb("our_advantages"), // How our product beats this competitor
  keyDifferentiators: jsonb("key_differentiators"), // [{feature, ours, theirs}]
  objections: jsonb("objections"), // Common objections and responses: [{objection, response}]
  talkTracks: jsonb("talk_tracks"), // Sales conversation guides: [{scenario, script}]
  featureComparison: jsonb("feature_comparison"), // {feature: {ours: bool/text, theirs: bool/text}}
  customNotes: text("custom_notes"), // Free-form notes
  status: text("status").notNull().default("draft"), // draft, published
  lastGeneratedAt: timestamp("last_generated_at"),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Relationship reports — on-demand 12-month plans describing how to engage,
// cooperate with, sell to, compete with, speak to, or steer clear of another
// company. Default target is a tracked competitor; the perspective ("us") is
// always the active baseline company profile. Stored as markdown.
export const relationshipReports = pgTable("relationship_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  // SOURCE: the baseline company ("us") whose perspective the plan is written from.
  companyProfileId: varchar("company_profile_id").references(() => companyProfiles.id, { onDelete: "set null" }),
  // TARGET option A: a tracked competitor within the source market.
  competitorId: varchar("competitor_id").references(() => competitors.id, { onDelete: "set null" }),
  // TARGET option B: another market's baseline company (cross-market relationship).
  // Only one of competitorId / targetCompanyProfileId should be set per row.
  targetCompanyProfileId: varchar("target_company_profile_id").references(() => companyProfiles.id, { onDelete: "set null" }),
  // Denormalized target identity so reports survive deletion of the FK target and
  // can later support arbitrary external companies without any FK row.
  targetName: text("target_name").notNull(),
  targetUrl: text("target_url"),
  name: text("name").notNull(),
  content: text("content"),
  // { posture?: 'cooperate'|'compete'|'sell_to'|'steer_clear'|'observe',
  //   customGuidance?: string, focus?: string[], lastManualEdit?: string,
  //   versionHistory?: [{ content, savedAt, savedBy }] }
  savedPrompts: jsonb("saved_prompts"),
  status: text("status").notNull().default("not_generated"), // not_generated | generating | generated
  lastGeneratedAt: timestamp("last_generated_at"),
  generatedFromDataAsOf: timestamp("generated_from_data_as_of"),
  generatedBy: varchar("generated_by").references(() => users.id, { onDelete: "set null" }),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  tenantMarketIdx: index("relationship_reports_tenant_market_idx").on(table.tenantDomain, table.marketId),
  competitorIdx: index("relationship_reports_competitor_idx").on(table.competitorId),
  targetProfileIdx: index("relationship_reports_target_profile_idx").on(table.targetCompanyProfileId),
}));

export const insertRelationshipReportSchema = createInsertSchema(relationshipReports).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertRelationshipReport = z.infer<typeof insertRelationshipReportSchema>;
export type RelationshipReport = typeof relationshipReports.$inferSelect;

export const RELATIONSHIP_POSTURES = [
  "cooperate",
  "compete",
  "sell_to",
  "steer_clear",
  "observe",
] as const;
export type RelationshipPosture = (typeof RELATIONSHIP_POSTURES)[number];

// Long-form AI-generated recommendations (GTM plan, messaging framework)
export const longFormRecommendations = pgTable("long_form_recommendations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: text("type").notNull(), // gtm_plan, messaging_framework
  // Scope: can be for a project (product analysis) or company profile (company analysis)
  projectId: varchar("project_id").references(() => clientProjects.id, { onDelete: "cascade" }),
  companyProfileId: varchar("company_profile_id").references(() => companyProfiles.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }), // Market context
  // The generated content (markdown format)
  content: text("content"),
  // Saved prompts/parameters for regeneration
  savedPrompts: jsonb("saved_prompts"), // {targetRoles: [], distributionChannels: [], customGuidance: string, ...}
  // Status tracking
  status: text("status").notNull().default("not_generated"), // not_generated, generating, generated
  lastGeneratedAt: timestamp("last_generated_at"),
  generatedFromDataAsOf: timestamp("generated_from_data_as_of"),
  generatedBy: varchar("generated_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const usersRelations = relations(users, ({ many }) => ({
  competitors: many(competitors),
}));

export const competitorsRelations = relations(competitors, ({ one, many }) => ({
  user: one(users, {
    fields: [competitors.userId],
    references: [users.id],
  }),
  activities: many(activity),
}));

export const activityRelations = relations(activity, ({ one }) => ({
  competitor: one(competitors, {
    fields: [activity.competitorId],
    references: [competitors.id],
  }),
}));

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});

export const insertTenantSchema = createInsertSchema(tenants).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Shared validators for competitor / company-profile social URL fields.
// Used by both the client form (client/src/pages/app/competitors.tsx) and
// the server PATCH/POST routes so malformed URLs are rejected with parity
// (task #79). Empty strings are accepted to allow clearing a link.
const optionalSocialUrl = (regex: RegExp, message: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === "" || regex.test(v), { message });

export const socialLinkSchemas = {
  linkedInUrl: optionalSocialUrl(
    /^https?:\/\/(www\.)?linkedin\.com\/(company|in|school|showcase)\/[A-Za-z0-9._%+-]+\/?.*$/i,
    "Use a LinkedIn URL like https://linkedin.com/company/example",
  ),
  twitterUrl: optionalSocialUrl(
    /^https?:\/\/(www\.)?(twitter\.com|x\.com)\/[A-Za-z0-9_]{1,15}\/?.*$/i,
    "Use a Twitter/X URL like https://x.com/example",
  ),
  instagramUrl: optionalSocialUrl(
    /^https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.]+\/?.*$/i,
    "Use an Instagram URL like https://instagram.com/example",
  ),
  facebookUrl: optionalSocialUrl(
    /^https?:\/\/(www\.)?facebook\.com\/[A-Za-z0-9.\-_]+\/?.*$/i,
    "Use a Facebook URL like https://facebook.com/example",
  ),
  blogUrl: optionalSocialUrl(
    /^https?:\/\/[^\s.]+\.[^\s]+/i,
    "Use a full URL like https://example.com/blog or https://example.com/feed.xml",
  ),
  pricingPageUrl: optionalSocialUrl(
    /^https?:\/\/[^\s.]+\.[^\s]+/i,
    "Use a full URL like https://example.com/pricing",
  ),
} as const;

// Partial schema for PATCH bodies — every field is optional so only
// the keys actually present in the request are validated.
export const competitorSocialLinksUpdateSchema = z.object({
  linkedInUrl: socialLinkSchemas.linkedInUrl.optional().nullable(),
  twitterUrl: socialLinkSchemas.twitterUrl.optional().nullable(),
  instagramUrl: socialLinkSchemas.instagramUrl.optional().nullable(),
  facebookUrl: socialLinkSchemas.facebookUrl.optional().nullable(),
  blogUrl: socialLinkSchemas.blogUrl.optional().nullable(),
  pricingPageUrl: socialLinkSchemas.pricingPageUrl.optional().nullable(),
});

export const insertCompetitorSchema = createInsertSchema(competitors)
  .omit({
    id: true,
    createdAt: true,
    lastCrawl: true,
  })
  .extend({
    linkedInUrl: socialLinkSchemas.linkedInUrl.optional().nullable(),
    twitterUrl: socialLinkSchemas.twitterUrl.optional().nullable(),
    instagramUrl: socialLinkSchemas.instagramUrl.optional().nullable(),
    facebookUrl: socialLinkSchemas.facebookUrl.optional().nullable(),
    blogUrl: socialLinkSchemas.blogUrl.optional().nullable(),
    pricingPageUrl: socialLinkSchemas.pricingPageUrl.optional().nullable(),
  });

export const insertActivitySchema = createInsertSchema(activity).omit({
  id: true,
  createdAt: true,
  sentimentScore: true,
  toneLabel: true,
  toneNote: true,
  analyzedAt: true,
  analyzerVersion: true,
});

export const PRICING_TIER_BILLING_PERIODS = [
  "monthly",
  "annual",
  "quarterly",
  "one-time",
  "usage-based",
  "custom",
] as const;
export type PricingTierBillingPeriod = (typeof PRICING_TIER_BILLING_PERIODS)[number];

export const pricingTierSchema = z.object({
  name: z.string(),
  price: z.string().nullable().optional(), // Raw displayed price string, e.g. "$49/mo" or "Custom"
  priceAmount: z.number().nullable().optional(), // Parsed numeric amount when extractable
  billingPeriod: z.enum(PRICING_TIER_BILLING_PERIODS).nullable().optional(),
  currency: z.string().nullable().optional(),
  features: z.array(z.string()).default([]),
  cta: z.string().nullable().optional(), // "Start free trial", "Contact sales", etc.
  isHighlighted: z.boolean().default(false),
  audience: z.string().nullable().optional(), // e.g. "For startups", "For enterprises"
});
export type PricingTier = z.infer<typeof pricingTierSchema>;

export const pricingChangeAnalysisSchema = z.object({
  changes: z.array(z.object({
    kind: z.enum(["tier_added", "tier_removed", "price_changed", "features_changed", "model_changed", "other"]),
    description: z.string(),
    significance: z.enum(["high", "medium", "low"]),
  })).default([]),
  categories: z.array(z.string()).default([]),
  narrative: z.string().default(""),
});
export type PricingChangeAnalysis = z.infer<typeof pricingChangeAnalysisSchema>;

export const insertCompetitorPricingSnapshotSchema = createInsertSchema(competitorPricingSnapshots).omit({
  id: true,
  createdAt: true,
});
export type InsertCompetitorPricingSnapshot = z.infer<typeof insertCompetitorPricingSnapshotSchema>;
export type CompetitorPricingSnapshot = typeof competitorPricingSnapshots.$inferSelect;

export const insertCompetitorEngagementSnapshotSchema = createInsertSchema(competitorEngagementSnapshots).omit({
  id: true,
  createdAt: true,
});
export type InsertCompetitorEngagementSnapshot = z.infer<typeof insertCompetitorEngagementSnapshotSchema>;
export type CompetitorEngagementSnapshot = typeof competitorEngagementSnapshots.$inferSelect;

export const insertRecommendationSchema = createInsertSchema(recommendations).omit({
  id: true,
  createdAt: true,
});

export const insertReportSchema = createInsertSchema(reports).omit({
  id: true,
  createdAt: true,
});

export const insertAnalysisSchema = createInsertSchema(analysis).omit({
  id: true,
  createdAt: true,
});

export const insertEmailVerificationTokenSchema = createInsertSchema(emailVerificationTokens).omit({
  id: true,
  createdAt: true,
  used: true,
});

export const insertPasswordResetTokenSchema = createInsertSchema(passwordResetTokens).omit({
  id: true,
  createdAt: true,
  used: true,
});

export const insertTenantInviteSchema = createInsertSchema(tenantInvites).omit({
  id: true,
  createdAt: true,
  acceptedAt: true,
});

export const insertDomainBlocklistSchema = createInsertSchema(domainBlocklist).omit({
  id: true,
  createdAt: true,
});

export const insertMarketSchema = createInsertSchema(markets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertConsultantAccessSchema = createInsertSchema(consultantAccess).omit({
  id: true,
  createdAt: true,
  grantedAt: true,
  revokedAt: true,
});

export const insertClientProjectSchema = createInsertSchema(clientProjects).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertProductSchema = createInsertSchema(products).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertProjectProductSchema = createInsertSchema(projectProducts).omit({
  id: true,
  createdAt: true,
});

export const insertProductFeatureSchema = createInsertSchema(productFeatures).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertRoadmapItemSchema = createInsertSchema(roadmapItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertFeatureRecommendationSchema = createInsertSchema(featureRecommendations).omit({
  id: true,
  createdAt: true,
});

export const insertProductFeedbackSchema = createInsertSchema(productFeedback).omit({
  id: true,
  voteCount: true,
  createdAt: true,
  updatedAt: true,
});

export const insertProductFeedbackVoteSchema = createInsertSchema(productFeedbackVotes).omit({
  id: true,
  createdAt: true,
});

export const gapDismissals = pgTable("gap_dismissals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  gapIdentifier: text("gap_identifier").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  status: text("status").notNull().default("dismissed"),
  reason: text("reason"),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  dismissedBy: varchar("dismissed_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertGapDismissalSchema = createInsertSchema(gapDismissals).omit({
  id: true,
  createdAt: true,
});

export const insertBattlecardSchema = createInsertSchema(battlecards).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastGeneratedAt: true,
});

export const insertProductBattlecardSchema = createInsertSchema(productBattlecards).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastGeneratedAt: true,
});

export const insertLongFormRecommendationSchema = createInsertSchema(longFormRecommendations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenants.$inferSelect;
export type InsertEmailVerificationToken = z.infer<typeof insertEmailVerificationTokenSchema>;
export type EmailVerificationToken = typeof emailVerificationTokens.$inferSelect;
export type InsertPasswordResetToken = z.infer<typeof insertPasswordResetTokenSchema>;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type InsertTenantInvite = z.infer<typeof insertTenantInviteSchema>;
export type TenantInvite = typeof tenantInvites.$inferSelect;
export type InsertDomainBlocklist = z.infer<typeof insertDomainBlocklistSchema>;
export type DomainBlocklist = typeof domainBlocklist.$inferSelect;
export type InsertMarket = z.infer<typeof insertMarketSchema>;
export type Market = typeof markets.$inferSelect;
export type InsertConsultantAccess = z.infer<typeof insertConsultantAccessSchema>;
export type ConsultantAccess = typeof consultantAccess.$inferSelect;
export type InsertClientProject = z.infer<typeof insertClientProjectSchema>;
export type ClientProject = typeof clientProjects.$inferSelect;
export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof products.$inferSelect;
export type InsertProjectProduct = z.infer<typeof insertProjectProductSchema>;
export type ProjectProduct = typeof projectProducts.$inferSelect;
export type InsertProductFeature = z.infer<typeof insertProductFeatureSchema>;
export type ProductFeature = typeof productFeatures.$inferSelect;
export type InsertRoadmapItem = z.infer<typeof insertRoadmapItemSchema>;
export type RoadmapItem = typeof roadmapItems.$inferSelect;
export type InsertFeatureRecommendation = z.infer<typeof insertFeatureRecommendationSchema>;
export type FeatureRecommendation = typeof featureRecommendations.$inferSelect;
export type InsertProductFeedback = z.infer<typeof insertProductFeedbackSchema>;
export type ProductFeedback = typeof productFeedback.$inferSelect;
export type InsertProductFeedbackVote = z.infer<typeof insertProductFeedbackVoteSchema>;
export type ProductFeedbackVote = typeof productFeedbackVotes.$inferSelect;
export type InsertCompetitor = z.infer<typeof insertCompetitorSchema>;
export type Competitor = typeof competitors.$inferSelect;
export type InsertActivity = z.infer<typeof insertActivitySchema>;
export type Activity = typeof activity.$inferSelect;
export type InsertRecommendation = z.infer<typeof insertRecommendationSchema>;
export type Recommendation = typeof recommendations.$inferSelect;
export type InsertReport = z.infer<typeof insertReportSchema>;
export type Report = typeof reports.$inferSelect;
export type InsertAnalysis = z.infer<typeof insertAnalysisSchema>;
export type Analysis = typeof analysis.$inferSelect;
export type InsertBattlecard = z.infer<typeof insertBattlecardSchema>;
export type Battlecard = typeof battlecards.$inferSelect;
export type InsertProductBattlecard = z.infer<typeof insertProductBattlecardSchema>;
export type ProductBattlecard = typeof productBattlecards.$inferSelect;
export type InsertLongFormRecommendation = z.infer<typeof insertLongFormRecommendationSchema>;
export type LongFormRecommendation = typeof longFormRecommendations.$inferSelect;
export type InsertGapDismissal = z.infer<typeof insertGapDismissalSchema>;
export type GapDismissal = typeof gapDismissals.$inferSelect;

// Chat tables for AI conversations
export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertConversationSchema = createInsertSchema(conversations).omit({
  id: true,
  createdAt: true,
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
});

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;

// Grounding documents table for AI context
export const GROUNDING_DOC_CONTEXTS = [
  "competitive_analysis",
  "recommendations",
  "executive_summary",
  "intelligence_briefing",
  "marketing_content",
  "email_generation",
  "product_features",
  "product_roadmap",
  // Authoritative strategy docs the team uploads. When present, these take
  // precedence over the machine-generated equivalents in strategic context.
  "messaging_framework",
  "gtm_plan",
] as const;

export const GROUNDING_DOC_CONTEXT_LABELS: Record<string, string> = {
  competitive_analysis: "Competitive Analysis",
  recommendations: "Recommendations",
  executive_summary: "Executive Summary",
  intelligence_briefing: "Intelligence Briefing",
  marketing_content: "Social Posts & Content Summaries",
  email_generation: "Email Generation",
  product_features: "Product Features",
  product_roadmap: "Product Roadmap",
  messaging_framework: "Messaging & Positioning Framework (authoritative)",
  gtm_plan: "Go-To-Market Plan (authoritative)",
};

export const GROUNDING_DOC_CONTEXT_PRESETS: Record<string, string[]> = {
  all: [...GROUNDING_DOC_CONTEXTS],
  intelligence: ["competitive_analysis", "recommendations", "executive_summary", "intelligence_briefing"],
  marketing: ["marketing_content", "email_generation", "messaging_framework", "gtm_plan"],
  product: ["product_features", "product_roadmap"],
};

export const groundingDocuments = pgTable("grounding_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  fileType: text("file_type").notNull(),
  fileUrl: text("file_url").notNull(),
  fileSize: integer("file_size").notNull(),
  extractedText: text("extracted_text"),
  scope: text("scope").notNull().default("tenant"),
  useCase: text("use_case").notNull().default("intelligence"),
  contexts: jsonb("contexts").$type<string[]>(),
  competitorId: varchar("competitor_id").references(() => competitors.id, { onDelete: "set null" }),
  productId: varchar("product_id").references(() => products.id, { onDelete: "set null" }),
  userId: varchar("user_id").notNull().references(() => users.id),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  speFileId: text("spe_file_id"),
  speContainerId: text("spe_container_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const groundingDocumentsRelations = relations(groundingDocuments, ({ one }) => ({
  user: one(users, {
    fields: [groundingDocuments.userId],
    references: [users.id],
  }),
  competitor: one(competitors, {
    fields: [groundingDocuments.competitorId],
    references: [competitors.id],
  }),
  product: one(products, {
    fields: [groundingDocuments.productId],
    references: [products.id],
  }),
}));

export const insertGroundingDocumentSchema = createInsertSchema(groundingDocuments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type GroundingDocument = typeof groundingDocuments.$inferSelect;
export type InsertGroundingDocument = z.infer<typeof insertGroundingDocumentSchema>;

// Per-competitor uploaded documents (datasheets, case studies, annual reports, etc.)
// Competitor-scoped uploaded documents — separate from groundingDocuments to allow distinct UX, scope tags, and
// soft-delete archive workflow without polluting the company grounding library.
export const competitorDocuments = pgTable("competitor_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  competitorId: varchar("competitor_id").notNull().references(() => competitors.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  displayTitle: text("display_title").notNull(),
  scopeTag: text("scope_tag"),
  objectStoragePath: text("object_storage_path"),
  speFileId: text("spe_file_id"),
  speContainerId: text("spe_container_id"),
  byteSize: integer("byte_size").notNull(),
  mimeType: text("mime_type").notNull(),
  fileType: text("file_type").notNull(),
  extractedText: text("extracted_text"),
  status: text("status").notNull().default("active"),
  uploadedByUserId: varchar("uploaded_by_user_id").notNull().references(() => users.id),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
}, (table) => ({
  tenantCompetitorIdx: index("competitor_documents_tenant_competitor_status_idx")
    .on(table.tenantDomain, table.competitorId, table.status),
  competitorIdx: index("competitor_documents_competitor_idx").on(table.competitorId),
}));

export const competitorDocumentsRelations = relations(competitorDocuments, ({ one }) => ({
  competitor: one(competitors, {
    fields: [competitorDocuments.competitorId],
    references: [competitors.id],
  }),
  uploadedBy: one(users, {
    fields: [competitorDocuments.uploadedByUserId],
    references: [users.id],
  }),
}));

export const insertCompetitorDocumentSchema = createInsertSchema(competitorDocuments).omit({
  id: true,
  uploadedAt: true,
  archivedAt: true,
});

export type CompetitorDocument = typeof competitorDocuments.$inferSelect;
export type InsertCompetitorDocument = z.infer<typeof insertCompetitorDocumentSchema>;

// Global grounding documents - application-wide AI context (Global Admin only)
export const globalGroundingDocuments = pgTable("global_grounding_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull(), // brand_voice, marketing_guidelines, digital_assets, methodology, etc.
  fileType: text("file_type").notNull(), // pdf, docx, txt, md
  originalFileName: text("original_file_name").notNull(),
  extractedText: text("extracted_text").notNull(), // Extracted text content - we only store this to save space
  wordCount: integer("word_count").notNull().default(0),
  uploadedBy: varchar("uploaded_by").notNull().references(() => users.id),
  isActive: boolean("is_active").notNull().default(true), // Can disable without deleting
  // SharePoint Embedded — drive-item ID when stored in SPE (null = not in SPE)
  speFileId: text("spe_file_id"),
  speContainerId: text("spe_container_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const globalGroundingDocumentsRelations = relations(globalGroundingDocuments, ({ one }) => ({
  uploader: one(users, {
    fields: [globalGroundingDocuments.uploadedBy],
    references: [users.id],
  }),
}));

export const insertGlobalGroundingDocumentSchema = createInsertSchema(globalGroundingDocuments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type GlobalGroundingDocument = typeof globalGroundingDocuments.$inferSelect;
export type InsertGlobalGroundingDocument = z.infer<typeof insertGlobalGroundingDocumentSchema>;

// Company profiles table for baselining own website
// In multi-market mode, each market has its own company profile (baseline)
export const companyProfiles = pgTable("company_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  tenantDomain: text("tenant_domain").notNull(),
  organizationId: varchar("organization_id").references(() => organizations.id, { onDelete: "set null" }),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }), // Market context - each market has its baseline
  companyName: text("company_name").notNull(),
  websiteUrl: text("website_url").notNull(),
  logoUrl: text("logo_url"), // Company logo URL (uploaded or external)
  linkedInUrl: text("linkedin_url"),
  instagramUrl: text("instagram_url"),
  twitterUrl: text("twitter_url"), // Twitter/X profile URL
  facebookUrl: text("facebook_url"), // Facebook page URL
  blogUrl: text("blog_url"), // Blog or RSS feed URL for baseline company
  pricingPageUrl: text("pricing_page_url"), // Pricing page URL for baseline company
  lastPricingCheck: timestamp("last_pricing_check"), // Last pricing snapshot capture
  description: text("description"),
  // Directory fields - stable columns for company information
  headquarters: text("headquarters"), // City, State/Country
  founded: text("founded"), // Year founded
  employeeCount: text("employee_count"), // Employee count or range
  industry: text("industry"), // Industry/sector
  revenue: text("revenue"), // Revenue range
  fundingRaised: text("funding_raised"), // Total funding raised (e.g., "$25M")
  lastAnalysis: timestamp("last_analysis"),
  analysisData: jsonb("analysis_data"),
  lastCrawl: text("last_crawl"),
  lastSocialCrawl: timestamp("last_social_crawl"),
  linkedInContent: text("linkedin_content"),
  instagramContent: text("instagram_content"),
  twitterContent: text("twitter_content"),
  facebookContent: text("facebook_content"),
  linkedInEngagement: jsonb("linkedin_engagement"),
  instagramEngagement: jsonb("instagram_engagement"),
  twitterEngagement: jsonb("twitter_engagement"),
  facebookEngagement: jsonb("facebook_engagement"),
  blogSnapshot: jsonb("blog_snapshot"),
  crawlData: jsonb("crawl_data"),
  lastFullCrawl: timestamp("last_full_crawl"),
  previousWebsiteContent: text("previous_website_content"),
  lastWebsiteMonitor: timestamp("last_website_monitor"),
  socialCheckFrequency: text("social_check_frequency").notNull().default("daily"), // "hourly", "daily", "weekly"
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const companyProfilesRelations = relations(companyProfiles, ({ one }) => ({
  user: one(users, {
    fields: [companyProfiles.userId],
    references: [users.id],
  }),
}));

export const insertCompanyProfileSchema = createInsertSchema(companyProfiles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastAnalysis: true,
  analysisData: true,
});

export type CompanyProfile = typeof companyProfiles.$inferSelect;
export type InsertCompanyProfile = z.infer<typeof insertCompanyProfileSchema>;

// Assessments table for saving analysis snapshots
export const assessments = pgTable("assessments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  userId: varchar("user_id").notNull().references(() => users.id),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }), // Market context
  // Snapshot of analysis at time of assessment
  companyProfileSnapshot: jsonb("company_profile_snapshot"),
  competitorsSnapshot: jsonb("competitors_snapshot").notNull(),
  analysisSnapshot: jsonb("analysis_snapshot").notNull(),
  recommendationsSnapshot: jsonb("recommendations_snapshot"),
  // Proxy assessment fields (following Orion pattern)
  isProxy: boolean("is_proxy").notNull().default(false),
  proxyName: text("proxy_name"),
  proxyCompany: text("proxy_company"),
  proxyJobTitle: text("proxy_job_title"),
  proxyIndustry: text("proxy_industry"),
  proxyCompanySize: text("proxy_company_size"),
  proxyCountry: text("proxy_country"),
  // Status and timestamps
  status: text("status").notNull().default("completed"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const assessmentsRelations = relations(assessments, ({ one }) => ({
  user: one(users, {
    fields: [assessments.userId],
    references: [users.id],
  }),
}));

export const insertAssessmentSchema = createInsertSchema(assessments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Assessment = typeof assessments.$inferSelect;
export type InsertAssessment = z.infer<typeof insertAssessmentSchema>;

// Page views for traffic analytics
export const pageViews = pgTable("page_views", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  path: text("path").notNull(), // e.g., "/", "/auth/signup"
  sessionId: text("session_id").notNull(), // anonymous session tracking
  ipHash: text("ip_hash"), // hashed IP for unique visitor counting
  userAgent: text("user_agent"),
  referrer: text("referrer"),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  country: text("country"), // IP geolocation country code
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertPageViewSchema = createInsertSchema(pageViews).omit({
  id: true,
  createdAt: true,
});

export type PageView = typeof pageViews.$inferSelect;
export type InsertPageView = z.infer<typeof insertPageViewSchema>;

// Competitor/Product scores for ranking and comparison
// Supports both company-level competitors and standalone products
export const competitorScores = pgTable("competitor_scores", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  competitorId: varchar("competitor_id").references(() => competitors.id, { onDelete: "cascade" }), // Nullable for standalone products
  productId: varchar("product_id").references(() => products.id, { onDelete: "cascade" }), // For product-level scoring
  projectId: varchar("project_id").references(() => clientProjects.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }), // Market context
  entityName: text("entity_name"), // Cached name for display (competitor or product name)
  overallScore: integer("overall_score").notNull().default(0), // 0-100 composite score
  marketPresenceScore: integer("market_presence_score").default(0), // 0-100
  innovationScore: integer("innovation_score").default(0), // 0-100
  pricingScore: integer("pricing_score").default(0), // 0-100
  featureBreadthScore: integer("feature_breadth_score").default(0), // 0-100
  contentActivityScore: integer("content_activity_score").default(0), // 0-100
  socialEngagementScore: integer("social_engagement_score").default(0), // 0-100
  trendDirection: text("trend_direction").default("stable"), // rising, falling, stable
  trendDelta: integer("trend_delta").default(0), // Change in overall score from last period
  previousOverallScore: integer("previous_overall_score"), // For trend calculation
  scoreBreakdown: jsonb("score_breakdown"), // Detailed breakdown for UI display
  lastCalculatedAt: timestamp("last_calculated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const competitorScoresRelations = relations(competitorScores, ({ one }) => ({
  competitor: one(competitors, {
    fields: [competitorScores.competitorId],
    references: [competitors.id],
  }),
  product: one(products, {
    fields: [competitorScores.productId],
    references: [products.id],
  }),
  project: one(clientProjects, {
    fields: [competitorScores.projectId],
    references: [clientProjects.id],
  }),
}));

export const insertCompetitorScoreSchema = createInsertSchema(competitorScores).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastCalculatedAt: true,
});

export type CompetitorScore = typeof competitorScores.$inferSelect;
export type InsertCompetitorScore = z.infer<typeof insertCompetitorScoreSchema>;

// Social metrics time series for trend tracking
export const socialMetrics = pgTable("social_metrics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  competitorId: varchar("competitor_id").notNull().references(() => competitors.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }), // Market context
  platform: text("platform").notNull(), // linkedin, instagram, twitter, blog
  period: text("period").notNull(), // weekly, daily snapshot identifier (e.g., "2026-W03")
  followers: integer("followers").default(0),
  followersDelta: integer("followers_delta").default(0), // Change from previous period
  posts: integer("posts").default(0),
  postsDelta: integer("posts_delta").default(0),
  engagement: integer("engagement").default(0), // Total likes, comments, shares
  engagementDelta: integer("engagement_delta").default(0),
  mentions: integer("mentions").default(0), // Brand mentions (if tracked)
  mentionsDelta: integer("mentions_delta").default(0),
  rawData: jsonb("raw_data"), // Full platform-specific metrics
  capturedAt: timestamp("captured_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const socialMetricsRelations = relations(socialMetrics, ({ one }) => ({
  competitor: one(competitors, {
    fields: [socialMetrics.competitorId],
    references: [competitors.id],
  }),
}));

export const insertSocialMetricSchema = createInsertSchema(socialMetrics).omit({
  id: true,
  createdAt: true,
  capturedAt: true,
});

export type SocialMetric = typeof socialMetrics.$inferSelect;
export type InsertSocialMetric = z.infer<typeof insertSocialMetricSchema>;

// Score history for tracking Orbit Scores over time (competitors and baselines)
export const scoreHistory = pgTable("score_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  entityType: text("entity_type").notNull(), // "competitor" or "baseline"
  entityId: varchar("entity_id").notNull(), // competitorId or companyProfileId
  entityName: text("entity_name").notNull(), // Cached name for display
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  projectId: varchar("project_id").references(() => clientProjects.id, { onDelete: "cascade" }),
  overallScore: integer("overall_score").notNull(), // 0-100
  innovationScore: integer("innovation_score").default(0),
  marketPresenceScore: integer("market_presence_score").default(0),
  contentActivityScore: integer("content_activity_score").default(0),
  socialEngagementScore: integer("social_engagement_score").default(0),
  scoreBreakdown: jsonb("score_breakdown"), // Full breakdown for analysis
  period: text("period").notNull(), // e.g., "2026-01", "2026-W04" 
  recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const scoreHistoryRelations = relations(scoreHistory, ({ one }) => ({
  project: one(clientProjects, {
    fields: [scoreHistory.projectId],
    references: [clientProjects.id],
  }),
  market: one(markets, {
    fields: [scoreHistory.marketId],
    references: [markets.id],
  }),
}));

export const insertScoreHistorySchema = createInsertSchema(scoreHistory).omit({
  id: true,
  createdAt: true,
  recordedAt: true,
});

export type ScoreHistory = typeof scoreHistory.$inferSelect;
export type InsertScoreHistory = z.infer<typeof insertScoreHistorySchema>;

// Executive summary cache for fast dashboard loading
export const executiveSummaries = pgTable("executive_summaries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: varchar("project_id").references(() => clientProjects.id, { onDelete: "cascade" }),
  companyProfileId: varchar("company_profile_id").references(() => companyProfiles.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }), // Market context
  scope: text("scope").notNull().default("baseline"), // baseline or project
  // 4-part executive summary sections
  companySnapshot: text("company_snapshot"), // 1-2 sentence company overview + key facts
  marketPosition: text("market_position"), // Score vs competitors + comparative insights
  competitiveLandscape: text("competitive_landscape"), // Top competitors + themes/gaps
  opportunities: text("opportunities"), // Top recommendations + actions
  // Editing/locking support
  lockedSections: jsonb("locked_sections").default([]), // Array of locked section names
  dataHash: text("data_hash"), // Hash of source data to detect changes
  // Legacy fields for backwards compatibility
  summaryData: jsonb("summary_data"), // Aggregated executive summary payload
  topCompetitors: jsonb("top_competitors"), // Ranked list of top competitors with scores
  keyInsights: jsonb("key_insights"), // AI-generated key insights
  alertItems: jsonb("alert_items"), // Items needing attention (rising competitors, gaps)
  lastGeneratedAt: timestamp("last_generated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const executiveSummariesRelations = relations(executiveSummaries, ({ one }) => ({
  project: one(clientProjects, {
    fields: [executiveSummaries.projectId],
    references: [clientProjects.id],
  }),
  companyProfile: one(companyProfiles, {
    fields: [executiveSummaries.companyProfileId],
    references: [companyProfiles.id],
  }),
}));

export const insertExecutiveSummarySchema = createInsertSchema(executiveSummaries).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastGeneratedAt: true,
});

export type ExecutiveSummary = typeof executiveSummaries.$inferSelect;
export type InsertExecutiveSummary = z.infer<typeof insertExecutiveSummarySchema>;

// F2: Competitive Positioning Map — stores x/y positions per competitor/baseline per tenant
export const competitorPositions = pgTable("competitor_positions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  // Either competitorId (for a tracked competitor) or companyProfileId (for the baseline)
  competitorId: varchar("competitor_id").references(() => competitors.id, { onDelete: "cascade" }),
  companyProfileId: varchar("company_profile_id").references(() => companyProfiles.id, { onDelete: "cascade" }),
  label: text("label").notNull(), // Display name on chart
  xAxis: text("x_axis").notNull().default("Market Presence"), // Which dimension for X
  yAxis: text("y_axis").notNull().default("Innovation"), // Which dimension for Y
  xValue: integer("x_value").notNull().default(50), // 0–100 position
  yValue: integer("y_value").notNull().default(50), // 0–100 position
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  // Enforce exactly one entity per row: either a tracked competitor OR the company baseline
  check("competitor_positions_entity_xor", sql`(${t.competitorId} IS NOT NULL AND ${t.companyProfileId} IS NULL) OR (${t.competitorId} IS NULL AND ${t.companyProfileId} IS NOT NULL)`),
]);

export const insertCompetitorPositionSchema = createInsertSchema(competitorPositions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type CompetitorPosition = typeof competitorPositions.$inferSelect;
export type InsertCompetitorPosition = z.infer<typeof insertCompetitorPositionSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// AI Provider & Model Management
// Multi-provider support with per-function model assignments.
// Providers: Replit AI (Anthropic/OpenAI), Azure AI Foundry
// ═══════════════════════════════════════════════════════════════════════════

export const AI_PROVIDERS = {
  REPLIT_ANTHROPIC: 'replit_anthropic',
  REPLIT_OPENAI: 'replit_openai',
  AZURE_FOUNDRY: 'azure_foundry',
} as const;

export type AIProviderKey = typeof AI_PROVIDERS[keyof typeof AI_PROVIDERS];

export const AI_FEATURES = {
  COMPETITOR_ANALYSIS: 'competitor_analysis',
  GAP_ANALYSIS: 'gap_analysis',
  RECOMMENDATIONS: 'recommendations',
  BATTLECARD: 'battlecard',
  GTM_PLAN: 'gtm_plan',
  MESSAGING_FRAMEWORK: 'messaging_framework',
  CHANGE_DETECTION: 'change_detection',
  INTELLIGENCE_BRIEFING: 'intelligence_briefing',
  ROADMAP_RECOMMENDATIONS: 'roadmap_recommendations',
  FEATURE_EXTRACTION: 'feature_extraction',
  PRODUCT_ONE_SHEET: 'product_one_sheet',
  MARKETING_TASKS: 'marketing_tasks',
  COMPANY_RESEARCH: 'company_research',
  RELATIONSHIP_REPORT: 'relationship_report',
  // Sales outreach (see docs/sales-outreach-campaign-plan.md)
  OUTREACH_INTERVIEW: 'outreach_interview',
  PROSPECT_RESEARCH: 'prospect_research',
  OUTREACH_COMPOSER: 'outreach_composer',
  OUTREACH_VOICE_EXTRACT: 'outreach_voice_extract',
  // Observatory (application assurance) — AI-assisted drafting of finding
  // descriptions/recommendations from workbench review notes.
  OBSERVATORY_ASSIST: 'observatory_assist',
  // Observatory reporting — executive summary drafts and VPAT remark drafting.
  OBSERVATORY_REPORT: 'observatory_report',
} as const;

export type AIFeature = typeof AI_FEATURES[keyof typeof AI_FEATURES];

export const AI_FEATURE_LABELS: Record<AIFeature, string> = {
  competitor_analysis: 'Competitor Website Analysis',
  gap_analysis: 'Gap Analysis',
  recommendations: 'Recommendations',
  battlecard: 'Battlecard Generation',
  gtm_plan: 'GTM Plan Generation',
  messaging_framework: 'Messaging Framework',
  change_detection: 'Website Change Detection',
  intelligence_briefing: 'Intelligence Briefing',
  roadmap_recommendations: 'Product Roadmap Recommendations',
  feature_extraction: 'Feature Extraction',
  product_one_sheet: 'Product One-Sheet',
  marketing_tasks: 'Marketing Task Generation',
  company_research: 'AI Company Research',
  relationship_report: 'Relationship Report (12-month plan)',
  outreach_interview: 'Outreach Campaign Interview',
  prospect_research: 'Prospect Research & Scoring',
  outreach_composer: 'Outreach Draft Composer',
  outreach_voice_extract: 'Outbound Voice Extraction',
  observatory_assist: 'Observatory Finding Drafting',
  observatory_report: 'Observatory Report Summaries',
};

export const AI_MODELS: Record<string, readonly string[]> = {
  replit_anthropic: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-sonnet-4', 'claude-opus-4'],
  replit_openai: ['gpt-4o', 'gpt-4o-mini'],
  azure_foundry: ['gpt-5-5', 'claude-sonnet-4-6', 'gpt-5.4', 'gpt-5.2', 'gpt-4o', 'mistral-large', 'cohere-command-r-plus', 'meta-llama-3.1-405b'],
} as const;

export type AzureFoundryEndpointType = 'aoai' | 'inference';

export const AZURE_FOUNDRY_MODEL_ENDPOINT: Record<string, AzureFoundryEndpointType> = {
  'gpt-5-5': 'aoai',
  'claude-sonnet-4-6': 'aoai',
  'gpt-5.4': 'aoai',
  'gpt-5.2': 'aoai',
  'gpt-4o': 'aoai',
  'mistral-large': 'inference',
  'cohere-command-r-plus': 'inference',
  'meta-llama-3.1-405b': 'inference',
};

export const AI_MODEL_INFO: Record<string, {
  name: string;
  description: string;
  costTier: 'free' | 'low' | 'medium' | 'high';
  providers: string[];
  contextWindow: number;
  costPer1kPrompt: number;
  costPer1kCompletion: number;
  endpointType?: AzureFoundryEndpointType;
}> = {
  'gpt-5-5': { name: 'GPT-5.5', description: 'OpenAI flagship — highest capacity (5M TPM)', costTier: 'high', providers: ['azure_foundry'], contextWindow: 128000, costPer1kPrompt: 0.005, costPer1kCompletion: 0.015, endpointType: 'aoai' },
  'claude-sonnet-4-6': { name: 'Claude Sonnet 4.6', description: 'Latest Claude Sonnet via Azure Foundry', costTier: 'high', providers: ['azure_foundry'], contextWindow: 200000, costPer1kPrompt: 0.003, costPer1kCompletion: 0.015, endpointType: 'aoai' },
  'gpt-5.4': { name: 'GPT-5.4', description: 'Latest and most capable OpenAI model', costTier: 'high', providers: ['azure_foundry'], contextWindow: 128000, costPer1kPrompt: 0.005, costPer1kCompletion: 0.015, endpointType: 'aoai' },
  'gpt-5.2': { name: 'GPT-5.2', description: 'Advanced reasoning OpenAI model', costTier: 'high', providers: ['azure_foundry'], contextWindow: 128000, costPer1kPrompt: 0.005, costPer1kCompletion: 0.015, endpointType: 'aoai' },
  'gpt-4o': { name: 'GPT-4o', description: 'Fast multimodal model', costTier: 'medium', providers: ['replit_openai', 'azure_foundry'], contextWindow: 128000, costPer1kPrompt: 0.0025, costPer1kCompletion: 0.01 },
  'gpt-4o-mini': { name: 'GPT-4o Mini', description: 'Cost-effective for simple tasks', costTier: 'low', providers: ['replit_openai'], contextWindow: 128000, costPer1kPrompt: 0.00015, costPer1kCompletion: 0.0006 },
  'mistral-large': { name: 'Mistral Large', description: 'Mistral flagship model via Azure Foundry', costTier: 'medium', providers: ['azure_foundry'], contextWindow: 128000, costPer1kPrompt: 0.002, costPer1kCompletion: 0.006, endpointType: 'inference' },
  'cohere-command-r-plus': { name: 'Cohere Command R+', description: 'Cohere enterprise model via Azure Foundry', costTier: 'medium', providers: ['azure_foundry'], contextWindow: 128000, costPer1kPrompt: 0.0025, costPer1kCompletion: 0.01, endpointType: 'inference' },
  'meta-llama-3.1-405b': { name: 'Meta Llama 3.1 405B', description: 'Meta open-weight flagship model via Azure Foundry', costTier: 'medium', providers: ['azure_foundry'], contextWindow: 128000, costPer1kPrompt: 0.00533, costPer1kCompletion: 0.016, endpointType: 'inference' },
  'claude-sonnet-4-5': { name: 'Claude Sonnet 4.5', description: 'Balanced intelligence and speed', costTier: 'medium', providers: ['replit_anthropic'], contextWindow: 200000, costPer1kPrompt: 0.003, costPer1kCompletion: 0.015 },
  'claude-haiku-4-5': { name: 'Claude Haiku 4.5', description: 'Fast and cost-effective', costTier: 'low', providers: ['replit_anthropic'], contextWindow: 200000, costPer1kPrompt: 0.0008, costPer1kCompletion: 0.004 },
  'claude-sonnet-4': { name: 'Claude Sonnet 4', description: 'Previous generation balanced model', costTier: 'medium', providers: ['replit_anthropic'], contextWindow: 200000, costPer1kPrompt: 0.003, costPer1kCompletion: 0.015 },
  'claude-opus-4': { name: 'Claude Opus 4', description: 'Most capable Claude model', costTier: 'high', providers: ['replit_anthropic'], contextWindow: 200000, costPer1kPrompt: 0.015, costPer1kCompletion: 0.075 },
};

export const AI_PROVIDER_LABELS: Record<string, string> = {
  replit_anthropic: 'Replit AI (Anthropic)',
  replit_openai: 'Replit AI (OpenAI)',
  azure_foundry: 'Azure AI Foundry',
};

export const aiConfiguration = pgTable("ai_configuration", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  defaultProvider: text("default_provider").notNull().default('replit_anthropic'),
  defaultModel: text("default_model").notNull().default('claude-sonnet-4-5'),
  maxTokensPerRequest: integer("max_tokens_per_request").default(8192),
  monthlyTokenBudget: integer("monthly_token_budget"),
  alertThresholds: jsonb("alert_thresholds").$type<number[]>().default([75, 90, 100]),
  alertEnabled: boolean("alert_enabled").default(true),
  updatedBy: varchar("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAiConfigurationSchema = createInsertSchema(aiConfiguration).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAiConfiguration = z.infer<typeof insertAiConfigurationSchema>;
export type AiConfiguration = typeof aiConfiguration.$inferSelect;

export const aiFeatureModelAssignments = pgTable("ai_feature_model_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  feature: text("feature").notNull().unique(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  maxTokens: integer("max_tokens"),
  updatedBy: varchar("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAiFeatureModelAssignmentSchema = createInsertSchema(aiFeatureModelAssignments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAiFeatureModelAssignment = z.infer<typeof insertAiFeatureModelAssignmentSchema>;
export type AiFeatureModelAssignment = typeof aiFeatureModelAssignments.$inferSelect;

export const aiUsageAlerts = pgTable("ai_usage_alerts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  periodMonth: varchar("period_month", { length: 7 }).notNull(),
  thresholdPercent: integer("threshold_percent").notNull(),
  tokenUsageAtAlert: integer("token_usage_at_alert").notNull(),
  monthlyBudget: integer("monthly_budget").notNull(),
  alertedAt: timestamp("alerted_at").notNull().defaultNow(),
  notifiedEmails: jsonb("notified_emails").$type<string[]>(),
});

export const insertAiUsageAlertSchema = createInsertSchema(aiUsageAlerts).omit({
  id: true,
  alertedAt: true,
});
export type InsertAiUsageAlert = z.infer<typeof insertAiUsageAlertSchema>;
export type AiUsageAlert = typeof aiUsageAlerts.$inferSelect;

// AI Usage tracking for monitoring API costs across tenants
export const aiUsage = pgTable("ai_usage", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain"), // null for system-level calls
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  userId: varchar("user_id").references(() => users.id, { onDelete: "set null" }),
  provider: text("provider").notNull(), // openai, anthropic
  model: text("model").notNull(), // gpt-4o, claude-3-5-sonnet, etc.
  operation: text("operation").notNull(), // analyze_competitor, generate_battlecard, etc.
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  estimatedCost: text("estimated_cost"), // Stored as string to avoid floating point issues
  durationMs: integer("duration_ms"), // How long the API call took
  success: boolean("success").notNull().default(true),
  errorMessage: text("error_message"),
  metadata: jsonb("metadata"), // Additional context like competitor name, project id, etc.
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAiUsageSchema = createInsertSchema(aiUsage).omit({
  id: true,
  createdAt: true,
});

export type AiUsage = typeof aiUsage.$inferSelect;
export type InsertAiUsage = z.infer<typeof insertAiUsageSchema>;

// Marketing Plans - Enterprise feature for GTM task management
export const marketingPlans = pgTable("marketing_plans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  fiscalYear: text("fiscal_year").notNull(), // e.g., "2026"
  description: text("description"),
  configMatrix: jsonb("config_matrix"), // Stores activity group × timeframe × priority selections
  status: text("status").notNull().default("draft"), // draft, active, archived
  createdBy: varchar("created_by").notNull().references(() => users.id),
  // Microsoft Planner integration — links this Orbit plan to an M365 group/plan/bucket
  plannerGroupId: text("planner_group_id"),
  plannerGroupName: text("planner_group_name"),
  plannerPlanId: text("planner_plan_id"),
  plannerPlanName: text("planner_plan_name"),
  plannerBucketId: text("planner_bucket_id"),
  plannerBucketName: text("planner_bucket_name"),
  plannerConnectedBy: varchar("planner_connected_by").references(() => users.id, { onDelete: "set null" }),
  plannerSyncEnabled: boolean("planner_sync_enabled").default(false),
  plannerLastSyncAt: timestamp("planner_last_sync_at"),
  plannerLastSyncError: text("planner_last_sync_error"),
  // Vega Launchpad direct-push history (Task #117)
  vegaLastPushAt: timestamp("vega_last_push_at"),
  vegaLastPushStatus: text("vega_last_push_status"), // success | failure
  vegaLastPushError: text("vega_last_push_error"),
  vegaLastPushBundleId: text("vega_last_push_bundle_id"), // Remote ID returned by the Launchpad
  vegaLastPushedBy: varchar("vega_last_pushed_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const marketingPlansRelations = relations(marketingPlans, ({ many }) => ({
  tasks: many(marketingTasks),
}));

export const insertMarketingPlanSchema = createInsertSchema(marketingPlans).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type MarketingPlan = typeof marketingPlans.$inferSelect;
export type InsertMarketingPlan = z.infer<typeof insertMarketingPlanSchema>;

// Marketing Tasks - Individual tasks within a marketing plan
export const marketingTasks = pgTable("marketing_tasks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  planId: varchar("plan_id").notNull().references(() => marketingPlans.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  activityGroup: text("activity_group").notNull(), // Themes, Digital, Outbound, Partners, Events
  timeframe: text("timeframe").notNull(), // Ongoing, Q1, Q2, Q3, Q4, Future
  priority: text("priority").notNull().default("Medium"), // High, Medium, Low
  status: text("status").notNull().default("suggested"), // suggested, accepted, in_progress, completed, removed
  aiGenerated: boolean("ai_generated").notNull().default(true),
  sourceRecommendationId: varchar("source_recommendation_id").references(() => recommendations.id, { onDelete: "set null" }),
  sourceBriefId: varchar("source_brief_id").references(() => contentBriefs.id, { onDelete: "set null" }),
  assignedTo: varchar("assigned_to").references(() => users.id, { onDelete: "set null" }),
  dueDate: timestamp("due_date"),
  plannerTaskId: text("planner_task_id"), // Microsoft Planner task ID for sync
  plannerEtag: text("planner_etag"), // Graph optimistic-concurrency token for the Planner task
  plannerLastSyncedAt: timestamp("planner_last_synced_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const marketingTasksRelations = relations(marketingTasks, ({ one }) => ({
  plan: one(marketingPlans, {
    fields: [marketingTasks.planId],
    references: [marketingPlans.id],
  }),
  sourceRecommendation: one(recommendations, {
    fields: [marketingTasks.sourceRecommendationId],
    references: [recommendations.id],
  }),
  assignee: one(users, {
    fields: [marketingTasks.assignedTo],
    references: [users.id],
  }),
}));

export const insertMarketingTaskSchema = createInsertSchema(marketingTasks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type MarketingTask = typeof marketingTasks.$inferSelect;
export type InsertMarketingTask = z.infer<typeof insertMarketingTaskSchema>;

// Editorial Calendars — a planning container for a batch of content briefs.
// The Orbit parallel to the Cowork content-strategist's 30-day calendar.
// Consumes the messaging framework (voice/positioning), competitive gaps,
// personas, and SEO demand; the MPF stays the canonical positioning source.
export const CONTENT_BRIEF_FORMATS = [
  "blog_post",
  "linkedin_post",
  "x_post",
  "newsletter",
  "landing_page",
  "video_script",
  "case_study",
  "whitepaper",
  "ebook",
  "podcast_outline",
  "carousel",
  "webinar",
  "press_release",
  "linkedin_digest",
  "other",
] as const;
export type ContentBriefFormat = (typeof CONTENT_BRIEF_FORMATS)[number];

// Form categories — the four "lengths" a format-agnostic content brief can be
// produced in. The interview flow generates concept briefs tagged with the
// categories they suit, then the user picks concrete formats + counts per
// category when expanding the plan onto the calendar.
export const CONTENT_FORM_CATEGORIES = [
  "short_form",
  "mid_form",
  "long_form",
  "digital_interactive",
] as const;
export type ContentFormCategory = (typeof CONTENT_FORM_CATEGORIES)[number];

export const FORM_CATEGORY_FORMATS: Record<ContentFormCategory, ContentBriefFormat[]> = {
  short_form: ["linkedin_post", "x_post", "newsletter"],
  mid_form: ["blog_post", "press_release", "landing_page"],
  long_form: ["whitepaper", "ebook", "case_study", "linkedin_digest"],
  digital_interactive: ["webinar", "video_script", "podcast_outline"],
};

export function formCategoryForFormat(format: ContentBriefFormat): ContentFormCategory | null {
  for (const category of CONTENT_FORM_CATEGORIES) {
    if (FORM_CATEGORY_FORMATS[category].includes(format)) return category;
  }
  return null;
}

// AI voice/topic fit check stamped onto interview-generated briefs at creation
// time. Curation surfaces it to encourage rejecting off-voice or off-topic
// ideas before any content is produced.
export interface BriefFitAssessment {
  voiceFit: "strong" | "moderate" | "weak";
  topicFit: "strong" | "moderate" | "weak";
  recommendation: "keep" | "reject";
  rationale: string;
}

// Answers captured by the campaign content interview, frozen onto the campaign
// (like FoundingSignals) so brief regeneration never changes what was asked.
export interface CampaignInterviewProductMatch {
  productId: string | null; // null when the product isn't in Orbit yet
  productName: string;
  matchedFeatures: string[];
}
export interface CampaignInterview {
  capturedAt: string; // ISO timestamp
  themes: string[];
  newsItems: string[]; // product_release: the top 3-6 news items
  eventDate?: string | null;
  releaseDate?: string | null;
  rampUpStart?: string | null;
  amplificationEnd?: string | null; // always ≥ 30 days after releaseDate
  tempo?: string | null; // the cadence the user accepted, human-readable
  product?: CampaignInterviewProductMatch | null;
  notes?: string | null;
}

// Brief formats that target social channels. Drafting one of these the normal
// way still produces a document-style draft in the Content Library — it only
// becomes a real, schedulable social post via Repurpose. The UI uses this to
// signpost that path.
export const SOCIAL_BRIEF_FORMATS = ["linkedin_post", "x_post"] as const;
export function isSocialBriefFormat(format: string | null | undefined): boolean {
  return !!format && (SOCIAL_BRIEF_FORMATS as readonly string[]).includes(format);
}

export const FUNNEL_STAGES = ["awareness", "consideration", "decision"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const editorialCalendars = pgTable("editorial_calendars", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  periodStart: timestamp("period_start"),
  periodEnd: timestamp("period_end"),
  // Target funnel mix the calendar was generated against (defaults 40/35/25).
  funnelTargets: jsonb("funnel_targets").$type<{ awareness: number; consideration: number; decision: number }>(),
  // The focus/custom guidance the user supplied at generation time.
  focus: text("focus"),
  // Optional owning campaign: when a calendar is generated from a campaign, it
  // is the campaign's content plan. Forward-ref because campaigns is declared
  // later. NULL for standalone editorial calendars.
  campaignId: varchar("campaign_id").references((): AnyPgColumn => campaigns.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("active"), // active, archived
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertEditorialCalendarSchema = createInsertSchema(editorialCalendars).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type EditorialCalendar = typeof editorialCalendars.$inferSelect;
export type InsertEditorialCalendar = z.infer<typeof insertEditorialCalendarSchema>;

// Content Briefs — individual, schedulable content pieces within a calendar.
// Distinct from marketing_tasks (fiscal-year activity planning): a brief is a
// single content asset to produce, with demand evidence and a funnel stage.
export const contentBriefs = pgTable("content_briefs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  calendarId: varchar("calendar_id").notNull().references(() => editorialCalendars.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  format: text("format").notNull().default("blog_post"), // ContentBriefFormat
  targetKeyword: text("target_keyword"),
  // Evidence that people care (keyword volume, recurring question, gap, trend).
  demandSignal: text("demand_signal"),
  funnelStage: text("funnel_stage").notNull().default("awareness"), // FunnelStage
  // What makes our take different from the top existing pieces.
  differentiationAngle: text("differentiation_angle"),
  // The one specific reader this is for (free text), plus optional persona link.
  targetReader: text("target_reader"),
  targetPersonaId: varchar("target_persona_id").references(() => personas.id, { onDelete: "set null" }),
  cta: text("cta"),
  channels: text("channels").array(),
  estimatedHours: real("estimated_hours"),
  // Interview flow: the format-agnostic core idea. `format` stays the anchor
  // suggestion; formCategories list the form lengths the idea suits
  // (short_form / mid_form / long_form / digital_interactive).
  summary: text("summary"),
  formCategories: text("form_categories").array(),
  // AI voice/topic fit check captured at generation (see BriefFitAssessment).
  fitAssessment: jsonb("fit_assessment").$type<BriefFitAssessment>(),
  // Deliverable briefs expanded from a concept brief during interview planning
  // point back at the concept so the calendar can group them.
  derivedFromBriefId: varchar("derived_from_brief_id").references((): AnyPgColumn => contentBriefs.id, { onDelete: "set null" }),
  status: text("status").notNull().default("suggested"), // suggested, accepted, in_progress, drafted, scheduled, approved, published, removed
  aiGenerated: boolean("ai_generated").notNull().default(true),
  // Link to a produced draft once the copywriter runs (Phase 1, step 2).
  contentAssetId: varchar("content_asset_id").references(() => contentAssets.id, { onDelete: "set null" }),
  // Unified Marketing Calendar: a planned/scheduled date so a brief/draft can
  // sit on the calendar, plus lightweight campaign/theme/event assignment.
  // Forward-ref FKs because campaigns/solutionAreas/conferences are declared later.
  scheduledAt: timestamp("scheduled_at"),
  campaignId: varchar("campaign_id").references((): AnyPgColumn => campaigns.id, { onDelete: "set null" }),
  solutionAreaId: varchar("solution_area_id").references((): AnyPgColumn => solutionAreas.id, { onDelete: "set null" }),
  conferenceId: varchar("conference_id").references((): AnyPgColumn => conferences.id, { onDelete: "set null" }),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const editorialCalendarsRelations = relations(editorialCalendars, ({ many }) => ({
  briefs: many(contentBriefs),
}));

export const contentBriefsRelations = relations(contentBriefs, ({ one }) => ({
  calendar: one(editorialCalendars, {
    fields: [contentBriefs.calendarId],
    references: [editorialCalendars.id],
  }),
  persona: one(personas, {
    fields: [contentBriefs.targetPersonaId],
    references: [personas.id],
  }),
}));

export const insertContentBriefSchema = createInsertSchema(contentBriefs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type ContentBrief = typeof contentBriefs.$inferSelect;
export type InsertContentBrief = z.infer<typeof insertContentBriefSchema>;

// Content Optimizations — SEO + AEO (answer-engine) analysis for a piece of
// content. Produces search metadata, answer blocks / FAQ for AI answer
// engines, validated internal-link suggestions, and content-gap notes.
export interface OptimizationQA {
  question: string;
  answer: string;
}
export interface InternalLinkSuggestion {
  anchorText: string;
  targetAssetId: string;
  targetTitle: string;
  reason: string;
}

export const contentOptimizations = pgTable("content_optimizations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  contentAssetId: varchar("content_asset_id").references(() => contentAssets.id, { onDelete: "set null" }),
  sourceTitle: text("source_title").notNull(),
  // Search metadata (guardrailed: seoTitle ≤60c, metaDescription ≤155c).
  seoTitle: text("seo_title"),
  metaDescription: text("meta_description"),
  slug: text("slug"),
  targetKeyword: text("target_keyword"),
  keywords: text("keywords").array(),
  // Answer-engine optimization: concise Q&A blocks + FAQ schema source.
  answerBlocks: jsonb("answer_blocks").$type<OptimizationQA[]>(),
  faq: jsonb("faq").$type<OptimizationQA[]>(),
  // Internal links validated against the tenant's content_assets inventory.
  internalLinks: jsonb("internal_links").$type<InternalLinkSuggestion[]>(),
  contentGaps: jsonb("content_gaps").$type<string[]>(),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertContentOptimizationSchema = createInsertSchema(contentOptimizations).omit({
  id: true,
  createdAt: true,
});
export type ContentOptimization = typeof contentOptimizations.$inferSelect;
export type InsertContentOptimization = z.infer<typeof insertContentOptimizationSchema>;

// Marketing Performance Reports — the closed-loop "performance-analyst" output.
// Joins first-party click data (marketing_links/clicks) and GA4 conversions
// (analytics_daily) to content via campaigns, benchmarks against tenant
// history, and emits recommendations that feed back into the editorial calendar.
export interface MarketingPerformanceMetrics {
  totals: { posts: number; clicks: number; conversions: number; revenue: number; sessions: number };
  benchmark: { hasBaseline: boolean; clicksIndex?: number; conversionsIndex?: number } | null;
  byCampaign: Array<{
    campaignId: string | null;
    name: string;
    posts: number;
    clicks: number;
    conversions: number;
    revenue: number;
  }>;
  perContent: Array<{
    assetId: string;
    title: string;
    postsPublished: number;
    clicks: number;
    campaigns: string[];
  }>;
}

export const marketingPerformanceReports = pgTable("marketing_performance_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  summary: text("summary"),
  metrics: jsonb("metrics").$type<MarketingPerformanceMetrics>(),
  recommendationsEmitted: integer("recommendations_emitted").notNull().default(0),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertMarketingPerformanceReportSchema = createInsertSchema(marketingPerformanceReports).omit({
  id: true,
  createdAt: true,
});
export type MarketingPerformanceReport = typeof marketingPerformanceReports.$inferSelect;
export type InsertMarketingPerformanceReport = z.infer<typeof insertMarketingPerformanceReportSchema>;

// Per-category bucket mappings — Phase 2 enables routing each marketing
// activity category to its own Planner bucket. Backwards compatible with
// the single `plannerBucketId` on marketing_plans, which is used as the
// fallback when no per-category mapping exists.
export const marketingPlanBucketMappings = pgTable("marketing_plan_bucket_mappings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  planId: varchar("plan_id").notNull().references(() => marketingPlans.id, { onDelete: "cascade" }),
  activityCategory: text("activity_category").notNull(), // e.g. "events", "digital_marketing"
  bucketId: text("bucket_id").notNull(),
  bucketName: text("bucket_name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const insertMarketingPlanBucketMappingSchema = createInsertSchema(marketingPlanBucketMappings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type MarketingPlanBucketMapping = typeof marketingPlanBucketMappings.$inferSelect;
export type InsertMarketingPlanBucketMapping = z.infer<typeof insertMarketingPlanBucketMappingSchema>;

// Per-task sync log — auditing every Planner sync direction, fields touched,
// success/failure for the sync banner and debugging.
export const plannerTaskSyncLog = pgTable("planner_task_sync_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  planId: varchar("plan_id").notNull().references(() => marketingPlans.id, { onDelete: "cascade" }),
  taskId: varchar("task_id").references(() => marketingTasks.id, { onDelete: "set null" }),
  plannerTaskId: text("planner_task_id"),
  occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  direction: text("direction").notNull(), // pull | push | reconcile | webhook
  fields: jsonb("fields"), // { title?: any, status?: any, ... }
  success: boolean("success").notNull().default(true),
  errorMessage: text("error_message"),
});
export const insertPlannerTaskSyncLogSchema = createInsertSchema(plannerTaskSyncLog).omit({
  id: true,
  occurredAt: true,
});
export type PlannerTaskSyncLog = typeof plannerTaskSyncLog.$inferSelect;
export type InsertPlannerTaskSyncLog = z.infer<typeof insertPlannerTaskSyncLogSchema>;

// Microsoft Graph change-notification subscription per Planner-connected plan.
// Allows Planner→Orbit pushes via webhook with auto-renew.
export const plannerSubscriptions = pgTable("planner_subscriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  planId: varchar("plan_id").notNull().references(() => marketingPlans.id, { onDelete: "cascade" }),
  subscriptionId: text("subscription_id").notNull(),
  resource: text("resource").notNull(),
  clientState: text("client_state").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  lastRenewedAt: timestamp("last_renewed_at"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const insertPlannerSubscriptionSchema = createInsertSchema(plannerSubscriptions).omit({
  id: true,
  createdAt: true,
});
export type PlannerSubscription = typeof plannerSubscriptions.$inferSelect;
export type InsertPlannerSubscription = z.infer<typeof insertPlannerSubscriptionSchema>;

// Intelligence Briefings - AI-synthesized periodic intelligence reports
export const intelligenceBriefings = pgTable("intelligence_briefings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  status: text("status").notNull().default("draft"), // draft, published
  briefingData: jsonb("briefing_data"), // Full AI-synthesized briefing: narrative, signals, themes, action items
  signalCount: integer("signal_count").notNull().default(0),
  competitorCount: integer("competitor_count").notNull().default(0),
  podcastAudioUrl: text("podcast_audio_url"),
  podcastStatus: text("podcast_status").default("none"), // none, generating, ready, failed
  // Task #112: HubSpot auto-push tracking. Set after a successful push so the
  // UI can render a "Pushed to HubSpot" indicator. `hubspotPushResult` stores
  // counts/reason from the most recent push attempt for diagnostics.
  hubspotPushedAt: timestamp("hubspot_pushed_at"),
  hubspotPushResult: jsonb("hubspot_push_result"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertIntelligenceBriefingSchema = createInsertSchema(intelligenceBriefings).omit({
  id: true,
  createdAt: true,
});

export type IntelligenceBriefing = typeof intelligenceBriefings.$inferSelect;
export type InsertIntelligenceBriefing = z.infer<typeof insertIntelligenceBriefingSchema>;

// Briefing Subscriptions - per-user email subscription preferences for weekly briefings
export const briefingSubscriptions = pgTable("briefing_subscriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  enabled: boolean("enabled").notNull().default(true),
  frequency: text("frequency").notNull().default("weekly"), // weekly
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertBriefingSubscriptionSchema = createInsertSchema(briefingSubscriptions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type BriefingSubscription = typeof briefingSubscriptions.$inferSelect;
export type InsertBriefingSubscription = z.infer<typeof insertBriefingSubscriptionSchema>;

export const scheduledBriefingConfigs = pgTable("scheduled_briefing_configs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  enabled: boolean("enabled").notNull().default(false),
  frequency: text("frequency").notNull().default("weekly"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertScheduledBriefingConfigSchema = createInsertSchema(scheduledBriefingConfigs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type ScheduledBriefingConfig = typeof scheduledBriefingConfigs.$inferSelect;
export type InsertScheduledBriefingConfig = z.infer<typeof insertScheduledBriefingConfigSchema>;

// Scheduled Job Runs - Track background job execution history
export const scheduledJobRuns = pgTable("scheduled_job_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobType: text("job_type").notNull(), // websiteCrawl, socialMonitor, websiteMonitor, trialReminder, weeklyDigest
  tenantDomain: text("tenant_domain"), // null for system-wide jobs
  targetId: varchar("target_id"), // competitorId, companyProfileId, etc.
  targetName: text("target_name"), // Human-readable name
  status: text("status").notNull().default("pending"), // pending, running, completed, failed
  result: jsonb("result"), // Structured result data
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertScheduledJobRunSchema = createInsertSchema(scheduledJobRuns).omit({
  id: true,
  createdAt: true,
});

export type ScheduledJobRun = typeof scheduledJobRuns.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════════
// Saturn Marketing Integration
// Content library, brand library, campaigns, social accounts, post/email
// generation — all Enterprise-gated, tenant + market scoped.
// ═══════════════════════════════════════════════════════════════════════════

// Content Asset Categories — labels for organizing content assets
export const contentAssetCategories = pgTable("content_asset_categories", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertContentAssetCategorySchema = createInsertSchema(contentAssetCategories).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type ContentAssetCategory = typeof contentAssetCategories.$inferSelect;
export type InsertContentAssetCategory = z.infer<typeof insertContentAssetCategorySchema>;

// Marketing Product Tags — tag assets and campaigns by product/service
export const marketingProductTags = pgTable("marketing_product_tags", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertMarketingProductTagSchema = createInsertSchema(marketingProductTags).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type MarketingProductTag = typeof marketingProductTags.$inferSelect;
export type InsertMarketingProductTag = z.infer<typeof insertMarketingProductTagSchema>;

// Solution Areas — taxonomy for grouping assets and campaigns by theme
// (e.g., GTM, AI, Cloud Security). Cuts across products and asset types,
// so a campaign can target "AI" and pull workshops, case studies, apps,
// and models tagged to that area in a single sweep. Optional parentId
// supports hierarchy ("AI > Copilot Adoption") — the UI treats them as
// flat until someone needs sub-areas.
export const solutionAreas = pgTable("solution_areas", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  color: text("color"),
  icon: text("icon"),
  parentId: varchar("parent_id"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  tenantMarketSlugIdx: uniqueIndex("solution_areas_tenant_market_slug_idx")
    .on(t.tenantDomain, t.marketId, t.slug),
}));

export const insertSolutionAreaSchema = createInsertSchema(solutionAreas).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type SolutionArea = typeof solutionAreas.$inferSelect;
export type InsertSolutionArea = z.infer<typeof insertSolutionAreaSchema>;

// Content / brand asset types — first-class enum so campaign assembly can
// group "all workshops + case studies + apps + models" without inferring
// from user-defined category strings or file mime types.
export const CONTENT_ASSET_TYPES = [
  "workshop",
  "case_study",
  "app",
  "model",
  "blog_post",
  "whitepaper",
  "video",
  "logo",
  "font",
  "other",
] as const;
export type ContentAssetType = (typeof CONTENT_ASSET_TYPES)[number];

// Multi-format repurposing: Cowork-style metadata carried by each generated
// asset (post, carousel, or library snippet) so the user can see at a glance
// what it is, what it argues, and when to post it.
export interface RepurposeMeta {
  platform?: string | null; // e.g. "LinkedIn", "Blog", "Email", "Video"
  format?: string | null; // human label, e.g. "LinkedIn carousel"
  coreIdea?: string | null; // the one argument the asset makes
  cta?: string | null; // the call to action
  bestPostingWindow?: string | null; // when to publish, e.g. "Tue-Thu, 8-10am"
}

// A single slide of a repurposed LinkedIn carousel. A set is always 5 slides:
// a cover, three body slides, and a close. imageUrl is filled in once the
// branded graphic for the slide has been composited.
export interface CarouselSlide {
  index: number; // 1-based position in the set
  role: "cover" | "body" | "close";
  kicker?: string | null; // small label above the headline
  headline: string;
  supportingLines: string[];
  imageUrl?: string | null; // branded graphic for this slide
}

// Content Assets — marketing content items (copy, articles, slides, etc.)
export const contentAssets = pgTable("content_assets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description"),
  url: text("url"),
  content: text("content"),
  aiSummary: text("ai_summary"),
  leadImageUrl: text("lead_image_url"),
  subtitle: text("subtitle"),
  overview: text("overview"),
  postTags: text("post_tags"),
  extractionStatus: text("extraction_status").default("none"),
  fileUrl: text("file_url"),
  fileType: text("file_type"),
  fileSize: integer("file_size"),
  categoryId: varchar("category_id").references(() => contentAssetCategories.id, { onDelete: "set null" }),
  assetType: text("asset_type").notNull().default("other"),
  productIds: text("product_ids").array(),
  // When the asset went live / was published — the date reporting will window
  // traffic against (distinct from createdAt, when it was added to Orbit).
  assetDate: timestamp("asset_date"),
  // Whether the asset originated outside Orbit (e.g. an existing blog post or
  // webinar) vs. produced in Orbit. Drives campaign reporting attribution.
  isExternal: boolean("is_external").notNull().default(false),
  // When this asset has been posted to the Synozur website as a draft via the
  // website MCP, the returned post id/slug are recorded here — marks it pushed
  // and is the key for future get_post_performance traffic pulls.
  websitePostId: text("website_post_id"),
  websitePostSlug: text("website_post_slug"),
  // Lifecycle of the website draft as Orbit last left it: draft | scheduled |
  // published. websiteScheduledFor is set when a future publish is scheduled.
  websitePostStatus: text("website_post_status"),
  websiteScheduledFor: timestamp("website_scheduled_for"),
  // Blog-post website metadata saved from the structured editor panel so they
  // persist across sessions and pre-fill the website publish dialog.
  websiteExcerpt: text("website_excerpt"),
  websiteAuthorId: text("website_author_id"),
  websiteCategoryIds: text("website_category_ids").array(),
  websiteTagIds: text("website_tag_ids").array(),
  // WS3: headline SEO/AEO fields persisted back from the optimizer so they are
  // usable inline on the asset (deeper AEO data — answer blocks, FAQ, gaps —
  // continues to live in content_optimizations, keyed by contentAssetId).
  seoTitle: text("seo_title"),
  metaDescription: text("meta_description"),
  seoSlug: text("seo_slug"),
  seoKeywords: text("seo_keywords").array(),
  seoOptimizedAt: timestamp("seo_optimized_at"),
  // WS3: when this asset was produced by repurposing another asset, the source.
  repurposedFromAssetId: varchar("repurposed_from_asset_id").references((): AnyPgColumn => contentAssets.id, { onDelete: "set null" }),
  // The content brief whose spec motivated this asset, if any. The asset owns
  // this link (input → output points forward); contentBriefs.contentAssetId is
  // retained for back-compat until a later phase drops it. One brief may
  // motivate many assets (blog + social + email).
  sourceBriefId: varchar("source_brief_id").references((): AnyPgColumn => contentBriefs.id, { onDelete: "set null" }),
  // Multi-format repurposer: Cowork-style metadata (platform/format/core idea/
  // CTA/best posting window) for snippets produced by the batch repurposer.
  repurposeMeta: jsonb("repurpose_meta").$type<RepurposeMeta>(),
  tags: jsonb("tags").$type<{ seasons?: string[]; locations?: string[]; topics?: string[] }>(),
  status: text("status").notNull().default("active"),
  capturedViaExtension: boolean("captured_via_extension").notNull().default(false),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const contentAssetsRelations = relations(contentAssets, ({ one, many }) => ({
  category: one(contentAssetCategories, {
    fields: [contentAssets.categoryId],
    references: [contentAssetCategories.id],
  }),
  createdByUser: one(users, {
    fields: [contentAssets.createdBy],
    references: [users.id],
  }),
  sourceBrief: one(contentBriefs, {
    fields: [contentAssets.sourceBriefId],
    references: [contentBriefs.id],
  }),
  productTagLinks: many(contentAssetProductTags),
  solutionAreaLinks: many(contentAssetSolutionAreas),
  campaignAssets: many(campaignAssets),
}));

export const insertContentAssetSchema = createInsertSchema(contentAssets).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type ContentAsset = typeof contentAssets.$inferSelect;
export type InsertContentAsset = z.infer<typeof insertContentAssetSchema>;

export const suggestedContentAssets = pgTable("suggested_content_assets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  companyProfileId: varchar("company_profile_id").notNull().references(() => companyProfiles.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  title: text("title").notNull(),
  pageType: text("page_type"),
  reason: text("reason"),
  suggestedCategory: text("suggested_category"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type SuggestedContentAsset = typeof suggestedContentAssets.$inferSelect;

// Content Asset ↔ Product Tag join
export const contentAssetProductTags = pgTable("content_asset_product_tags", {
  assetId: varchar("asset_id").notNull().references(() => contentAssets.id, { onDelete: "cascade" }),
  tagId: varchar("tag_id").notNull().references(() => marketingProductTags.id, { onDelete: "cascade" }),
});

// Content Asset ↔ Solution Area join
export const contentAssetSolutionAreas = pgTable("content_asset_solution_areas", {
  assetId: varchar("asset_id").notNull().references(() => contentAssets.id, { onDelete: "cascade" }),
  solutionAreaId: varchar("solution_area_id").notNull().references(() => solutionAreas.id, { onDelete: "cascade" }),
}, (t) => ({
  pk: primaryKey({ columns: [t.assetId, t.solutionAreaId] }),
}));

// Brand Asset Categories
export const brandAssetCategories = pgTable("brand_asset_categories", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertBrandAssetCategorySchema = createInsertSchema(brandAssetCategories).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type BrandAssetCategory = typeof brandAssetCategories.$inferSelect;
export type InsertBrandAssetCategory = z.infer<typeof insertBrandAssetCategorySchema>;

// Brand Assets — approved logos, images, templates, brand-locked visuals
export const brandAssets = pgTable("brand_assets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  url: text("url"),
  fileUrl: text("file_url"),
  fileType: text("file_type"),
  fileSize: integer("file_size"),
  categoryId: varchar("category_id").references(() => brandAssetCategories.id, { onDelete: "set null" }),
  assetType: text("asset_type").notNull().default("other"),
  // For logo assets: which colour/orientation variant this file represents.
  // Values: color_horizontal | color_vertical | color_square |
  //         white_horizontal | white_vertical | white_square |
  //         black_horizontal | black_vertical | black_square
  logoVariant: text("logo_variant"),
  // For font assets: metadata used to load/preview the typeface
  fontFamily: text("font_family"),       // CSS font-family name, e.g. "Inter"
  fontWeight: text("font_weight"),       // 100–900 or named (regular, bold, …)
  fontStyle: text("font_style"),         // normal | italic | oblique
  fontUsage: text("font_usage"),         // heading | body | accent | display | mono
  productIds: text("product_ids").array(),
  tags: jsonb("tags").$type<{ seasons?: string[]; locations?: string[]; topics?: string[] }>(),
  sourceContentAssetId: varchar("source_content_asset_id").references(() => contentAssets.id, { onDelete: "set null" }),
  status: text("status").notNull().default("active"),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const brandAssetsRelations = relations(brandAssets, ({ one, many }) => ({
  category: one(brandAssetCategories, {
    fields: [brandAssets.categoryId],
    references: [brandAssetCategories.id],
  }),
  createdByUser: one(users, {
    fields: [brandAssets.createdBy],
    references: [users.id],
  }),
  productTagLinks: many(brandAssetProductTags),
  solutionAreaLinks: many(brandAssetSolutionAreas),
}));

export const insertBrandAssetSchema = createInsertSchema(brandAssets).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type BrandAsset = typeof brandAssets.$inferSelect;
export type InsertBrandAsset = z.infer<typeof insertBrandAssetSchema>;

// Brand Asset ↔ Product Tag join
export const brandAssetProductTags = pgTable("brand_asset_product_tags", {
  assetId: varchar("asset_id").notNull().references(() => brandAssets.id, { onDelete: "cascade" }),
  tagId: varchar("tag_id").notNull().references(() => marketingProductTags.id, { onDelete: "cascade" }),
});

// Brand Asset ↔ Solution Area join
export const brandAssetSolutionAreas = pgTable("brand_asset_solution_areas", {
  assetId: varchar("asset_id").notNull().references(() => brandAssets.id, { onDelete: "cascade" }),
  solutionAreaId: varchar("solution_area_id").notNull().references(() => solutionAreas.id, { onDelete: "cascade" }),
}, (t) => ({
  pk: primaryKey({ columns: [t.assetId, t.solutionAreaId] }),
}));

// Tenant Fonts — tenant-wide custom typefaces (heading / body / accent defaults)
export const tenantFonts = pgTable("tenant_fonts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  name: text("name").notNull(),           // Display name, e.g. "Brand Heading"
  fontFamily: text("font_family"),         // CSS font-family value
  fontWeight: text("font_weight"),         // 400, 700, etc.
  fontStyle: text("font_style"),           // normal | italic
  fontUsage: text("font_usage").notNull(), // heading | body | accent | display | mono
  fileUrl: text("file_url").notNull(),
  fileType: text("file_type"),             // font/ttf, font/otf, font/woff2, etc.
  fileSize: integer("file_size"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertTenantFontSchema = createInsertSchema(tenantFonts).omit({
  id: true, createdAt: true,
});
export type TenantFont = typeof tenantFonts.$inferSelect;
export type InsertTenantFont = z.infer<typeof insertTenantFontSchema>;

// Social Accounts — connected social media accounts for publishing
export const socialAccounts = pgTable("social_accounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  platform: text("platform").notNull(), // linkedin, twitter, instagram, facebook
  accountName: text("account_name").notNull(), // Display name / handle
  accountId: text("account_id"), // Platform-specific ID
  profileUrl: text("profile_url"),
  notes: text("notes"),
  status: text("status").notNull().default("active"), // active, inactive
  // Direct publishing (Task #97) — encrypted OAuth tokens stored as ciphertext
  // blobs from server/utils/encryption.ts. authorMode/authorUrn capture the
  // LinkedIn (or other-platform) identity we will publish as.
  encryptedAccessToken: text("encrypted_access_token"),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  tokenExpiresAt: timestamp("token_expires_at"),
  tokenScope: text("token_scope"),
  authorMode: text("author_mode"), // 'person' | 'organization'
  authorUrn: text("author_urn"),   // e.g. urn:li:person:xxx or urn:li:organization:xxx
  // Available author identities the user can publish as (e.g. their personal
  // URN plus any organizations they administer on LinkedIn). Used by the
  // author-picker UI in social-accounts.tsx.
  availableAuthors: jsonb("available_authors").$type<Array<{
    mode: "person" | "organization";
    urn: string;
    name: string;
    vanityName?: string | null;
  }>>(),
  connectedAt: timestamp("connected_at"),
  connectedBy: varchar("connected_by").references(() => users.id, { onDelete: "set null" }),
  lastPublishError: text("last_publish_error"),
  // When true the auto-publish worker skips all posts on this account.
  // Lets users pause a runaway account without disconnecting it.
  publishingPaused: boolean("publishing_paused").notNull().default(false),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSocialAccountSchema = createInsertSchema(socialAccounts).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type SocialAccount = typeof socialAccounts.$inferSelect;
export type InsertSocialAccount = z.infer<typeof insertSocialAccountSchema>;

// ─── Tenant-Owned Platform OAuth Credentials (DEPRECATED) ────────────────────
// DEPRECATED: the per-tenant "bring your own OAuth app" model has been retired.
// Expecting every tenant to register and get review-approval for their own X /
// Facebook / Instagram app is a SaaS antipattern that doesn't happen in
// practice. Social platforms now use a single Synozur-owned OAuth app each (see
// `globalPlatformCredentials` below; LinkedIn uses its own shared app via env
// vars). This table and constant are retained only so existing rows/migrations
// don't break — nothing reads or writes them anymore.
export const PLATFORM_CREDENTIAL_PLATFORMS = [
  "twitter",
  "facebook",
  "instagram",
] as const;
export type PlatformCredentialPlatform = (typeof PLATFORM_CREDENTIAL_PLATFORMS)[number];

export const tenantPlatformCredentials = pgTable("tenant_platform_credentials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  platform: text("platform").notNull(),
  // Encrypted ciphertext blobs. The clientId is encrypted too — it's not
  // strictly secret but treating both alike keeps the ciphertext schema
  // uniform and prevents accidental log leakage of the client_id.
  encryptedClientId: text("encrypted_client_id").notNull(),
  encryptedClientSecret: text("encrypted_client_secret"),
  // Free-form notes the admin can leave for their team (e.g., "Production
  // app — review approved 2026-01"). Never sent to the OAuth provider.
  notes: text("notes"),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  tenantPlatformUnique: uniqueIndex("tenant_platform_credentials_tenant_platform_idx")
    .on(table.tenantDomain, table.platform),
}));

export const tenantPlatformCredentialsRelations = relations(tenantPlatformCredentials, ({ one }) => ({
  createdByUser: one(users, {
    fields: [tenantPlatformCredentials.createdBy],
    references: [users.id],
  }),
}));

export const insertTenantPlatformCredentialSchema = createInsertSchema(tenantPlatformCredentials).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type TenantPlatformCredential = typeof tenantPlatformCredentials.$inferSelect;
export type InsertTenantPlatformCredential = z.infer<typeof insertTenantPlatformCredentialSchema>;

// ─── Global (platform-wide) social OAuth credentials ─────────────────────────
// Synozur owns ONE OAuth app per social platform (the Buffer/Hootsuite model):
// every tenant connects one-click from the Social Accounts page and never
// registers their own app. These credentials are managed by a Global Admin in
// the UI (Admin → Platform Credentials) and stored encrypted at rest — NOT in
// per-tenant rows and NOT in environment variables.
//
// Platforms:
//   - "twitter"  → X / Twitter OAuth 2.0 app (client_id, optional client_secret)
//   - "facebook" → Meta app; ALSO powers Instagram (Instagram rides on the same
//                  Meta app, so there is no separate "instagram" row — the
//                  Instagram publisher resolves the "facebook" credentials).
// LinkedIn is not stored here: it resolves from the existing shared Synozur app
// (LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET) and its own one-click flow.
export const GLOBAL_CREDENTIAL_PLATFORMS = [
  "twitter",
  "facebook",
] as const;
export type GlobalCredentialPlatform = (typeof GLOBAL_CREDENTIAL_PLATFORMS)[number];

export const globalPlatformCredentials = pgTable("global_platform_credentials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Unique per platform — this is a singleton-per-platform table (no tenant).
  platform: text("platform").notNull().unique(),
  // Encrypted ciphertext blobs (same scheme as tenant_platform_credentials).
  encryptedClientId: text("encrypted_client_id").notNull(),
  encryptedClientSecret: text("encrypted_client_secret"),
  notes: text("notes"),
  // Safety switch. Posting scopes on Meta/X require platform app review, so
  // direct publishing stays OFF until the shared app is approved. A Global
  // Admin flips this on from the UI — no env var, no redeploy.
  directPublishEnabled: boolean("direct_publish_enabled").notNull().default(false),
  updatedBy: varchar("updated_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertGlobalPlatformCredentialSchema = createInsertSchema(globalPlatformCredentials).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type GlobalPlatformCredential = typeof globalPlatformCredentials.$inferSelect;
export type InsertGlobalPlatformCredential = z.infer<typeof insertGlobalPlatformCredentialSchema>;

// ─── Account Voice Profiles ──────────────────────────────────────────────────
// Per-social-account personalization layer. Drives AI rewrites and direct-
// composed posts so content reads in the right voice for each account
// (1st vs 3rd person, tone, hashtag/emoji policy, sample snippets, defaults
// for ICP persona and grounding-doc messaging frameworks).
//
// One row per social_account. The polymorphic `defaultFrameworkRefs` is an
// ordered list of references to messaging-framework-like sources:
//   - { kind: 'long_form', id }    → longFormRecommendations (type='messaging_framework')
//   - { kind: 'grounding', id }    → groundingDocuments where 'marketing_content' ∈ contexts
//   - { kind: 'global', id }       → globalGroundingDocuments (brand_voice/marketing_guidelines)
// We don't FK these because they span three tables; resolution + permission
// checks happen at read time.

export const VOICE_PERSON_OPTIONS = ["first", "third"] as const;
export type VoicePerson = (typeof VOICE_PERSON_OPTIONS)[number];

export const VOICE_AUTHOR_PERSPECTIVES = ["individual", "brand"] as const;
export type VoiceAuthorPerspective = (typeof VOICE_AUTHOR_PERSPECTIVES)[number];

export const VOICE_EMOJI_POLICIES = ["none", "sparing", "liberal"] as const;
export type VoiceEmojiPolicy = (typeof VOICE_EMOJI_POLICIES)[number];

export const VOICE_HASHTAG_POLICIES = ["none", "minimal", "standard", "heavy"] as const;
export type VoiceHashtagPolicy = (typeof VOICE_HASHTAG_POLICIES)[number];

export const VOICE_FRAMEWORK_REF_KINDS = ["long_form", "grounding", "global"] as const;
export type VoiceFrameworkRefKind = (typeof VOICE_FRAMEWORK_REF_KINDS)[number];

export interface VoiceFrameworkRef {
  kind: VoiceFrameworkRefKind;
  id: string;
}

// Tone vector: every dimension 0..1. Treated as guidance, not a hard control.
export interface VoiceToneAttributes {
  formal?: number;
  playful?: number;
  technical?: number;
  warm?: number;
  bold?: number;
}

// Few-shot exemplars the rewrite prompt shows the model.
export interface VoiceSampleSnippet {
  label?: string;
  content: string;
}

// Compact snapshot persisted onto generatedPosts at schedule/publish time so
// later edits to a profile don't retroactively change what shipped.
export interface VoiceProfileSnapshot {
  profileId: string;
  capturedAt: string; // ISO
  person: VoicePerson;
  authorPerspective: VoiceAuthorPerspective;
  toneAttributes?: VoiceToneAttributes | null;
  styleGuidance?: string | null;
  soundLikeMeInstructions?: string | null;
  forbiddenPhrases?: string[] | null;
  preferredPhrases?: string[] | null;
  emojiPolicy: VoiceEmojiPolicy;
  hashtagPolicy: VoiceHashtagPolicy;
  maxLength?: number | null;
  defaultPersonaId?: string | null;
  defaultFrameworkRefs?: VoiceFrameworkRef[] | null;
}

export const socialAccountVoiceProfiles = pgTable("social_account_voice_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Nullable for per-seller "personal" outbound voice profiles (sales outreach),
  // which have an ownerUserId instead. Postgres UNIQUE ignores NULLs, so the
  // one-profile-per-social-account guarantee still holds for real accounts.
  socialAccountId: varchar("social_account_id")
    .references(() => socialAccounts.id, { onDelete: "cascade" })
    .unique(),
  // Set for a seller's personal outbound voice (extracted from their Sent Items).
  ownerUserId: varchar("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  // Voice fundamentals
  person: text("person").notNull().default("first"), // 'first' | 'third'
  authorPerspective: text("author_perspective").notNull().default("individual"), // 'individual' | 'brand'
  // Tone + style
  toneAttributes: jsonb("tone_attributes").$type<VoiceToneAttributes>(),
  styleGuidance: text("style_guidance"),
  soundLikeMeInstructions: text("sound_like_me_instructions"),
  forbiddenPhrases: text("forbidden_phrases").array(),
  preferredPhrases: text("preferred_phrases").array(),
  // Policies
  emojiPolicy: text("emoji_policy").notNull().default("sparing"),
  hashtagPolicy: text("hashtag_policy").notNull().default("standard"),
  maxLength: integer("max_length"),
  // Few-shot exemplars
  sampleSnippets: jsonb("sample_snippets").$type<VoiceSampleSnippet[]>().default([]),
  // Default targeting for rewrites (always optional at the call-site)
  defaultPersonaId: varchar("default_persona_id").references(() => personas.id, { onDelete: "set null" }),
  defaultFrameworkRefs: jsonb("default_framework_refs").$type<VoiceFrameworkRef[]>().default([]),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  // At most one personal (no social account) voice profile per seller. The
  // existing UNIQUE(social_account_id) ignores NULLs, so this partial index
  // enforces the "one personal voice per seller" guarantee.
  onePersonalVoicePerUser: uniqueIndex("voice_profiles_personal_owner_idx")
    .on(table.ownerUserId)
    .where(sql`social_account_id IS NULL AND owner_user_id IS NOT NULL`),
}));

export const socialAccountVoiceProfilesRelations = relations(socialAccountVoiceProfiles, ({ one }) => ({
  socialAccount: one(socialAccounts, {
    fields: [socialAccountVoiceProfiles.socialAccountId],
    references: [socialAccounts.id],
  }),
  defaultPersona: one(personas, {
    fields: [socialAccountVoiceProfiles.defaultPersonaId],
    references: [personas.id],
  }),
  createdByUser: one(users, {
    fields: [socialAccountVoiceProfiles.createdBy],
    references: [users.id],
  }),
}));

export const insertSocialAccountVoiceProfileSchema = createInsertSchema(socialAccountVoiceProfiles).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type SocialAccountVoiceProfile = typeof socialAccountVoiceProfiles.$inferSelect;
export type InsertSocialAccountVoiceProfile = z.infer<typeof insertSocialAccountVoiceProfileSchema>;

// Categories of globalGroundingDocuments that count as messaging-framework
// grounding sources for the voice/rewrite picker. Kept here so frontend and
// backend stay in sync.
export const MESSAGING_FRAMEWORK_GLOBAL_CATEGORIES = [
  "brand_voice",
  "marketing_guidelines",
] as const;

// Campaign types — the intent that anchors a campaign. Drives brief generation
// grounding and the recommended asset mix. Kept here so frontend and backend
// stay in sync. "event" campaigns subsume the conference-promotion flow.
// "product_release" campaigns anchor to a release date with a ramp-up window
// before it and an amplification window (≥30 days) after it.
export const CAMPAIGN_TYPES = ["theme", "event", "offering", "product_release"] as const;
export type CampaignType = (typeof CAMPAIGN_TYPES)[number];

// Frozen "founding signals" snapshot captured onto a campaign at planning time:
// the news stories + intelligence action items that informed it. Mirrors the
// VoiceProfileSnapshot pattern (a snapshot, not FKs) so later briefing
// regeneration never changes what a campaign was founded on. Display-only, and
// surfaced to the copywriter as supporting facts it may cite.
export interface FoundingSignalNews {
  title: string;
  source: string;
  url: string;
  publishedAt: string; // ISO date, or "" when unknown (e.g. scanned headlines)
  description: string;
}
export interface FoundingSignalActionItem {
  title: string;
  description: string;
  urgency: string; // immediate | this_week | this_month | watch
  category?: string;
}
export interface FoundingSignals {
  capturedAt: string; // ISO timestamp of capture
  origin: "ideation" | "briefing"; // how the campaign was founded
  briefingAsOf?: string | null; // the intelligence briefing this drew from
  newsArticles: FoundingSignalNews[];
  actionItems: FoundingSignalActionItem[];
  ideaSignals?: string[]; // free-text signal citations from an adopted idea
}

// Campaigns — the orchestrating umbrella for a coordinated push: intent
// (theme/event/offering) + audience + timeline, under which content briefs,
// assets, emails, and social posts are produced and rolled up.
export const campaigns = pgTable("campaigns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").notNull().default("draft"), // draft, active, completed, archived, deleted
  // Intent: what kind of push this is. Anchors brief generation + asset mix.
  campaignType: text("campaign_type").notNull().default("theme"), // CampaignType
  // The strategic objective in the user's words (what we're promoting + why).
  objective: text("objective"),
  // The measurable goal (e.g. "200 webinar registrations").
  goal: text("goal"),
  // ICP personas this campaign targets (FK ids into personas; array, no cascade).
  audiencePersonaIds: text("audience_persona_ids").array(),
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  numberOfDays: integer("number_of_days"),
  includeSaturday: boolean("include_saturday").notNull().default(false),
  includeSunday: boolean("include_sunday").notNull().default(false),
  productIds: text("product_ids").array(),
  alwaysHashtags: jsonb("always_hashtags").$type<string[]>().default([]),
  // Frozen news + intelligence action items that founded this campaign (see
  // FoundingSignals). Captured at creation; never mutated by later briefings.
  foundingSignals: jsonb("founding_signals").$type<FoundingSignals>(),
  // Interview answers captured when the campaign was created through the
  // content interview flow (themes, release windows, tempo, news items).
  interview: jsonb("interview").$type<CampaignInterview>(),
  thematicBrief: text("thematic_brief"),
  thematicUrl: text("thematic_url"),
  // When true, post generation uses ONLY the campaign brief/content as source
  // material — market positioning, competitive intelligence, and founding-signal
  // news are excluded from the AI prompt. Use for content-specific campaigns
  // (e.g. promoting a blog post) where broad GTM context would dilute the message.
  briefOnlyMode: boolean("brief_only_mode").notNull().default(false),
  postGenerationJobId: varchar("post_generation_job_id").references(() => scheduledJobRuns.id, { onDelete: "set null" }),
  // Parent/child hierarchy: a mainline campaign can own child social campaigns.
  // NULL means standalone. On delete set null so archiving the parent does not
  // cascade-delete children.
  parentCampaignId: varchar("parent_campaign_id").references((): AnyPgColumn => campaigns.id, { onDelete: "set null" }),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const campaignsRelations = relations(campaigns, ({ one, many }) => ({
  createdByUser: one(users, {
    fields: [campaigns.createdBy],
    references: [users.id],
  }),
  parentCampaign: one(campaigns, {
    fields: [campaigns.parentCampaignId],
    references: [campaigns.id],
    relationName: "campaignChildren",
  }),
  childCampaigns: many(campaigns, { relationName: "campaignChildren" }),
  campaignAssets: many(campaignAssets),
  campaignSocialAccounts: many(campaignSocialAccounts),
  campaignSolutionAreas: many(campaignSolutionAreas),
  generatedPosts: many(generatedPosts),
}));

export const insertCampaignSchema = createInsertSchema(campaigns).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type Campaign = typeof campaigns.$inferSelect;
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;

// Campaign ↔ Content Asset join (with optional overrides)
export const campaignAssets = pgTable("campaign_assets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  assetId: varchar("asset_id").notNull().references(() => contentAssets.id, { onDelete: "cascade" }),
  overrideTitle: text("override_title"), // Optional per-campaign title override
  overrideContent: text("override_content"), // Optional per-campaign content override
  sortOrder: integer("sort_order").notNull().default(0),
  addedAt: timestamp("added_at").notNull().defaultNow(),
});

export const campaignAssetsRelations = relations(campaignAssets, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [campaignAssets.campaignId],
    references: [campaigns.id],
  }),
  asset: one(contentAssets, {
    fields: [campaignAssets.assetId],
    references: [contentAssets.id],
  }),
}));

export const insertCampaignAssetSchema = createInsertSchema(campaignAssets).omit({
  id: true, addedAt: true,
});
export type CampaignAsset = typeof campaignAssets.$inferSelect;
export type InsertCampaignAsset = z.infer<typeof insertCampaignAssetSchema>;

// Campaign ↔ Brand Asset (visual library) join
export const campaignBrandAssets = pgTable("campaign_brand_assets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  brandAssetId: varchar("brand_asset_id").notNull().references(() => brandAssets.id, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").notNull().default(0),
  addedAt: timestamp("added_at").notNull().defaultNow(),
});

export const campaignBrandAssetsRelations = relations(campaignBrandAssets, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [campaignBrandAssets.campaignId],
    references: [campaigns.id],
  }),
  brandAsset: one(brandAssets, {
    fields: [campaignBrandAssets.brandAssetId],
    references: [brandAssets.id],
  }),
}));

export const insertCampaignBrandAssetSchema = createInsertSchema(campaignBrandAssets).omit({
  id: true, addedAt: true,
});
export type CampaignBrandAsset = typeof campaignBrandAssets.$inferSelect;
export type InsertCampaignBrandAsset = z.infer<typeof insertCampaignBrandAssetSchema>;

// Campaign ↔ Social Account join
export const campaignSocialAccounts = pgTable("campaign_social_accounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  socialAccountId: varchar("social_account_id").notNull().references(() => socialAccounts.id, { onDelete: "cascade" }),
  // Task #97: when true, approved+scheduled posts on this account auto-publish via SocialPublisher
  autoPublish: boolean("auto_publish").notNull().default(false),
  addedAt: timestamp("added_at").notNull().defaultNow(),
});

export const campaignSocialAccountsRelations = relations(campaignSocialAccounts, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [campaignSocialAccounts.campaignId],
    references: [campaigns.id],
  }),
  socialAccount: one(socialAccounts, {
    fields: [campaignSocialAccounts.socialAccountId],
    references: [socialAccounts.id],
  }),
}));

export const insertCampaignSocialAccountSchema = createInsertSchema(campaignSocialAccounts).omit({
  id: true, addedAt: true,
});
export type CampaignSocialAccount = typeof campaignSocialAccounts.$inferSelect;
export type InsertCampaignSocialAccount = z.infer<typeof insertCampaignSocialAccountSchema>;

// Campaign ↔ Solution Area join
export const campaignSolutionAreas = pgTable("campaign_solution_areas", {
  campaignId: varchar("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  solutionAreaId: varchar("solution_area_id").notNull().references(() => solutionAreas.id, { onDelete: "cascade" }),
}, (t) => ({
  pk: primaryKey({ columns: [t.campaignId, t.solutionAreaId] }),
}));

// Generated Posts — AI-generated social posts per campaign × social account
// campaignId is nullable: standalone composer posts have no campaign and
// auto-publish purely on schedule + status='approved'.
export const generatedPosts = pgTable("generated_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
  socialAccountId: varchar("social_account_id").references(() => socialAccounts.id, { onDelete: "set null" }),
  tenantDomain: text("tenant_domain").notNull(),
  platform: text("platform").notNull(), // linkedin, twitter, instagram, facebook
  content: text("content").notNull(), // Generated post copy
  hashtags: jsonb("hashtags").$type<string[]>().default([]),
  imagePrompt: text("image_prompt"), // Suggested image generation prompt
  sourceUrl: text("source_url"),
  // FK back to the content asset this post was drafted from. Lets us
  // resolve the asset's lead image at CSV-export time even after manual
  // edits, and survive renames/URL changes that would break sourceUrl
  // lookups.
  sourceAssetId: varchar("source_asset_id").references(() => contentAssets.id, { onDelete: "set null" }),
  overrideImageUrl: text("override_image_url"),
  overrideBrandAssetId: varchar("override_brand_asset_id").references(() => brandAssets.id, { onDelete: "set null" }),
  variantGroup: text("variant_group"),
  // Multi-format repurposer: a single LinkedIn post vs. a 5-slide carousel.
  // postFormat distinguishes the two; carouselSlides holds the slide set (cover,
  // 3 body, close) with each slide's branded graphic URL once composited.
  postFormat: text("post_format"), // single | carousel
  carouselSlides: jsonb("carousel_slides").$type<CarouselSlide[]>(),
  repurposeMeta: jsonb("repurpose_meta").$type<RepurposeMeta>(),
  // Conference social promotion linkage (nullable: most posts aren't conference posts).
  // conferenceSessionId gives the 1:1 session→post relationship; conferenceImageId is
  // the matched graphic. postRole distinguishes anchor (overall presence) vs session posts.
  conferenceId: varchar("conference_id").references((): AnyPgColumn => conferences.id, { onDelete: "cascade" }),
  conferenceSessionId: varchar("conference_session_id").references((): AnyPgColumn => conferenceSessions.id, { onDelete: "cascade" }),
  conferenceImageId: varchar("conference_image_id").references((): AnyPgColumn => conferenceImages.id, { onDelete: "set null" }),
  postRole: text("post_role"), // anchor | session
  // Unified Marketing Calendar: optional theme (solution area) assignment.
  solutionAreaId: varchar("solution_area_id").references((): AnyPgColumn => solutionAreas.id, { onDelete: "set null" }),
  scheduledDate: timestamp("scheduled_date"),
  status: text("status").notNull().default("draft"), // draft, approved, exported, deleted, rejected, published, publish_failed
  editedContent: text("edited_content"), // User-edited version of the post
  generationJobId: varchar("generation_job_id").references(() => scheduledJobRuns.id, { onDelete: "set null" }),
  // Task #97: direct social publishing
  publishedAt: timestamp("published_at"),
  publishedUrl: text("published_url"),
  publishError: text("publish_error"),
  publishAttemptCount: integer("publish_attempt_count").notNull().default(0),
  publishNextAttemptAt: timestamp("publish_next_attempt_at"),
  // Per-post delivery mode override. null = follow campaign autoPublish setting
  // (or standalone auto); "csv" = reserved for CSV export only — the
  // auto-publish worker will never touch this post even if autoPublish is on.
  deliveryMode: text("delivery_mode"),
  // Voice profile applied at schedule/publish time. Snapshot (not FK) so
  // later edits to the voice profile don't retroactively change history.
  voiceProfileSnapshot: jsonb("voice_profile_snapshot").$type<VoiceProfileSnapshot>(),
  // Audit trail of AI rewrites: [{ at, by, prompt, model, frameworkRefs }, ...]
  rewriteLineage: jsonb("rewrite_lineage").$type<Array<{
    at: string;
    by?: string | null;
    prompt?: string | null;
    model?: string | null;
    personaId?: string | null;
    frameworkRefs?: VoiceFrameworkRef[] | null;
  }>>().default([]),
  // Post-level link URL + label editors can attach for Facebook, LinkedIn, X.
  linkUrl: text("link_url"),
  linkLabel: text("link_label"),
  // Brief-origin traceability: the content brief that triggered this post run.
  sourceBriefId: varchar("source_brief_id").references((): AnyPgColumn => contentBriefs.id, { onDelete: "set null" }),
  // Naturalistic posting delay: when false (default) the worker may add a
  // random 0–600 s jitter before publishing. Set true to publish at the exact
  // scheduled time (e.g. news announcements, blog launch posts).
  exactSchedule: boolean("exact_schedule").notNull().default(false),
  // Set by the worker when jitter is applied. Post is held until this time.
  // Null = not yet jittered (or jitter disabled / exact_schedule = true).
  publishNotBefore: timestamp("publish_not_before"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const generatedPostsRelations = relations(generatedPosts, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [generatedPosts.campaignId],
    references: [campaigns.id],
  }),
  socialAccount: one(socialAccounts, {
    fields: [generatedPosts.socialAccountId],
    references: [socialAccounts.id],
  }),
  sourceAsset: one(contentAssets, {
    fields: [generatedPosts.sourceAssetId],
    references: [contentAssets.id],
  }),
}));

export const insertGeneratedPostSchema = createInsertSchema(generatedPosts).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type GeneratedPost = typeof generatedPosts.$inferSelect;
export type InsertGeneratedPost = z.infer<typeof insertGeneratedPostSchema>;

// Generated Emails — AI-generated promotional emails per campaign
export const generatedEmails = pgTable("generated_emails", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  platform: text("platform").notNull().default("outlook"),
  tone: text("tone").notNull().default("professional"),
  callToAction: text("call_to_action"),
  recipientContext: text("recipient_context"),
  subject: text("subject").notNull(),
  previewText: text("preview_text"),
  htmlBody: text("html_body").notNull(),
  textBody: text("text_body"),
  subjectLineSuggestions: text("subject_line_suggestions").array(),
  coachingTips: text("coaching_tips").array(),
  label: text("label"),
  status: text("status").notNull().default("draft"), // draft, approved, sent
  // Unified Marketing Calendar: planned/scheduled date + theme/event assignment.
  scheduledAt: timestamp("scheduled_at"),
  solutionAreaId: varchar("solution_area_id").references((): AnyPgColumn => solutionAreas.id, { onDelete: "set null" }),
  conferenceId: varchar("conference_id").references((): AnyPgColumn => conferences.id, { onDelete: "set null" }),
  sentAt: timestamp("sent_at"),
  sourceAssetIds: text("source_asset_ids").array(),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const generatedEmailsRelations = relations(generatedEmails, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [generatedEmails.campaignId],
    references: [campaigns.id],
  }),
  market: one(markets, {
    fields: [generatedEmails.marketId],
    references: [markets.id],
  }),
  createdByUser: one(users, {
    fields: [generatedEmails.createdBy],
    references: [users.id],
  }),
}));

export const insertGeneratedEmailSchema = createInsertSchema(generatedEmails).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type GeneratedEmail = typeof generatedEmails.$inferSelect;
export type InsertGeneratedEmail = z.infer<typeof insertGeneratedEmailSchema>;
export type InsertScheduledJobRun = z.infer<typeof insertScheduledJobRunSchema>;

// ---------------------------------------------------------------------------
// Conference Social Promotion
//
// Drives coordinated social promotion for a single conference: 1-2 anchor posts
// for overall presence plus one post per delivered session, each with a matched
// 1:1 graphic. Conference images live in their own dedicated space (not the main
// brand library) so they never clutter it, and the whole conference can be
// archived with one click after the event. The actual posts reuse the existing
// generatedPosts table (via conferenceId/conferenceSessionId) so they flow
// through the same scheduling, calendar, and publishing machinery.
// ---------------------------------------------------------------------------

export const CONFERENCE_IMAGE_SOURCES = ["ai_generated", "template_composite", "uploaded", "logo_composite"] as const;
export type ConferenceImageSource = (typeof CONFERENCE_IMAGE_SOURCES)[number];

export const CONFERENCE_IMAGE_ROLES = ["anchor", "session"] as const;
export type ConferenceImageRole = (typeof CONFERENCE_IMAGE_ROLES)[number];

// Optional categorisation of a session. The subsystem is presented as "Event
// Promotion" in the UI (it's used for conferences, webinars, receptions, etc.).
export const CONFERENCE_SESSION_TYPES = ["BREAKOUT", "WORKSHOP", "KEYNOTE", "MEETUP"] as const;
export type ConferenceSessionType = (typeof CONFERENCE_SESSION_TYPES)[number];

// A session speaker. isStaff flags our own people (not all speakers are staff).
export interface ConferenceSpeaker {
  name: string;
  isStaff: boolean;
}

export const conferences = pgTable("conferences", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  // Optional parent campaign: an "event" campaign can own a conference, so its
  // promotion posts roll up into the campaign's master view. Forward-ref FK
  // because campaigns is declared later. NULL for standalone conferences.
  campaignId: varchar("campaign_id").references((): AnyPgColumn => campaigns.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  location: text("location"),
  website: text("website"),
  eventHashtag: text("event_hashtag"), // official conference hashtag, e.g. "#MSIgnite"
  // Conference dates (when the event runs)
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  // Promotion window + cadence (the "time range" and "posts per day" the user configures)
  promoStartDate: timestamp("promo_start_date"),
  promoEndDate: timestamp("promo_end_date"),
  postsPerDay: integer("posts_per_day").notNull().default(2),
  includeSaturday: boolean("include_saturday").notNull().default(false),
  includeSunday: boolean("include_sunday").notNull().default(false),
  // Number of anchor (overall presence) posts: typically 1-2
  anchorPostCount: integer("anchor_post_count").notNull().default(2),
  // How many copy variations to generate per post (2-3)
  variantsPerPost: integer("variants_per_post").notNull().default(3),
  // Theming/context fed to AI copy + image generation
  thematicBrief: text("thematic_brief"),
  // Optional registration offer woven into copy, e.g. "Save $200 with registration code SYNOZUR200".
  discountStatement: text("discount_statement"),
  alwaysHashtags: jsonb("always_hashtags").$type<string[]>().default([]),
  productIds: text("product_ids").array(),
  // Event media for hero image composition (logo_composite source)
  eventLogoFileUrl: text("event_logo_file_url"),  // uploaded event/conference logo
  eventLogoFileType: text("event_logo_file_type"),
  status: text("status").notNull().default("active"), // active, archived, deleted
  archivedAt: timestamp("archived_at"),
  postGenerationJobId: varchar("post_generation_job_id").references(() => scheduledJobRuns.id, { onDelete: "set null" }),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertConferenceSchema = createInsertSchema(conferences).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type Conference = typeof conferences.$inferSelect;
export type InsertConference = z.infer<typeof insertConferenceSchema>;

// One row per delivered session. Each session gets a 1:1 matched graphic
// (conferenceImages.sessionId) and a dedicated post (generatedPosts.conferenceSessionId).
export const conferenceSessions = pgTable("conference_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conferenceId: varchar("conference_id").notNull().references(() => conferences.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  title: text("title").notNull(),
  // Legacy single-speaker display string, kept in sync with `speakers` (joined names).
  speaker: text("speaker"),
  // Structured multi-speaker list; each may be flagged as our own staff.
  speakers: jsonb("speakers").$type<ConferenceSpeaker[]>().default([]),
  // Optional: BREAKOUT | WORKSHOP | KEYNOTE | MEETUP
  sessionType: text("session_type"),
  track: text("track"),
  room: text("room"),
  sessionStart: timestamp("session_start"),
  sessionEnd: timestamp("session_end"),
  abstract: text("abstract"),
  url: text("url"),
  sortOrder: integer("sort_order").notNull().default(0),
  status: text("status").notNull().default("active"), // active, deleted
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertConferenceSessionSchema = createInsertSchema(conferenceSessions).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type ConferenceSession = typeof conferenceSessions.$inferSelect;
export type InsertConferenceSession = z.infer<typeof insertConferenceSessionSchema>;

// Location/background photos uploaded for a conference; used by the
// logo_composite hero-image compositor as background layers.
export const conferenceBackgrounds = pgTable("conference_backgrounds", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conferenceId: varchar("conference_id").notNull().references(() => conferences.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  name: text("name"),
  fileUrl: text("file_url").notNull(),
  fileType: text("file_type"),
  fileSize: integer("file_size"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertConferenceBackgroundSchema = createInsertSchema(conferenceBackgrounds).omit({
  id: true, createdAt: true,
});
export type ConferenceBackground = typeof conferenceBackgrounds.$inferSelect;
export type InsertConferenceBackground = z.infer<typeof insertConferenceBackgroundSchema>;

// Dedicated image space for conference graphics. Kept separate from brandAssets
// so the main brand library stays uncluttered. sessionId is set for the 1:1
// session graphic; null for anchor images.
export const conferenceImages = pgTable("conference_images", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conferenceId: varchar("conference_id").notNull().references(() => conferences.id, { onDelete: "cascade" }),
  sessionId: varchar("session_id").references(() => conferenceSessions.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  role: text("role").notNull().default("session"), // anchor | session
  source: text("source").notNull().default("ai_generated"), // ai_generated | template_composite | uploaded | logo_composite
  name: text("name"),
  imagePrompt: text("image_prompt"), // used for ai_generated and as overlay seed
  templateAssetId: varchar("template_asset_id").references(() => brandAssets.id, { onDelete: "set null" }), // background for template_composite
  // For logo_composite: which background photo to use (null = brand-colour gradient)
  backgroundId: varchar("background_id").references(() => conferenceBackgrounds.id, { onDelete: "set null" }),
  fileUrl: text("file_url"), // object-storage path, e.g. /objects/...
  fileType: text("file_type"),
  fileSize: integer("file_size"),
  status: text("status").notNull().default("active"), // active, archived
  archivedAt: timestamp("archived_at"),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  // Enforce 1:1 — at most one image per session.
  sessionUnique: uniqueIndex("conference_images_session_unique").on(t.sessionId),
}));

export const insertConferenceImageSchema = createInsertSchema(conferenceImages).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type ConferenceImage = typeof conferenceImages.$inferSelect;
export type InsertConferenceImage = z.infer<typeof insertConferenceImageSchema>;

export const conferencesRelations = relations(conferences, ({ one, many }) => ({
  createdByUser: one(users, {
    fields: [conferences.createdBy],
    references: [users.id],
  }),
  sessions: many(conferenceSessions),
  images: many(conferenceImages),
  backgrounds: many(conferenceBackgrounds),
  posts: many(generatedPosts),
}));

export const conferenceSessionsRelations = relations(conferenceSessions, ({ one, many }) => ({
  conference: one(conferences, {
    fields: [conferenceSessions.conferenceId],
    references: [conferences.id],
  }),
  images: many(conferenceImages),
}));

export const conferenceBackgroundsRelations = relations(conferenceBackgrounds, ({ one }) => ({
  conference: one(conferences, {
    fields: [conferenceBackgrounds.conferenceId],
    references: [conferences.id],
  }),
}));

export const conferenceImagesRelations = relations(conferenceImages, ({ one }) => ({
  conference: one(conferences, {
    fields: [conferenceImages.conferenceId],
    references: [conferences.id],
  }),
  session: one(conferenceSessions, {
    fields: [conferenceImages.sessionId],
    references: [conferenceSessions.id],
  }),
  templateAsset: one(brandAssets, {
    fields: [conferenceImages.templateAssetId],
    references: [brandAssets.id],
  }),
  background: one(conferenceBackgrounds, {
    fields: [conferenceImages.backgroundId],
    references: [conferenceBackgrounds.id],
  }),
}));

// Marketing Links — UTM-tagged short links with click tracking. Slug is
// globally unique so the redirect handler can resolve a slug to a destination
// without ambiguity, but ownership is enforced through tenantDomain on every
// CRUD/read path.
export const marketingLinks = pgTable("marketing_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  campaignId: varchar("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
  slug: text("slug").notNull().unique(),
  destinationUrl: text("destination_url").notNull(),
  label: text("label"),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmContent: text("utm_content"),
  utmTerm: text("utm_term"),
  clickCount: integer("click_count").notNull().default(0),
  lastClickedAt: timestamp("last_clicked_at"),
  status: text("status").notNull().default("active"), // active | archived
  source: text("source").notNull().default("manual"), // manual | post-wrap | email-wrap
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const marketingLinksRelations = relations(marketingLinks, ({ one, many }) => ({
  campaign: one(campaigns, {
    fields: [marketingLinks.campaignId],
    references: [campaigns.id],
  }),
  market: one(markets, {
    fields: [marketingLinks.marketId],
    references: [markets.id],
  }),
  clicks: many(marketingLinkClicks),
}));

export const insertMarketingLinkSchema = createInsertSchema(marketingLinks).omit({
  id: true, createdAt: true, updatedAt: true, clickCount: true, lastClickedAt: true,
});
export type MarketingLink = typeof marketingLinks.$inferSelect;
export type InsertMarketingLink = z.infer<typeof insertMarketingLinkSchema>;

// Marketing Link Clicks — append-only log of redirect events. Bots are flagged
// rather than dropped so analytics can be re-aggregated if filtering rules
// change. Raw IPs are never stored; instead we hash with a daily-rotating salt
// to provide rough uniqueness while preserving privacy.
export const marketingLinkClicks = pgTable("marketing_link_clicks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  linkId: varchar("link_id").notNull().references(() => marketingLinks.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  clickedAt: timestamp("clicked_at").notNull().defaultNow(),
  referrer: text("referrer"),
  userAgent: text("user_agent"),
  ipHash: text("ip_hash"),
  isBot: boolean("is_bot").notNull().default(false),
});

export const marketingLinkClicksRelations = relations(marketingLinkClicks, ({ one }) => ({
  link: one(marketingLinks, {
    fields: [marketingLinkClicks.linkId],
    references: [marketingLinks.id],
  }),
}));

export type MarketingLinkClick = typeof marketingLinkClicks.$inferSelect;

export const supportTickets = pgTable("support_tickets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  ticketNumber: serial("ticket_number").notNull(),
  userId: varchar("user_id").notNull().references(() => users.id),
  tenantDomain: text("tenant_domain").notNull(),
  category: text("category").notNull().default("question"),
  priority: text("priority").notNull().default("medium"),
  status: text("status").notNull().default("open"),
  subject: text("subject").notNull(),
  description: text("description").notNull(),
  assignedTo: varchar("assigned_to").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const supportTicketReplies = pgTable("support_ticket_replies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  ticketId: varchar("ticket_id").notNull().references(() => supportTickets.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id),
  message: text("message").notNull(),
  isInternal: boolean("is_internal").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const supportTicketAttachments = pgTable("support_ticket_attachments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  ticketId: varchar("ticket_id").notNull().references(() => supportTickets.id, { onDelete: "cascade" }),
  replyId: varchar("reply_id").references(() => supportTicketReplies.id, { onDelete: "cascade" }),
  uploadedBy: varchar("uploaded_by").notNull().references(() => users.id),
  fileName: text("file_name").notNull(),
  fileSize: integer("file_size").notNull(),
  contentType: text("content_type").notNull(),
  objectPath: text("object_path").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const supportTicketsRelations = relations(supportTickets, ({ one, many }) => ({
  user: one(users, { fields: [supportTickets.userId], references: [users.id] }),
  assignedUser: one(users, { fields: [supportTickets.assignedTo], references: [users.id] }),
  replies: many(supportTicketReplies),
  attachments: many(supportTicketAttachments),
}));

export const supportTicketRepliesRelations = relations(supportTicketReplies, ({ one, many }) => ({
  ticket: one(supportTickets, { fields: [supportTicketReplies.ticketId], references: [supportTickets.id] }),
  user: one(users, { fields: [supportTicketReplies.userId], references: [users.id] }),
  attachments: many(supportTicketAttachments),
}));

export const supportTicketAttachmentsRelations = relations(supportTicketAttachments, ({ one }) => ({
  ticket: one(supportTickets, { fields: [supportTicketAttachments.ticketId], references: [supportTickets.id] }),
  reply: one(supportTicketReplies, { fields: [supportTicketAttachments.replyId], references: [supportTicketReplies.id] }),
  uploader: one(users, { fields: [supportTicketAttachments.uploadedBy], references: [users.id] }),
}));

export const insertSupportTicketSchema = createInsertSchema(supportTickets).omit({
  id: true, ticketNumber: true, createdAt: true, updatedAt: true,
});
export type SupportTicket = typeof supportTickets.$inferSelect;
export type InsertSupportTicket = z.infer<typeof insertSupportTicketSchema>;

export const insertSupportTicketReplySchema = createInsertSchema(supportTicketReplies).omit({
  id: true, createdAt: true,
});
export type SupportTicketReply = typeof supportTicketReplies.$inferSelect;
export type InsertSupportTicketReply = z.infer<typeof insertSupportTicketReplySchema>;

export const insertSupportTicketAttachmentSchema = createInsertSchema(supportTicketAttachments).omit({
  id: true, createdAt: true,
});
export type SupportTicketAttachment = typeof supportTicketAttachments.$inferSelect;
export type InsertSupportTicketAttachment = z.infer<typeof insertSupportTicketAttachmentSchema>;

export const TICKET_CATEGORIES = ["question", "bug", "feature_request", "feedback", "account", "billing", "other"] as const;
export const TICKET_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const TICKET_STATUSES = ["open", "in_progress", "waiting", "resolved", "closed"] as const;

// ═══════════════════════════════════════════════════════════════════════════
// Notification Centre
// Persistent in-app notifications for job completions, competitor changes,
// data freshness warnings, and other system events.
// ═══════════════════════════════════════════════════════════════════════════

export const notifications = pgTable("notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  type: text("type").notNull(), // "job_complete" | "job_failed" | "competitor_change" | "freshness_warning" | "trial"
  title: text("title").notNull(),
  message: text("message").notNull(),
  link: text("link"), // deep-link path, e.g. "/app/competitors/abc123"
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertNotificationSchema = createInsertSchema(notifications).omit({
  id: true,
  createdAt: true,
});

export type Notification = typeof notifications.$inferSelect;
export type InsertNotification = z.infer<typeof insertNotificationSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Personas & ICP Builder
// Structured buyer personas for audience-specific AI content generation.
// ═══════════════════════════════════════════════════════════════════════════

export const personas = pgTable("personas", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  role: text("role"),
  industry: text("industry"),
  companySize: text("company_size"),
  painPoints: text("pain_points").array(),
  goals: text("goals").array(),
  objections: text("objections").array(),
  preferredChannels: text("preferred_channels").array(),
  notes: text("notes"),
  isIcp: boolean("is_icp").notNull().default(false),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const personasRelations = relations(personas, ({ one }) => ({
  market: one(markets, {
    fields: [personas.marketId],
    references: [markets.id],
  }),
  createdByUser: one(users, {
    fields: [personas.createdBy],
    references: [users.id],
  }),
}));

export const insertPersonaSchema = createInsertSchema(personas).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type Persona = typeof personas.$inferSelect;
export type InsertPersona = z.infer<typeof insertPersonaSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Webhook integrations (Slack & Teams) — Task #71
// ═══════════════════════════════════════════════════════════════════════════

export const INTEGRATION_KINDS = ["slack", "teams"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export const WEBHOOK_EVENT_CATEGORIES = [
  "competitor_change",
  "briefing_ready",
  "weekly_digest",
  "job_failed",
  "seo_movement",
  "competitor_tone_shift",
  "comment_mention",
  "action_item_assigned",
] as const;
export type WebhookEventCategory = (typeof WEBHOOK_EVENT_CATEGORIES)[number];

export const integrationConfigs = pgTable("integration_configs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  encryptedWebhookUrl: text("encrypted_webhook_url").notNull(),
  webhookHostHint: text("webhook_host_hint"),
  eventCategories: text("event_categories").array().notNull().default(sql`ARRAY[]::text[]`),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at"),
  lastError: text("last_error"),
});

export const integrationConfigsRelations = relations(integrationConfigs, ({ one }) => ({
  createdByUser: one(users, {
    fields: [integrationConfigs.createdBy],
    references: [users.id],
  }),
}));

export const insertIntegrationConfigSchema = createInsertSchema(integrationConfigs).omit({
  id: true, createdAt: true, updatedAt: true, lastUsedAt: true, lastError: true,
});
export type IntegrationConfig = typeof integrationConfigs.$inferSelect;
export type InsertIntegrationConfig = z.infer<typeof insertIntegrationConfigSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// HubSpot CRM connections (Task #100) — per-tenant OAuth
// ═══════════════════════════════════════════════════════════════════════════

export const HUBSPOT_OAUTH_SCOPES = [
  "oauth",
  "crm.objects.companies.read",
  "crm.objects.companies.write",
  "crm.objects.deals.read",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.owners.read",
  // Marketing-email sync (Phase 1+): write engagement to contact timelines and
  // read/write subscription (consent) state. Adding these forces already-
  // connected tenants to re-authorize before sync can run — see the
  // re-consent banner. `hasHubspotEmailScopes()` gates sync paths so the rest
  // of the integration keeps working until a tenant re-consents.
  "timeline",
  "communication_preferences.read",
  "communication_preferences.read_write",
  // CRM Lists API (v3): required to fetch contact lists and their members.
  // Connections created before this scope was added will need to re-authorize;
  // `hasHubspotListScopes()` gates the browse-by-list path gracefully.
  "crm.lists.read",
  "crm.lists.write",
] as const;

// The subset of scopes required for the marketing-email sync layer. A
// connection authorized before these were added will be missing them; sync
// paths no-op until the tenant re-authorizes.
export const HUBSPOT_EMAIL_SYNC_SCOPES = [
  "communication_preferences.read",
  "communication_preferences.read_write",
  "timeline",
] as const;

// Per-tenant connection to the Synozur Insights website ("www") MCP server.
// Stores the MCP endpoint and an encrypted mcp.write key so Orbit can post
// blog drafts directly to the site. One row per tenant.
export const websiteConnections = pgTable("website_connections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull().unique(),
  endpoint: text("endpoint").notNull(),
  encryptedApiKey: text("encrypted_api_key").notNull(),
  defaultAuthorId: text("default_author_id"),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at"),
  lastError: text("last_error"),
});
export type WebsiteConnection = typeof websiteConnections.$inferSelect;

export const hubspotConnections = pgTable("hubspot_connections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull().unique(), // one connection per tenant
  hubspotPortalId: text("hubspot_portal_id"), // HubSpot Hub ID
  hubspotPortalName: text("hubspot_portal_name"),
  encryptedAccessToken: text("encrypted_access_token").notNull(),
  encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  scopes: text("scopes").array().notNull().default(sql`ARRAY[]::text[]`),
  autoPushEnabled: boolean("auto_push_enabled").notNull().default(false),
  // Marketing-email sync (Phase 1). When a recipient has no matching HubSpot
  // contact, auto-create one so engagement/consent can be tracked. Defaults
  // on; admins can opt out (e.g. tenants that don't want Orbit creating CRM
  // contacts). Independent of whether the connection has the email-sync scopes.
  autoCreateHubspotContacts: boolean("auto_create_hubspot_contacts").notNull().default(true),
  // Marketing-email sync (Phase 3). The HubSpot subscription type id that
  // marketing email maps to (single default "Marketing" type in v1). When an
  // unsubscribe is synced back to HubSpot it opts the contact out of this
  // subscription. Null ⇒ write-back is skipped (local suppression still
  // applies; the pre-send consent pull keeps HubSpot authoritative).
  defaultSubscriptionId: text("default_subscription_id"),
  defaultOwnerId: text("default_owner_id"), // HubSpot owner ID for pushed Tasks
  // Prospect-aware marketing suppression. When a send would reach an active
  // sales prospect, the UI warns the operator. This setting controls the
  // pre-selected action: "warn" (let the operator decide) or "always_exclude"
  // (exclude active prospects without prompting, but still surface the count).
  activeProspectSuppressionDefault: text("active_prospect_suppression_default").notNull().default("warn"),
  connectedByUserId: varchar("connected_by_user_id").references(() => users.id, { onDelete: "set null" }),
  connectedAt: timestamp("connected_at").notNull().defaultNow(),
  lastSyncAt: timestamp("last_sync_at"),
  lastSyncError: text("last_sync_error"),
  lastSyncStats: jsonb("last_sync_stats"), // { matched, enriched, dealsAggregated, suggestedCount }
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertHubspotConnectionSchema = createInsertSchema(hubspotConnections).omit({
  id: true, createdAt: true, updatedAt: true, connectedAt: true,
});
export type HubspotConnection = typeof hubspotConnections.$inferSelect;
export type InsertHubspotConnection = z.infer<typeof insertHubspotConnectionSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// SEO & Share-of-Voice Tracking
export const trackedKeywords = pgTable("tracked_keywords", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  keyword: text("keyword").notNull(),
  country: text("country").notNull().default("us"),
  locale: text("locale").notNull().default("en"),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  tenantMarketIdx: index("tracked_keywords_tenant_market_idx").on(table.tenantDomain, table.marketId),
}));

export const trackedKeywordsRelations = relations(trackedKeywords, ({ one, many }) => ({
  market: one(markets, {
    fields: [trackedKeywords.marketId],
    references: [markets.id],
  }),
  createdByUser: one(users, {
    fields: [trackedKeywords.createdBy],
    references: [users.id],
  }),
  metrics: many(seoMetrics),
}));

export const insertTrackedKeywordSchema = createInsertSchema(trackedKeywords).omit({
  id: true, createdAt: true,
});
export type TrackedKeyword = typeof trackedKeywords.$inferSelect;
export type InsertTrackedKeyword = z.infer<typeof insertTrackedKeywordSchema>;

export const seoMetrics = pgTable("seo_metrics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  keywordId: varchar("keyword_id").notNull().references(() => trackedKeywords.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(), // 'baseline' | 'competitor'
  entityId: varchar("entity_id"), // companyProfileId or competitorId; null only when the entity has been deleted
  entityName: text("entity_name").notNull(),
  entityDomain: text("entity_domain"),
  rank: integer("rank"),
  estimatedTraffic: integer("estimated_traffic").notNull().default(0),
  shareOfVoice: integer("share_of_voice").notNull().default(0),
  capturedAt: timestamp("captured_at").notNull().defaultNow(),
}, (table) => ({
  tenantMarketIdx: index("seo_metrics_tenant_market_idx").on(table.tenantDomain, table.marketId, table.capturedAt),
  keywordIdx: index("seo_metrics_keyword_idx").on(table.keywordId, table.capturedAt),
  entityIdx: index("seo_metrics_entity_idx").on(table.entityId, table.capturedAt),
}));

export const seoMetricsRelations = relations(seoMetrics, ({ one }) => ({
  keyword: one(trackedKeywords, {
    fields: [seoMetrics.keywordId],
    references: [trackedKeywords.id],
  }),
  market: one(markets, {
    fields: [seoMetrics.marketId],
    references: [markets.id],
  }),
}));

export const insertSeoMetricSchema = createInsertSchema(seoMetrics).omit({
  id: true, capturedAt: true,
});
export type SeoMetric = typeof seoMetrics.$inferSelect;
export type InsertSeoMetric = z.infer<typeof insertSeoMetricSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Direct social publishing & email campaign delivery — Task #97
// ═══════════════════════════════════════════════════════════════════════════

// Per-attempt log for SocialPublisher.publish() calls. We record every attempt
// (success or failure) so the UI can show "last 5 attempts" and operators can
// debug platform errors without grepping logs.
export const socialPublishAttempts = pgTable("social_publish_attempts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  postId: varchar("post_id").notNull().references(() => generatedPosts.id, { onDelete: "cascade" }),
  socialAccountId: varchar("social_account_id").references(() => socialAccounts.id, { onDelete: "set null" }),
  tenantDomain: text("tenant_domain").notNull(),
  platform: text("platform").notNull(),
  status: text("status").notNull(), // 'success' | 'error'
  publishedUrl: text("published_url"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  responsePayload: jsonb("response_payload"),
  attemptedAt: timestamp("attempted_at").notNull().defaultNow(),
  attemptedBy: varchar("attempted_by").references(() => users.id, { onDelete: "set null" }),
});

export const insertSocialPublishAttemptSchema = createInsertSchema(socialPublishAttempts).omit({
  id: true, attemptedAt: true,
});
export type SocialPublishAttempt = typeof socialPublishAttempts.$inferSelect;
export type InsertSocialPublishAttempt = z.infer<typeof insertSocialPublishAttemptSchema>;

// Email recipient lists — tenant-managed audiences for email campaigns.
// recipientCount is denormalized for fast UI rendering; it is recomputed
// whenever recipients are added/removed.
export const emailRecipientLists = pgTable("email_recipient_lists", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  recipientCount: integer("recipient_count").notNull().default(0),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertEmailRecipientListSchema = createInsertSchema(emailRecipientLists).omit({
  id: true, createdAt: true, updatedAt: true, recipientCount: true,
});
export type EmailRecipientList = typeof emailRecipientLists.$inferSelect;
export type InsertEmailRecipientList = z.infer<typeof insertEmailRecipientListSchema>;

export const emailRecipients = pgTable("email_recipients", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  listId: varchar("list_id").notNull().references(() => emailRecipientLists.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  email: text("email").notNull(),
  name: text("name"),
  status: text("status").notNull().default("active"), // active | unsubscribed | bounced | manual_remove
  // HubSpot contact link (Phase 1 marketing-email sync). Durable cache of the
  // resolved CRM contact so we don't re-search HubSpot on every send. Stays
  // null until resolved, and also when no contact exists and auto-create is
  // off — in that case hsSyncStatus is set to 'skipped' (hubspotContactId is
  // never a sentinel string).
  hubspotContactId: text("hubspot_contact_id"),
  hsSyncStatus: text("hs_sync_status"), // null | pending | resolved | skipped | error
  hsLastSyncedAt: timestamp("hs_last_synced_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  listEmailUniq: index("email_recipients_list_email_uniq").on(table.listId, table.email),
}));

export const insertEmailRecipientSchema = createInsertSchema(emailRecipients).omit({
  id: true, createdAt: true,
});
export type EmailRecipient = typeof emailRecipients.$inferSelect;
export type InsertEmailRecipient = z.infer<typeof insertEmailRecipientSchema>;

// Tenant-scoped suppression list — any address here is excluded from sends
// regardless of which list it appears on. Sources: explicit unsubscribe (via
// /u/:token), SendGrid bounce/spam events, manual operator add.
export const emailSuppressions = pgTable("email_suppressions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  email: text("email").notNull(),
  reason: text("reason").notNull(), // 'unsubscribe' | 'bounce' | 'spam' | 'manual' | 'invalid'
  source: text("source"),           // free-form: 'public_unsub' | 'sendgrid_event' | 'admin_ui'
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  tenantEmailUniq: index("email_suppressions_tenant_email_uniq").on(table.tenantDomain, table.email),
}));

export const insertEmailSuppressionSchema = createInsertSchema(emailSuppressions).omit({
  id: true, createdAt: true,
});
export type EmailSuppression = typeof emailSuppressions.$inferSelect;
export type InsertEmailSuppression = z.infer<typeof insertEmailSuppressionSchema>;

// Shared cross-system HubSpot contact ID cache. Keyed on (tenantDomain, email)
// with no FK to email_recipients (list-scoped) so both the sales-outreach
// path and the marketing-email path can upsert freely. Resolution priority:
//   1. prospects.hubspotContactId  (sales already looked this up)
//   2. hubspotContactIdCache        (this table — cross-system cache)
//   3. HubSpot search by email
//   4. auto-create (if enabled) → associates with company when possible
export const hubspotContactIdCache = pgTable("hubspot_contact_id_cache", {
  tenantDomain: text("tenant_domain").notNull(),
  email: text("email").notNull(),
  hubspotContactId: text("hubspot_contact_id").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.tenantDomain, table.email] }),
}));

export type HubspotContactIdCacheEntry = typeof hubspotContactIdCache.$inferSelect;

// Per-tenant verified sender identities used when dispatching email campaigns.
// Multiple identities may exist per tenant; exactly one can be marked default.
export const emailSenderIdentities = pgTable("email_sender_identities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  name: text("name").notNull(),           // display name, e.g. "Synozur Marketing"
  email: text("email").notNull(),         // must be verified in SendGrid
  replyToEmail: text("reply_to_email"),   // optional reply-to override
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const insertEmailSenderIdentitySchema = createInsertSchema(emailSenderIdentities).omit({ id: true, createdAt: true });
export type EmailSenderIdentity = typeof emailSenderIdentities.$inferSelect;
export type InsertEmailSenderIdentity = z.infer<typeof insertEmailSenderIdentitySchema>;

// One row per "Send" action — links a generatedEmail to the audience and
// records aggregate counters for the UI Sends tab.
export const emailSends = pgTable("email_sends", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  generatedEmailId: varchar("generated_email_id").notNull().references(() => generatedEmails.id, { onDelete: "cascade" }),
  listId: varchar("list_id").references(() => emailRecipientLists.id, { onDelete: "set null" }),
  testRecipient: text("test_recipient"), // when set, this was a "send to me" test send
  status: text("status").notNull().default("pending"), // pending | queued | sending | sent | failed | partial
  scheduledAt: timestamp("scheduled_at"), // when set, dispatch is deferred to the email-send worker
  // Per-send analytics toggles. The 1×1 open-tracking pixel is optional per
  // task spec — operators may want to disable it for privacy-conscious sends.
  // Click tracking is also togglable but defaults on so the link-redirect
  // wrapping continues to attribute conversions.
  trackOpens: boolean("track_opens").notNull().default(true),
  trackClicks: boolean("track_clicks").notNull().default(true),
  // When true, the server will suppress recipients who are active outreach
  // prospects (prospect status not 'replied' or 'dormant') before sending.
  excludeActiveProspects: boolean("exclude_active_prospects").notNull().default(false),
  recipientCount: integer("recipient_count").notNull().default(0),
  sentCount: integer("sent_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  bounceCount: integer("bounce_count").notNull().default(0),
  unsubscribeCount: integer("unsubscribe_count").notNull().default(0),
  spamCount: integer("spam_count").notNull().default(0),
  openCount: integer("open_count").notNull().default(0),
  clickCount: integer("click_count").notNull().default(0),
  deliveredCount: integer("delivered_count").notNull().default(0),
  senderIdentityId: varchar("sender_identity_id").references(() => emailSenderIdentities.id, { onDelete: "set null" }),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertEmailSendSchema = createInsertSchema(emailSends).omit({
  id: true, createdAt: true,
});
export type EmailSend = typeof emailSends.$inferSelect;
export type InsertEmailSend = z.infer<typeof insertEmailSendSchema>;

// Per-recipient row for a send — used for unsubscribe-token lookup and to
// aggregate SendGrid event webhook callbacks (delivered/bounced/etc).
export const emailSendRecipients = pgTable("email_send_recipients", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sendId: varchar("send_id").notNull().references(() => emailSends.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  email: text("email").notNull(),
  name: text("name"),
  unsubscribeToken: text("unsubscribe_token").notNull().unique(),
  status: text("status").notNull().default("queued"), // queued | sent | delivered | bounced | dropped | spam | unsubscribed | failed
  sgMessageId: text("sg_message_id"),
  errorMessage: text("error_message"),
  sentAt: timestamp("sent_at"),
  deliveredAt: timestamp("delivered_at"),
  bouncedAt: timestamp("bounced_at"),
  unsubscribedAt: timestamp("unsubscribed_at"),
  openedAt: timestamp("opened_at"),
  clickedAt: timestamp("clicked_at"),
  openCount: integer("open_count").notNull().default(0),
  clickCount: integer("click_count").notNull().default(0),
  // HubSpot sync state (Phase 1 marketing-email sync). hubspotContactId is the
  // resolved CRM contact this recipient maps to; hsSyncStatus tracks resolution
  // (and, in later phases, timeline-event push). Sync is best-effort and never
  // blocks the SendGrid send.
  hubspotContactId: text("hubspot_contact_id"),
  hsSyncStatus: text("hs_sync_status"), // null | pending | resolved | skipped | error
  hsLastEventSyncedAt: timestamp("hs_last_event_synced_at"),
  hsSyncError: text("hs_sync_error"),
  // Set when a recipient was intentionally suppressed before send (not a
  // bounce/unsubscribe). Values: "active_prospect" | "hubspot_optout" | others.
  suppressionReason: text("suppression_reason"),
}, (table) => ({
  sendEmailIdx: index("email_send_recipients_send_email_idx").on(table.sendId, table.email),
}));

export const insertEmailSendRecipientSchema = createInsertSchema(emailSendRecipients).omit({
  id: true,
});
export type EmailSendRecipient = typeof emailSendRecipients.$inferSelect;
export type InsertEmailSendRecipient = z.infer<typeof insertEmailSendRecipientSchema>;

// Marketing-delivery audit log — append-only record of who did what and when.
// Visible to admins; also useful for incident response and abuse triage.
export const marketingAuditLog = pgTable("marketing_audit_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id"),
  userId: varchar("user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(), // social_publish | social_oauth_connect | email_send | email_unsubscribe | email_bounce | rate_limited
  entityType: text("entity_type"),
  entityId: varchar("entity_id"),
  status: text("status").notNull().default("ok"), // ok | error | warning
  message: text("message"),
  details: jsonb("details"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  tenantCreatedIdx: index("marketing_audit_log_tenant_created_idx").on(table.tenantDomain, table.createdAt),
}));

export const insertMarketingAuditLogSchema = createInsertSchema(marketingAuditLog).omit({
  id: true, createdAt: true,
});
export type MarketingAuditLog = typeof marketingAuditLog.$inferSelect;
export type InsertMarketingAuditLog = z.infer<typeof insertMarketingAuditLogSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// OAuth 2.0 provider — Task #96 (Galaxy partner API)
// ═══════════════════════════════════════════════════════════════════════════

export const PARTNER_API_SCOPES = [
  "read:battlecards",
  "read:briefings",
  "read:personas",
  "read:roadmap",
  "read:content-library",
  "read:brand-library",
  "read:campaigns",
  "read:reports",
  "read:posts",
] as const;
export type PartnerApiScope = (typeof PARTNER_API_SCOPES)[number];

export const PARTNER_API_SCOPE_LABELS: Record<PartnerApiScope, string> = {
  "read:battlecards": "View your sales battlecards",
  "read:briefings": "View your intelligence briefings",
  "read:personas": "View your buyer personas",
  "read:roadmap": "View your product roadmap items",
  "read:content-library": "View your content library entries",
  "read:brand-library": "View your brand library assets",
  "read:campaigns": "View your marketing campaigns",
  "read:reports": "View your generated reports",
  "read:posts": "View your AI-generated social posts",
};

export const oauthClients = pgTable("oauth_clients", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  logoUrl: text("logo_url"),
  contactEmail: text("contact_email"),
  redirectUris: text("redirect_uris").array().notNull(),
  allowedScopes: text("allowed_scopes").array().notNull(),
  clientSecretHash: text("client_secret_hash"),
  status: text("status").notNull().default("active"),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const oauthAuthorizationCodes = pgTable("oauth_authorization_codes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  codeHash: text("code_hash").notNull().unique(),
  clientId: varchar("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id"),
  redirectUri: text("redirect_uri").notNull(),
  scopes: text("scopes").array().notNull(),
  codeChallenge: text("code_challenge").notNull(),
  codeChallengeMethod: text("code_challenge_method").notNull().default("S256"),
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const oauthAccessTokens = pgTable("oauth_access_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tokenHash: text("token_hash").notNull().unique(),
  clientId: varchar("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id"),
  scopes: text("scopes").array().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const oauthRefreshTokens = pgTable("oauth_refresh_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tokenHash: text("token_hash").notNull().unique(),
  accessTokenId: varchar("access_token_id"),
  clientId: varchar("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id"),
  scopes: text("scopes").array().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  rotatedToId: varchar("rotated_to_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const oauthApiAudit = pgTable("oauth_api_audit", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tokenId: varchar("token_id"),
  clientId: varchar("client_id"),
  userId: varchar("user_id"),
  tenantDomain: text("tenant_domain"),
  route: text("route").notNull(),
  method: text("method").notNull(),
  status: integer("status").notNull(),
  scope: text("scope"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index("oauth_api_audit_tenant_idx").on(table.tenantDomain, table.createdAt),
  clientIdx: index("oauth_api_audit_client_idx").on(table.clientId, table.createdAt),
}));

export const insertOauthClientSchema = createInsertSchema(oauthClients).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type OauthClient = typeof oauthClients.$inferSelect;
export type InsertOauthClient = z.infer<typeof insertOauthClientSchema>;
export type OauthAccessToken = typeof oauthAccessTokens.$inferSelect;
export type OauthRefreshToken = typeof oauthRefreshTokens.$inferSelect;
export type OauthAuthorizationCode = typeof oauthAuthorizationCodes.$inferSelect;
export type OauthApiAudit = typeof oauthApiAudit.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────
// Task #101 — Outcome Metrics, Orbit Score & ROI
// ─────────────────────────────────────────────────────────────────────────

// GA4 (and future provider) connections per tenant/market. Tokens are stored
// AES-256-GCM encrypted via server/utils/encryption.ts.
export const analyticsConnections = pgTable("analytics_connections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  provider: text("provider").notNull().default("ga4"), // ga4 only for now
  propertyId: text("property_id"), // GA4 property id ("properties/123456")
  propertyName: text("property_name"),
  accessTokenEnc: text("access_token_enc"),
  refreshTokenEnc: text("refresh_token_enc"),
  tokenExpiresAt: timestamp("token_expires_at"),
  scope: text("scope"),
  status: text("status").notNull().default("connected"), // connected | error | suspended | disconnected
  lastError: text("last_error"),
  consecutiveErrors: integer("consecutive_errors").notNull().default(0),
  lastSyncAt: timestamp("last_sync_at"),
  connectedBy: varchar("connected_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAnalyticsConnectionSchema = createInsertSchema(analyticsConnections).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type AnalyticsConnection = typeof analyticsConnections.$inferSelect;
export type InsertAnalyticsConnection = z.infer<typeof insertAnalyticsConnectionSchema>;

// Daily aggregated analytics keyed by (tenant, market, date, source/medium/campaign).
export const analyticsDaily = pgTable("analytics_daily", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  date: text("date").notNull(), // YYYY-MM-DD
  source: text("source").notNull().default("(direct)"),
  medium: text("medium").notNull().default("(none)"),
  campaign: text("campaign"),
  sessions: integer("sessions").notNull().default(0),
  users: integer("users").notNull().default(0),
  conversions: integer("conversions").notNull().default(0),
  revenue: integer("revenue").notNull().default(0), // cents
  // Joined Orbit-attributed metrics (from marketing_link_clicks)
  orbitClicks: integer("orbit_clicks").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type AnalyticsDaily = typeof analyticsDaily.$inferSelect;

// Weekly Orbit Score (0-100) per tenant/market with components breakdown.
export const orbitScores = pgTable("orbit_scores", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  weekStart: text("week_start").notNull(), // ISO date of Monday
  score: integer("score").notNull(), // 0-100
  components: jsonb("components").notNull().$type<{
    sovTrend: number;
    publishRate: number;
    actionCompletion: number;
    socialEngagement: number;
    competitorFreshness: number;
    weights: Record<string, number>;
  }>(),
  businessType: text("business_type").notNull().default("b2b"),
  sicCode: text("sic_code"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type OrbitScore = typeof orbitScores.$inferSelect;

// Industry benchmark cohort (per-SIC), only published when sampleSize ≥ 5.
export const orbitScoreBenchmarks = pgTable("orbit_score_benchmarks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sicCode: text("sic_code").notNull(),
  weekStart: text("week_start").notNull(),
  p50: integer("p50").notNull(),
  p75: integer("p75").notNull(),
  sampleSize: integer("sample_size").notNull(),
  componentP50: jsonb("component_p50").$type<Record<string, number>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type OrbitScoreBenchmark = typeof orbitScoreBenchmarks.$inferSelect;


// ═══════════════════════════════════════════════════════════════════════════
// Collaboration — Task #103
// Threaded comments + @mentions, shared annotations on artifacts, action item
// assignments. Plan-gated by `collaboration` feature key.
// ═══════════════════════════════════════════════════════════════════════════

export const COLLAB_TARGET_KINDS = [
  "battlecard",
  "product_battlecard",
  "briefing",
  "gtm_plan",
  "messaging_framework",
  "competitor",
  "recommendation",
  "feature_recommendation",
  "gap",
  "annotation",
] as const;
export type CollabTargetKind = (typeof COLLAB_TARGET_KINDS)[number];

export const collaborationThreads = pgTable("collaboration_threads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  targetKind: text("target_kind").notNull(),
  targetId: text("target_id").notNull(),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  targetIdx: index("collab_threads_target_idx").on(table.tenantDomain, table.targetKind, table.targetId),
}));

export const collaborationComments = pgTable("collaboration_comments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  threadId: varchar("thread_id").notNull().references(() => collaborationThreads.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  authorUserId: varchar("author_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  mentions: jsonb("mentions").notNull().default(sql`'[]'::jsonb`), // string[] of user ids
  editedAt: timestamp("edited_at"),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  threadIdx: index("collab_comments_thread_idx").on(table.threadId, table.createdAt),
  tenantIdx: index("collab_comments_tenant_idx").on(table.tenantDomain, table.createdAt),
}));

export const annotations = pgTable("annotations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  targetKind: text("target_kind").notNull(),
  targetId: text("target_id").notNull(),
  fieldPath: text("field_path"), // optional dotted path for nested artifact fields
  rangeStart: integer("range_start"),
  rangeEnd: integer("range_end"),
  selectedText: text("selected_text"),
  threadId: varchar("thread_id").notNull().references(() => collaborationThreads.id, { onDelete: "cascade" }),
  createdByUserId: varchar("created_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  resolvedAt: timestamp("resolved_at"),
  resolvedByUserId: varchar("resolved_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  targetIdx: index("annotations_target_idx").on(table.tenantDomain, table.targetKind, table.targetId),
}));

export const insertCollaborationThreadSchema = createInsertSchema(collaborationThreads).omit({
  id: true, createdAt: true,
});
export const insertCollaborationCommentSchema = createInsertSchema(collaborationComments).omit({
  id: true, createdAt: true, editedAt: true, deletedAt: true,
});
export const insertAnnotationSchema = createInsertSchema(annotations).omit({
  id: true, createdAt: true, resolvedAt: true, resolvedByUserId: true,
});

export type CollaborationThread = typeof collaborationThreads.$inferSelect;
export type CollaborationComment = typeof collaborationComments.$inferSelect;
export type Annotation = typeof annotations.$inferSelect;
export type InsertCollaborationThread = z.infer<typeof insertCollaborationThreadSchema>;
export type InsertCollaborationComment = z.infer<typeof insertCollaborationCommentSchema>;
export type InsertAnnotation = z.infer<typeof insertAnnotationSchema>;

export const CURRENT_APP_VERSION = "3.0.0";

export const WHATS_NEW_HIGHLIGHTS = [
  { emoji: "🗺️", text: "Area-based navigation — Research, Product, Marketing, and Sales each have their own focused workspace" },
  { emoji: "🏠", text: "New Home page with live Orbit Score, area scorecards, and needs-attention signals at a glance" },
  { emoji: "📋", text: "Content Pipeline board — every social post, email, and brief in one drag-and-drop kanban with campaign filter" },
  { emoji: "📅", text: "Editorial Calendar with AI content briefs, multi-format copywriter, repurposing engine, and SEO/AEO optimizer" },
  { emoji: "🎪", text: "Conference Social Promotion — anchor + per-session posts with matched hero graphics and an archivable image space" },
  { emoji: "📈", text: "Marketing Performance closed-loop report and AI distribution planner with Microsoft Planner sync" },
];

export const WHATS_NEW_SUMMARY = "Orbit 3.0 is a major platform upgrade. The navigation is restructured into four value-chain areas (Research → Product → Marketing → Sales) with a new global Home page. Marketing gains a full content execution stack: Editorial Calendar with AI briefs, copywriter, repurpose engine, SEO/AEO optimizer, distribution planner, and a unified Content Pipeline board. Conference Social Promotion drives coordinated event marketing with composited hero graphics. A closed-loop Marketing Performance report ties content back to conversions.";

export const DEFAULT_CONTENT_CATEGORIES = [
  "Blog Post", "White Paper", "Case Study", "eBook", "Infographic",
  "Webinar", "Video", "Podcast", "Press Release", "Newsletter",
  "Product Brief", "Datasheet", "Landing Page", "Social Media Post",
];

export const DEFAULT_BRAND_ASSET_CATEGORIES = [
  "Logo", "Icon", "Hero Image", "Banner", "Social Media Graphic",
  "Product Screenshot", "Headshot", "Illustration", "Template", "Brand Kit",
];

export const CONTENT_SEASON_OPTIONS = [
  "Spring", "Summer", "Fall", "Winter", "Q1", "Q2", "Q3", "Q4",
  "Holiday", "Back to School", "Year End",
];

export const CONTENT_TOPIC_OPTIONS = [
  "Modern Workplace", "Digital Transformation", "Cloud", "Security",
  "AI & Machine Learning", "Collaboration", "Productivity", "Remote Work",
  "Sustainability", "Innovation", "Leadership", "Customer Success",
];

// ===== Manual Action Quotas (Task #99) =====
// Tracks each cost-driving manual action invocation for per-tenant monthly quota enforcement.
export const manualActionUsage = pgTable("manual_action_usage", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  userId: varchar("user_id"),
  action: text("action").notNull(),
  costTier: text("cost_tier").notNull().default("medium"),
  succeeded: boolean("succeeded"),
  occurredAt: timestamp("occurred_at").notNull().defaultNow(),
}, (table) => ({
  tenantActionMonthIdx: index("manual_action_usage_tenant_action_idx").on(
    table.tenantDomain,
    table.action,
    table.occurredAt,
  ),
}));

export const insertManualActionUsageSchema = createInsertSchema(manualActionUsage).omit({
  id: true,
  occurredAt: true,
});
export type InsertManualActionUsage = z.infer<typeof insertManualActionUsageSchema>;
export type ManualActionUsage = typeof manualActionUsage.$inferSelect;

// Admin-granted bonus quota for current-month rollover. Reset at month boundary.
export const manualActionBonuses = pgTable("manual_action_bonuses", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  action: text("action").notNull(),
  delta: integer("delta").notNull().default(0),
  periodStart: timestamp("period_start").notNull(),
  reason: text("reason"),
  grantedBy: varchar("granted_by"),
  grantedAt: timestamp("granted_at").notNull().defaultNow(),
}, (table) => ({
  tenantActionPeriodIdx: index("manual_action_bonuses_tenant_action_period_idx").on(
    table.tenantDomain,
    table.action,
    table.periodStart,
  ),
}));

export const insertManualActionBonusSchema = createInsertSchema(manualActionBonuses).omit({
  id: true,
  grantedAt: true,
});
export type InsertManualActionBonus = z.infer<typeof insertManualActionBonusSchema>;
export type ManualActionBonus = typeof manualActionBonuses.$inferSelect;

// ============================================================================
// Sales Outreach Campaigns (Phase 0 — schema foundation)
//
// A goal-driven 1:1 outbound system: prospect -> score -> draft in the
// seller's voice -> sequence follow-ups -> manage, with a human approving
// every send in Outlook. Translates the Cowork sales-harness-bundle (where
// "the MD file is the prospect") into relational tables + a state machine.
// See docs/sales-outreach-campaign-plan.md.
// ============================================================================

/** The campaign brief captured by the onboarding interview wizard. */
export interface OutreachInterview {
  /** The outcome in the user's words ("book 10 discovery calls"). */
  goal?: string;
  /** Core message / offering this campaign is about. */
  message?: string;
  /** The concrete ask + its mechanism (scheduler link, event RSVP, resource). */
  callToAction?: string;
  /** Free-text notes captured across the wizard turns. */
  notes?: string;
  /** Raw question/answer pairs, for replay + regeneration grounding. */
  answers?: { question: string; answer: string }[];
}

/** Refinements that narrow prospecting (drives the HubSpot/LinkedIn query). */
export interface OutreachTargetingFilter {
  /** City / region — also used for event-proximity targeting. */
  geographies?: string[];
  industries?: string[];
  /** Company-size bands or segment labels (e.g. "mid-market"). */
  segments?: string[];
  /** Named-account allow-list (company names or domains). */
  namedAccounts?: string[];
  /** Free-text titles/roles to target ("PE CIOs", "IT directors"). */
  targetRoles?: string[];
}

export type OutreachGoalType = "meeting" | "event_invite" | "intro" | "nurture";
export type OutreachChannel = "email" | "linkedin";
export type OutreachCampaignStatus = "draft" | "active" | "paused" | "completed" | "archived";

// The campaign container — created via the §5.0 interview wizard.
export const outreachCampaigns = pgTable("outreach_campaigns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  // What kind of campaign this is — selects the default cadence archetype.
  goalType: text("goal_type").notNull().default("meeting"), // OutreachGoalType
  // The goal in the user's words ("book 10 discovery calls for Polaris").
  salesGoal: text("sales_goal"),
  // The captured interview brief (mirrors campaigns.interview).
  interview: jsonb("interview").$type<OutreachInterview>(),
  // The product/service this campaign is about (optional).
  productId: varchar("product_id").references((): AnyPgColumn => products.id, { onDelete: "set null" }),
  // ICP personas this campaign targets (FK ids into personas; array, no cascade).
  targetPersonaIds: text("target_persona_ids").array(),
  // Geography/industry/segment/named-account refinements (the prospecting filter).
  targetingFilter: jsonb("targeting_filter").$type<OutreachTargetingFilter>(),
  // Channels this campaign uses (email / linkedin).
  channels: text("channels").array(),
  // Optional event anchor — when set, event-invite cadences back-date from eventDate.
  conferenceId: varchar("conference_id").references((): AnyPgColumn => conferences.id, { onDelete: "set null" }),
  eventDate: timestamp("event_date"),
  // The cadence template that drives follow-up sequencing.
  cadenceTemplateId: varchar("cadence_template_id").references((): AnyPgColumn => cadenceTemplates.id, { onDelete: "set null" }),
  // The voice profile drafts are written in — the seller's PERSONAL profile.
  voiceProfileId: varchar("voice_profile_id").references((): AnyPgColumn => socialAccountVoiceProfiles.id, { onDelete: "set null" }),
  status: text("status").notNull().default("draft"), // OutreachCampaignStatus
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index("outreach_campaigns_tenant_idx").on(table.tenantDomain),
  tenantStatusIdx: index("outreach_campaigns_tenant_status_idx").on(table.tenantDomain, table.status),
}));

export type CadenceArchetype = "meeting_drive" | "event_invite" | "nurture";
export type CadenceAnchor = "start_date" | "event_date";

// Reusable follow-up sequences. A template carries an archetype + an anchor
// (event-invite steps are back-dated from the campaign's eventDate).
export const cadenceTemplates = pgTable("cadence_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  name: text("name").notNull(),
  archetype: text("archetype").notNull().default("meeting_drive"), // CadenceArchetype
  anchor: text("anchor").notNull().default("start_date"), // CadenceAnchor
  // System-provided default templates are seeded per tenant and not deletable.
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index("cadence_templates_tenant_idx").on(table.tenantDomain),
}));

export type CadenceStepPurpose = "intro" | "value" | "case_study" | "invite" | "breakup";

// Individual touches within a cadence template.
export const cadenceSteps = pgTable("cadence_steps", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  templateId: varchar("template_id").notNull().references(() => cadenceTemplates.id, { onDelete: "cascade" }),
  stepNumber: integer("step_number").notNull(),
  channel: text("channel").notNull().default("email"), // OutreachChannel
  // Days from the anchor. Negative offsets allowed when anchored to an event.
  dayOffset: integer("day_offset").notNull().default(0),
  businessHoursOnly: boolean("business_hours_only").notNull().default(true),
  purpose: text("purpose").notNull().default("intro"), // CadenceStepPurpose
  // Guidance fed to the composer for this step.
  templateHint: text("template_hint"),
  // Which attached campaign resource (if any) this step surfaces.
  resourceType: text("resource_type"), // OutreachResourceType
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  templateStepIdx: index("cadence_steps_template_step_idx").on(table.templateId, table.stepNumber),
}));

/** Per-signal contribution to a prospect's ICP score. */
export interface ProspectScoreBreakdown {
  signals: { key: string; label: string; weight: number; matched: boolean; note?: string }[];
  total: number;
  /** Threshold the total was compared against. */
  threshold: number;
}

/** Raw research signals gathered about a prospect (sourced, never fabricated). */
export interface ProspectSignals {
  [key: string]: unknown;
  sources?: string[];
}

// The prospect state machine. Replaces the harness "MD file is the prospect".
export type ProspectStatus =
  | "new"
  | "researched"
  | "draft_pending_approval"
  | "sent"
  | "awaiting_reply"
  | "replied"
  | "cadence_step_due"
  | "dormant";

export const prospects = pgTable("prospects", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull().references(() => outreachCampaigns.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  marketId: varchar("market_id").references(() => markets.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  title: text("title"),
  companyName: text("company_name"),
  email: text("email"),
  linkedinUrl: text("linkedin_url"),
  // CRM linkage (enriched from / pushed to HubSpot).
  hubspotContactId: text("hubspot_contact_id"),
  hubspotCompanyId: text("hubspot_company_id"),
  source: text("source").notNull().default("manual"), // hubspot | manual | linkedin | import
  // ICP qualification.
  icpScore: integer("icp_score"),
  scoreBreakdown: jsonb("score_breakdown").$type<ProspectScoreBreakdown>(),
  disqualifiedReason: text("disqualified_reason"),
  // The AI research summary (markdown) — the "dossier".
  researchDossier: text("research_dossier"),
  signals: jsonb("signals").$type<ProspectSignals>(),
  status: text("status").notNull().default("new"), // ProspectStatus
  // Seller who owns this prospect (drives whose mailbox/voice is used).
  ownerUserId: varchar("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  // When the next cadence action is due (computed by the cadence engine).
  nextActionAt: timestamp("next_action_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  campaignIdx: index("prospects_campaign_idx").on(table.campaignId),
  tenantStatusIdx: index("prospects_tenant_status_idx").on(table.tenantDomain, table.status),
  nextActionIdx: index("prospects_next_action_idx").on(table.nextActionAt),
}));

/** Compliance / AI-cliché scan result attached to a generated draft. */
export interface OutreachComplianceFlags {
  pass: boolean;
  flags: { kind: "cliche" | "banned_phrase" | "suppression" | "self_email" | "can_spam"; detail: string }[];
  suggestedFixes?: string[];
}

export type OutreachTouchStatus =
  | "draft_pending_approval"
  | "approved"
  | "sent"
  | "skipped"
  | "bounced"
  | "replied";

// One generated draft / touch in a prospect's history.
export const outreachTouches = pgTable("outreach_touches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  prospectId: varchar("prospect_id").notNull().references(() => prospects.id, { onDelete: "cascade" }),
  campaignId: varchar("campaign_id").notNull().references(() => outreachCampaigns.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  channel: text("channel").notNull().default("email"), // OutreachChannel
  // LinkedIn message shape (null for email): connect_request | direct_message.
  // Drives the char limit and which deep link / paste flow the seller gets.
  linkedinFormat: text("linkedin_format"), // LinkedInFormat | null
  // Draft intent: outreach (an ask) vs engagement (warm, no hard ask).
  intent: text("intent"), // OutreachIntent | null
  stepNumber: integer("step_number").notNull().default(1),
  subject: text("subject"),
  body: text("body"),
  status: text("status").notNull().default("draft_pending_approval"), // OutreachTouchStatus
  // Graph message id of the draft created in the seller's Outlook.
  outlookDraftId: text("outlook_draft_id"),
  // LinkedIn thread / conversation reference (via the LinkedIn provider).
  linkedinThreadRef: text("linkedin_thread_ref"),
  complianceFlags: jsonb("compliance_flags").$type<OutreachComplianceFlags>(),
  voiceProfileId: varchar("voice_profile_id").references((): AnyPgColumn => socialAccountVoiceProfiles.id, { onDelete: "set null" }),
  generatedAt: timestamp("generated_at").notNull().defaultNow(),
  approvedBy: varchar("approved_by").references(() => users.id, { onDelete: "set null" }),
  sentAt: timestamp("sent_at"),
}, (table) => ({
  prospectIdx: index("outreach_touches_prospect_idx").on(table.prospectId),
  campaignStatusIdx: index("outreach_touches_campaign_status_idx").on(table.campaignId, table.status),
}));

export type OutreachResourceType = "product_info" | "scheduler" | "event_details" | "case_study" | "other";

// Digital assets attached to a campaign, injected at the right cadence step.
export const outreachCampaignResources = pgTable("outreach_campaign_resources", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull().references(() => outreachCampaigns.id, { onDelete: "cascade" }),
  tenantDomain: text("tenant_domain").notNull(),
  resourceType: text("resource_type").notNull().default("other"), // OutreachResourceType
  label: text("label"),
  // Either an inventory asset or a trackable link (or both).
  contentAssetId: varchar("content_asset_id").references((): AnyPgColumn => contentAssets.id, { onDelete: "set null" }),
  marketingLinkId: varchar("marketing_link_id").references((): AnyPgColumn => marketingLinks.id, { onDelete: "set null" }),
  // Which cadence step surfaces this resource (null = composer decides).
  injectAtStep: integer("inject_at_step"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  campaignIdx: index("outreach_campaign_resources_campaign_idx").on(table.campaignId),
}));

// Per-tenant circuit breakers + caps (§5.6). Defaults ship conservative.
export const outreachSettings = pgTable("outreach_settings", {
  tenantDomain: text("tenant_domain").primaryKey(),
  // Global kill switch — when true, all outreach is halted.
  globalPause: boolean("global_pause").notNull().default(false),
  // Master breaker: hard ceiling on total approvals/sends per day.
  masterDailyCap: integer("master_daily_cap").notNull().default(100),
  // Per-channel daily/weekly caps. LinkedIn ships far stricter than email.
  emailDailyCap: integer("email_daily_cap").notNull().default(50),
  emailWeeklyCap: integer("email_weekly_cap").notNull().default(200),
  linkedinDailyCap: integer("linkedin_daily_cap").notNull().default(15),
  linkedinWeeklyCap: integer("linkedin_weekly_cap").notNull().default(50),
  // No more than N touches into one company's domain per week.
  weeklyPerDomainCap: integer("weekly_per_domain_cap").notNull().default(3),
  // Campaigns auto-pause if reply rate falls below this floor (0–1). 0 = off.
  minReplyRateFloor: real("min_reply_rate_floor").notNull().default(0),
  defaultVoiceProfileId: varchar("default_voice_profile_id").references((): AnyPgColumn => socialAccountVoiceProfiles.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Append-only ledger of every send/approval — the authoritative source the
// circuit breakers count against (never in-memory counters alone).
export const outreachSendLedger = pgTable("outreach_send_ledger", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  touchId: varchar("touch_id").references(() => outreachTouches.id, { onDelete: "set null" }),
  channel: text("channel").notNull(), // OutreachChannel
  // Recipient domain — for the per-domain weekly cap.
  recipientDomain: text("recipient_domain"),
  ownerUserId: varchar("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  occurredAt: timestamp("occurred_at").notNull().defaultNow(),
}, (table) => ({
  tenantChannelTimeIdx: index("outreach_send_ledger_tenant_channel_time_idx").on(table.tenantDomain, table.channel, table.occurredAt),
  tenantDomainTimeIdx: index("outreach_send_ledger_domain_time_idx").on(table.tenantDomain, table.recipientDomain, table.occurredAt),
}));

// ── Relations ───────────────────────────────────────────────────────────────
export const outreachCampaignsRelations = relations(outreachCampaigns, ({ one, many }) => ({
  product: one(products, { fields: [outreachCampaigns.productId], references: [products.id] }),
  conference: one(conferences, { fields: [outreachCampaigns.conferenceId], references: [conferences.id] }),
  prospects: many(prospects),
  resources: many(outreachCampaignResources),
  touches: many(outreachTouches),
}));

export const cadenceTemplatesRelations = relations(cadenceTemplates, ({ many }) => ({
  steps: many(cadenceSteps),
}));

export const cadenceStepsRelations = relations(cadenceSteps, ({ one }) => ({
  template: one(cadenceTemplates, { fields: [cadenceSteps.templateId], references: [cadenceTemplates.id] }),
}));

export const prospectsRelations = relations(prospects, ({ one, many }) => ({
  campaign: one(outreachCampaigns, { fields: [prospects.campaignId], references: [outreachCampaigns.id] }),
  owner: one(users, { fields: [prospects.ownerUserId], references: [users.id] }),
  touches: many(outreachTouches),
}));

export const outreachTouchesRelations = relations(outreachTouches, ({ one }) => ({
  prospect: one(prospects, { fields: [outreachTouches.prospectId], references: [prospects.id] }),
  campaign: one(outreachCampaigns, { fields: [outreachTouches.campaignId], references: [outreachCampaigns.id] }),
}));

export const outreachCampaignResourcesRelations = relations(outreachCampaignResources, ({ one }) => ({
  campaign: one(outreachCampaigns, { fields: [outreachCampaignResources.campaignId], references: [outreachCampaigns.id] }),
}));

// ── Insert schemas + types ──────────────────────────────────────────────────
export const insertOutreachCampaignSchema = createInsertSchema(outreachCampaigns).omit({ id: true, createdAt: true, updatedAt: true });
export type OutreachCampaign = typeof outreachCampaigns.$inferSelect;
export type InsertOutreachCampaign = z.infer<typeof insertOutreachCampaignSchema>;

export const insertCadenceTemplateSchema = createInsertSchema(cadenceTemplates).omit({ id: true, createdAt: true, updatedAt: true });
export type CadenceTemplate = typeof cadenceTemplates.$inferSelect;
export type InsertCadenceTemplate = z.infer<typeof insertCadenceTemplateSchema>;

export const insertCadenceStepSchema = createInsertSchema(cadenceSteps).omit({ id: true, createdAt: true });
export type CadenceStep = typeof cadenceSteps.$inferSelect;
export type InsertCadenceStep = z.infer<typeof insertCadenceStepSchema>;

export const insertProspectSchema = createInsertSchema(prospects).omit({ id: true, createdAt: true, updatedAt: true });
export type Prospect = typeof prospects.$inferSelect;
export type InsertProspect = z.infer<typeof insertProspectSchema>;

export const insertOutreachTouchSchema = createInsertSchema(outreachTouches).omit({ id: true, generatedAt: true });
export type OutreachTouch = typeof outreachTouches.$inferSelect;
export type InsertOutreachTouch = z.infer<typeof insertOutreachTouchSchema>;

export const insertOutreachCampaignResourceSchema = createInsertSchema(outreachCampaignResources).omit({ id: true, createdAt: true });
export type OutreachCampaignResource = typeof outreachCampaignResources.$inferSelect;
export type InsertOutreachCampaignResource = z.infer<typeof insertOutreachCampaignResourceSchema>;

export const insertOutreachSettingsSchema = createInsertSchema(outreachSettings).omit({ updatedAt: true });
export type OutreachSettings = typeof outreachSettings.$inferSelect;
export type InsertOutreachSettings = z.infer<typeof insertOutreachSettingsSchema>;

export const insertOutreachSendLedgerSchema = createInsertSchema(outreachSendLedger).omit({ id: true, occurredAt: true });
export type OutreachSendLedgerEntry = typeof outreachSendLedger.$inferSelect;
export type InsertOutreachSendLedgerEntry = z.infer<typeof insertOutreachSendLedgerSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// OBSERVATORY — Application Assurance & Certification Intelligence
// Traceability spine: Application → Version → Assessment → Finding →
// Evidence → Control → Framework. All tenant-scoped except the shared
// framework/control catalog (global standards library).
// ═══════════════════════════════════════════════════════════════════════════

// ── Constants ───────────────────────────────────────────────────────────────
export const OBS_ASSESSMENT_TYPES = [
  "accessibility",
  "security_source_review",
  "penetration_test",
  "architecture_review",
  "privacy_review",
  "ai_governance",
  "performance",
  "code_quality",
  "compliance",
] as const;
export type ObsAssessmentType = (typeof OBS_ASSESSMENT_TYPES)[number];

export const OBS_VERSION_STATUSES = [
  "Draft",
  "In Review",
  "Ready With Exceptions",
  "Ready",
  "Blocked",
  "Retired",
] as const;
export type ObsVersionStatus = (typeof OBS_VERSION_STATUSES)[number];

export const OBS_ASSESSMENT_STATUSES = [
  "planned",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export const OBS_FINDING_SEVERITIES = [
  "Critical",
  "High",
  "Medium",
  "Low",
  "Informational",
] as const;
export type ObsFindingSeverity = (typeof OBS_FINDING_SEVERITIES)[number];

export const OBS_FINDING_DOMAINS = [
  "accessibility",
  "security",
  "privacy",
  "architecture",
  "performance",
  "code_quality",
  "ai_governance",
  "compliance",
  "usability",
] as const;
export type ObsFindingDomain = (typeof OBS_FINDING_DOMAINS)[number];

export const OBS_FINDING_STATUSES = [
  "open",
  "in_progress",
  "remediated",
  "verified",
  "accepted_risk",
  "deferred",
  "duplicate",
  "wont_fix",
] as const;
export type ObsFindingStatus = (typeof OBS_FINDING_STATUSES)[number];

export const OBS_EVIDENCE_TYPES = [
  "screenshot",
  "document",
  "log_extract",
  "scan_report",
  "test_result",
  "url",
  "code_snippet",
  "attestation",
  "configuration",
  "other",
] as const;
export type ObsEvidenceType = (typeof OBS_EVIDENCE_TYPES)[number];

// ── Applications ────────────────────────────────────────────────────────────
export const obsApplications = pgTable("obs_applications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  name: text("name").notNull(),
  productFamily: text("product_family"),
  description: text("description"),
  businessOwner: text("business_owner"),
  technicalOwner: text("technical_owner"),
  appUrl: text("app_url"),
  repoUrl: text("repo_url"),
  hostingPlatform: text("hosting_platform"),
  authMethod: text("auth_method"),
  dataClassification: text("data_classification"), // public, internal, confidential, restricted
  aiEnabled: boolean("ai_enabled").notNull().default(false),
  certificationTarget: text("certification_target"),
  status: text("status").notNull().default("active"), // active, archived
  /** Optional custom SLA thresholds for performance scans. Falls back to platform defaults when null. */
  perfSlaConfig: jsonb("perf_sla_config"),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("obs_applications_tenant_idx").on(t.tenantDomain),
}));

// ── Versions ────────────────────────────────────────────────────────────────
export const obsVersions = pgTable("obs_versions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  applicationId: varchar("application_id").notNull().references(() => obsApplications.id, { onDelete: "cascade" }),
  versionNumber: text("version_number").notNull(),
  releaseDate: timestamp("release_date"),
  environment: text("environment"), // development, staging, production
  buildNumber: text("build_number"),
  branch: text("branch"),
  commitHash: text("commit_hash"),
  notes: text("notes"),
  assessmentStatus: text("assessment_status").notNull().default("Draft"), // OBS_VERSION_STATUSES
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("obs_versions_tenant_idx").on(t.tenantDomain),
  appIdx: index("obs_versions_app_idx").on(t.applicationId),
}));

// ── Assessments ─────────────────────────────────────────────────────────────
export const obsAssessments = pgTable("obs_assessments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  applicationId: varchar("application_id").notNull().references(() => obsApplications.id, { onDelete: "cascade" }),
  versionId: varchar("version_id").references(() => obsVersions.id, { onDelete: "set null" }),
  type: text("type").notNull(), // OBS_ASSESSMENT_TYPES
  title: text("title").notNull(),
  assessorName: text("assessor_name"),
  assessorUserId: varchar("assessor_user_id").references(() => users.id, { onDelete: "set null" }),
  team: text("team"),
  status: text("status").notNull().default("planned"), // OBS_ASSESSMENT_STATUSES
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  scope: text("scope"),
  outOfScope: text("out_of_scope"),
  executiveSummary: text("executive_summary"),
  overallScore: integer("overall_score"), // 0-100
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("obs_assessments_tenant_idx").on(t.tenantDomain),
  appIdx: index("obs_assessments_app_idx").on(t.applicationId),
  versionIdx: index("obs_assessments_version_idx").on(t.versionId),
}));

// ── Frameworks & Controls (global standards catalog) ───────────────────────
export const obsFrameworks = pgTable("obs_frameworks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull().unique(), // e.g. "WCAG22", "OWASP_TOP10"
  name: text("name").notNull(),
  version: text("version"),
  description: text("description"),
  category: text("category"), // accessibility, security, privacy, compliance, ai
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const obsControls = pgTable("obs_controls", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  frameworkId: varchar("framework_id").notNull().references(() => obsFrameworks.id, { onDelete: "cascade" }),
  controlId: text("control_id").notNull(), // e.g. "1.1.1", "A01:2021"
  title: text("title").notNull(),
  description: text("description"),
  category: text("category"), // grouping within the framework
  level: text("level"), // e.g. WCAG A/AA/AAA, ASVS L1/L2/L3
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => ({
  frameworkIdx: index("obs_controls_framework_idx").on(t.frameworkId),
  uniqueControl: uniqueIndex("obs_controls_framework_control_idx").on(t.frameworkId, t.controlId),
}));

// ── Findings ────────────────────────────────────────────────────────────────
export const obsFindings = pgTable("obs_findings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  assessmentId: varchar("assessment_id").notNull().references(() => obsAssessments.id, { onDelete: "cascade" }),
  applicationId: varchar("application_id").notNull().references(() => obsApplications.id, { onDelete: "cascade" }),
  versionId: varchar("version_id").references(() => obsVersions.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description"),
  severity: text("severity").notNull().default("Medium"), // OBS_FINDING_SEVERITIES
  domain: text("domain").notNull(), // OBS_FINDING_DOMAINS
  status: text("status").notNull().default("open"), // OBS_FINDING_STATUSES
  recommendation: text("recommendation"),
  remediationPlan: text("remediation_plan"),
  affectedComponent: text("affected_component"),
  stepsToReproduce: text("steps_to_reproduce"),
  likelihood: text("likelihood"), // low, medium, high
  impact: text("impact"), // low, medium, high
  cweId: text("cwe_id"),
  wcagCriterion: text("wcag_criterion"),
  sourceFile: text("source_file"), // affected source file (source code review)
  sourceLine: integer("source_line"), // affected line number (source code review)
  dueDate: timestamp("due_date"),
  assignedToUserId: varchar("assigned_to_user_id").references(() => users.id, { onDelete: "set null" }),
  assignedToName: text("assigned_to_name"),
  resolvedAt: timestamp("resolved_at"),
  // Automated-scan rule identifier. Set only for findings created by the
  // built-in security scanner so the scan job can upsert by rule rather than
  // create duplicates on every run.
  scanRuleId: text("scan_rule_id"),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("obs_findings_tenant_idx").on(t.tenantDomain),
  assessmentIdx: index("obs_findings_assessment_idx").on(t.assessmentId),
  appIdx: index("obs_findings_app_idx").on(t.applicationId),
  statusIdx: index("obs_findings_status_idx").on(t.tenantDomain, t.status),
}));

// ── Evidence ────────────────────────────────────────────────────────────────
export const obsEvidence = pgTable("obs_evidence", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  evidenceType: text("evidence_type").notNull().default("document"), // OBS_EVIDENCE_TYPES
  fileUrl: text("file_url"), // object storage path (/objects/…)
  fileName: text("file_name"),
  fileSize: integer("file_size"),
  contentType: text("content_type"),
  externalUrl: text("external_url"), // URL-type evidence
  body: text("body"), // Raw report payload for scan_report evidence (e.g. axe-core JSON output)
  source: text("source"), // tool or origin, e.g. "axe-core", "Burp Suite"
  collectedBy: text("collected_by"),
  collectedAt: timestamp("collected_at"),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("obs_evidence_tenant_idx").on(t.tenantDomain),
}));

// ── Link tables (many-to-many) ──────────────────────────────────────────────
export const obsFindingEvidence = pgTable("obs_finding_evidence", {
  findingId: varchar("finding_id").notNull().references(() => obsFindings.id, { onDelete: "cascade" }),
  evidenceId: varchar("evidence_id").notNull().references(() => obsEvidence.id, { onDelete: "cascade" }),
}, (t) => ({
  pk: primaryKey({ columns: [t.findingId, t.evidenceId] }),
}));

export const obsAssessmentEvidence = pgTable("obs_assessment_evidence", {
  assessmentId: varchar("assessment_id").notNull().references(() => obsAssessments.id, { onDelete: "cascade" }),
  evidenceId: varchar("evidence_id").notNull().references(() => obsEvidence.id, { onDelete: "cascade" }),
}, (t) => ({
  pk: primaryKey({ columns: [t.assessmentId, t.evidenceId] }),
}));

export const obsVersionEvidence = pgTable("obs_version_evidence", {
  versionId: varchar("version_id").notNull().references(() => obsVersions.id, { onDelete: "cascade" }),
  evidenceId: varchar("evidence_id").notNull().references(() => obsEvidence.id, { onDelete: "cascade" }),
}, (t) => ({
  pk: primaryKey({ columns: [t.versionId, t.evidenceId] }),
}));

export const obsControlEvidence = pgTable("obs_control_evidence", {
  controlId: varchar("control_id").notNull().references(() => obsControls.id, { onDelete: "cascade" }),
  evidenceId: varchar("evidence_id").notNull().references(() => obsEvidence.id, { onDelete: "cascade" }),
}, (t) => ({
  pk: primaryKey({ columns: [t.controlId, t.evidenceId] }),
}));

export const obsFindingControls = pgTable("obs_finding_controls", {
  findingId: varchar("finding_id").notNull().references(() => obsFindings.id, { onDelete: "cascade" }),
  controlId: varchar("control_id").notNull().references(() => obsControls.id, { onDelete: "cascade" }),
}, (t) => ({
  pk: primaryKey({ columns: [t.findingId, t.controlId] }),
}));

// ── Audit log ───────────────────────────────────────────────────────────────
export const obsAuditLogs = pgTable("obs_audit_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  userId: varchar("user_id").references(() => users.id, { onDelete: "set null" }),
  entityType: text("entity_type").notNull(), // application, version, assessment, finding, evidence, link
  entityId: varchar("entity_id").notNull(),
  action: text("action").notNull(), // create, update, delete, link, unlink, bulk_update
  summary: text("summary"),
  changes: jsonb("changes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("obs_audit_logs_tenant_idx").on(t.tenantDomain, t.createdAt),
  entityIdx: index("obs_audit_logs_entity_idx").on(t.entityType, t.entityId),
}));

// ── Relations ───────────────────────────────────────────────────────────────
export const obsApplicationsRelations = relations(obsApplications, ({ many }) => ({
  versions: many(obsVersions),
  assessments: many(obsAssessments),
  findings: many(obsFindings),
}));

export const obsVersionsRelations = relations(obsVersions, ({ one, many }) => ({
  application: one(obsApplications, { fields: [obsVersions.applicationId], references: [obsApplications.id] }),
  assessments: many(obsAssessments),
}));

export const obsAssessmentsRelations = relations(obsAssessments, ({ one, many }) => ({
  application: one(obsApplications, { fields: [obsAssessments.applicationId], references: [obsApplications.id] }),
  version: one(obsVersions, { fields: [obsAssessments.versionId], references: [obsVersions.id] }),
  findings: many(obsFindings),
}));

export const obsFindingsRelations = relations(obsFindings, ({ one }) => ({
  assessment: one(obsAssessments, { fields: [obsFindings.assessmentId], references: [obsAssessments.id] }),
  application: one(obsApplications, { fields: [obsFindings.applicationId], references: [obsApplications.id] }),
  version: one(obsVersions, { fields: [obsFindings.versionId], references: [obsVersions.id] }),
}));

export const obsControlsRelations = relations(obsControls, ({ one }) => ({
  framework: one(obsFrameworks, { fields: [obsControls.frameworkId], references: [obsFrameworks.id] }),
}));

// ── Insert schemas + types ──────────────────────────────────────────────────
export const insertObsApplicationSchema = createInsertSchema(obsApplications).omit({ id: true, createdAt: true, updatedAt: true });
export type ObsApplication = typeof obsApplications.$inferSelect;
export type InsertObsApplication = z.infer<typeof insertObsApplicationSchema>;

export const insertObsVersionSchema = createInsertSchema(obsVersions).omit({ id: true, createdAt: true, updatedAt: true });
export type ObsVersion = typeof obsVersions.$inferSelect;
export type InsertObsVersion = z.infer<typeof insertObsVersionSchema>;

export const insertObsAssessmentSchema = createInsertSchema(obsAssessments).omit({ id: true, createdAt: true, updatedAt: true });
export type ObsAssessment = typeof obsAssessments.$inferSelect;
export type InsertObsAssessment = z.infer<typeof insertObsAssessmentSchema>;

export const insertObsFrameworkSchema = createInsertSchema(obsFrameworks).omit({ id: true, createdAt: true });
export type ObsFramework = typeof obsFrameworks.$inferSelect;
export type InsertObsFramework = z.infer<typeof insertObsFrameworkSchema>;

export const insertObsControlSchema = createInsertSchema(obsControls).omit({ id: true });
export type ObsControl = typeof obsControls.$inferSelect;
export type InsertObsControl = z.infer<typeof insertObsControlSchema>;

export const insertObsFindingSchema = createInsertSchema(obsFindings).omit({ id: true, createdAt: true, updatedAt: true });
export type ObsFinding = typeof obsFindings.$inferSelect;
export type InsertObsFinding = z.infer<typeof insertObsFindingSchema>;

export const insertObsEvidenceSchema = createInsertSchema(obsEvidence).omit({ id: true, createdAt: true, updatedAt: true });
export type ObsEvidence = typeof obsEvidence.$inferSelect;
export type InsertObsEvidence = z.infer<typeof insertObsEvidenceSchema>;

export const insertObsAuditLogSchema = createInsertSchema(obsAuditLogs).omit({ id: true, createdAt: true });
export type ObsAuditLog = typeof obsAuditLogs.$inferSelect;
export type InsertObsAuditLog = z.infer<typeof insertObsAuditLogSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Observatory — specialized assessment modules (workbenches)
// Accessibility, Source Code, Pen Test, Architecture, Privacy, AI Governance
// ═══════════════════════════════════════════════════════════════════════════

// ── Module constants ────────────────────────────────────────────────────────
export const OBS_REVIEW_MODULES = [
  "accessibility",
  "source_code",
  "architecture",
  "architecture_azure",
  "privacy",
  "ai_governance",
] as const;
export type ObsReviewModule = (typeof OBS_REVIEW_MODULES)[number];

/** Checklist row statuses for review workbenches (accessibility semantics, reused everywhere). */
export const OBS_REVIEW_STATUSES = [
  "Pass",
  "Pass With Notes",
  "Supports With Exceptions",
  "Fail",
  "Not Tested",
  "Not Applicable",
] as const;
export type ObsReviewStatus = (typeof OBS_REVIEW_STATUSES)[number];

/** Statuses for the Azure capability checklist rows (architecture_azure module). */
export const OBS_AZURE_STATUSES = [
  "Configured",
  "Partially Configured",
  "Not Configured",
  "Planned",
  "Not Applicable",
] as const;
export type ObsAzureStatus = (typeof OBS_AZURE_STATUSES)[number];

export const OBS_ACCESSIBILITY_CATEGORIES = [
  "Images",
  "Forms",
  "Keyboard",
  "Focus",
  "Color Contrast",
  "ARIA",
  "Screen Reader",
  "Tables",
  "Responsive Design",
  "Zoom Testing",
  "Semantic Structure",
  "Error Handling",
] as const;

export const OBS_SOURCE_REVIEW_CATEGORIES = [
  "Input Validation",
  "Authentication",
  "Authorization",
  "Session Management",
  "Cryptography",
  "Error Handling & Logging",
  "Data Protection",
  "Dependency Management",
  "Secrets Handling",
  "Code Quality & Maintainability",
] as const;

export const OBS_ARCHITECTURE_AREAS = [
  "Authentication",
  "Authorization",
  "Encryption",
  "Logging",
  "Monitoring",
  "Secrets Management",
  "Data Protection",
  "Network Security",
] as const;

export const OBS_AZURE_CAPABILITIES = [
  "Entra ID",
  "Managed Identity",
  "Key Vault",
  "Front Door",
  "WAF",
  "App Service",
  "AKS",
  "Functions",
  "Storage",
  "SQL",
] as const;

export const OBS_PRIVACY_AREAS = [
  "Data Collection",
  "Retention",
  "Deletion",
  "Consent",
  "Classification",
  "Auditability",
  "Privacy Controls",
] as const;

export const OBS_AI_GOVERNANCE_AREAS = [
  "Model Inventory",
  "Prompt Handling",
  "Human Oversight",
  "Citation Strategy",
  "Grounding",
  "Data Leakage Prevention",
  "Prompt Injection Protection",
  "Model Documentation",
] as const;

/** Default checklist categories seeded per module when a workbench is initialized. */
export const OBS_MODULE_CATEGORIES: Record<ObsReviewModule, readonly string[]> = {
  accessibility: OBS_ACCESSIBILITY_CATEGORIES,
  source_code: OBS_SOURCE_REVIEW_CATEGORIES,
  architecture: OBS_ARCHITECTURE_AREAS,
  architecture_azure: OBS_AZURE_CAPABILITIES,
  privacy: OBS_PRIVACY_AREAS,
  ai_governance: OBS_AI_GOVERNANCE_AREAS,
};

export const OBS_PEN_TEST_RESULTS = [
  "Ready",
  "Ready After Remediation",
  "Remediation Required",
  "Not Ready",
] as const;
export type ObsPenTestResult = (typeof OBS_PEN_TEST_RESULTS)[number];

export const OBS_VALIDATION_STATUSES = [
  "Not Started",
  "In Progress",
  "Validated",
  "Failed Validation",
] as const;
export type ObsValidationStatus = (typeof OBS_VALIDATION_STATUSES)[number];

export const OBS_EXPLOITABILITY_LEVELS = [
  "Trivial",
  "Easy",
  "Moderate",
  "Difficult",
  "Theoretical",
] as const;
export type ObsExploitability = (typeof OBS_EXPLOITABILITY_LEVELS)[number];

// ── Review items (shared checklist rows across workbenches) ─────────────────
export const obsReviewItems = pgTable("obs_review_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  assessmentId: varchar("assessment_id").notNull().references(() => obsAssessments.id, { onDelete: "cascade" }),
  module: text("module").notNull(), // OBS_REVIEW_MODULES
  category: text("category").notNull(), // one of the module's category constants
  status: text("status").notNull().default("Not Tested"), // OBS_REVIEW_STATUSES (or OBS_AZURE_STATUSES for architecture_azure)
  notes: text("notes"),
  reviewer: text("reviewer"),
  reviewedAt: timestamp("reviewed_at"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("obs_review_items_tenant_idx").on(t.tenantDomain),
  assessmentIdx: index("obs_review_items_assessment_idx").on(t.assessmentId),
  uniqueRow: uniqueIndex("obs_review_items_assessment_module_category_idx").on(t.assessmentId, t.module, t.category),
}));

export const obsReviewItemFindings = pgTable("obs_review_item_findings", {
  reviewItemId: varchar("review_item_id").notNull().references(() => obsReviewItems.id, { onDelete: "cascade" }),
  findingId: varchar("finding_id").notNull().references(() => obsFindings.id, { onDelete: "cascade" }),
}, (t) => ({
  pk: primaryKey({ columns: [t.reviewItemId, t.findingId] }),
}));

export const obsReviewItemEvidence = pgTable("obs_review_item_evidence", {
  reviewItemId: varchar("review_item_id").notNull().references(() => obsReviewItems.id, { onDelete: "cascade" }),
  evidenceId: varchar("evidence_id").notNull().references(() => obsEvidence.id, { onDelete: "cascade" }),
}, (t) => ({
  pk: primaryKey({ columns: [t.reviewItemId, t.evidenceId] }),
}));

// ── Source code review metadata (one per assessment) ───────────────────────
export const obsSourceReviewMeta = pgTable("obs_source_review_meta", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  assessmentId: varchar("assessment_id").notNull().references(() => obsAssessments.id, { onDelete: "cascade" }),
  repositoryUrl: text("repository_url"),
  branch: text("branch"),
  commitHash: text("commit_hash"),
  language: text("language"),
  framework: text("framework"),
  component: text("component"),
  reviewTool: text("review_tool"), // manual, or future scanner provider key
  notes: text("notes"),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("obs_source_review_meta_tenant_idx").on(t.tenantDomain),
  uniqueAssessment: uniqueIndex("obs_source_review_meta_assessment_idx").on(t.assessmentId),
}));

// ── Penetration tests ───────────────────────────────────────────────────────
export const obsPenTests = pgTable("obs_pen_tests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  assessmentId: varchar("assessment_id").notNull().references(() => obsAssessments.id, { onDelete: "cascade" }),
  testName: text("test_name").notNull(),
  firm: text("firm"),
  leadTester: text("lead_tester"),
  methodology: text("methodology"), // e.g. OWASP WSTG, PTES, OSSTMM
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  executiveSummary: text("executive_summary"),
  result: text("result"), // OBS_PEN_TEST_RESULTS, null until concluded
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("obs_pen_tests_tenant_idx").on(t.tenantDomain),
  uniqueAssessment: uniqueIndex("obs_pen_tests_assessment_idx").on(t.assessmentId),
}));

/**
 * Pen-test finding extension. Each row wraps a shared obs_findings row (the
 * finding participates in the global traceability model) and adds the
 * pen-test-specific attributes: CVSS, exploitability, and validation tracking.
 */
export const obsPenTestFindings = pgTable("obs_pen_test_findings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  penTestId: varchar("pen_test_id").notNull().references(() => obsPenTests.id, { onDelete: "cascade" }),
  findingId: varchar("finding_id").notNull().references(() => obsFindings.id, { onDelete: "cascade" }),
  cvssScore: real("cvss_score"), // 0.0 – 10.0
  cvssVector: text("cvss_vector"), // e.g. CVSS:3.1/AV:N/AC:L/…
  exploitability: text("exploitability"), // OBS_EXPLOITABILITY_LEVELS
  validationStatus: text("validation_status").notNull().default("Not Started"), // OBS_VALIDATION_STATUSES
  validatedBy: text("validated_by"),
  validatedAt: timestamp("validated_at"),
  // True only for rows created by the backfill endpoint (POST .../relink-findings).
  // The pen-test deletion route skips explicitly deleting obs_findings rows for
  // backlinked findings — those belong to the assessment, not exclusively to the
  // pen test, so they should survive a pen test deletion.
  backlinkFinding: boolean("backlink_finding").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("obs_pen_test_findings_tenant_idx").on(t.tenantDomain),
  penTestIdx: index("obs_pen_test_findings_pen_test_idx").on(t.penTestId),
  uniqueFinding: uniqueIndex("obs_pen_test_findings_finding_idx").on(t.findingId),
}));

// ── Relations ───────────────────────────────────────────────────────────────
export const obsReviewItemsRelations = relations(obsReviewItems, ({ one }) => ({
  assessment: one(obsAssessments, { fields: [obsReviewItems.assessmentId], references: [obsAssessments.id] }),
}));

export const obsPenTestsRelations = relations(obsPenTests, ({ one, many }) => ({
  assessment: one(obsAssessments, { fields: [obsPenTests.assessmentId], references: [obsAssessments.id] }),
  penTestFindings: many(obsPenTestFindings),
}));

export const obsPenTestFindingsRelations = relations(obsPenTestFindings, ({ one }) => ({
  penTest: one(obsPenTests, { fields: [obsPenTestFindings.penTestId], references: [obsPenTests.id] }),
  finding: one(obsFindings, { fields: [obsPenTestFindings.findingId], references: [obsFindings.id] }),
}));

// ── Insert schemas + types ──────────────────────────────────────────────────
export const insertObsReviewItemSchema = createInsertSchema(obsReviewItems).omit({ id: true, createdAt: true, updatedAt: true });
export type ObsReviewItem = typeof obsReviewItems.$inferSelect;
export type InsertObsReviewItem = z.infer<typeof insertObsReviewItemSchema>;

export const insertObsSourceReviewMetaSchema = createInsertSchema(obsSourceReviewMeta).omit({ id: true, createdAt: true, updatedAt: true });
export type ObsSourceReviewMeta = typeof obsSourceReviewMeta.$inferSelect;
export type InsertObsSourceReviewMeta = z.infer<typeof insertObsSourceReviewMetaSchema>;

export const insertObsPenTestSchema = createInsertSchema(obsPenTests).omit({ id: true, createdAt: true, updatedAt: true });
export type ObsPenTest = typeof obsPenTests.$inferSelect;
export type InsertObsPenTest = z.infer<typeof insertObsPenTestSchema>;

export const insertObsPenTestFindingSchema = createInsertSchema(obsPenTestFindings).omit({ id: true, createdAt: true, updatedAt: true });
export type ObsPenTestFinding = typeof obsPenTestFindings.$inferSelect;
export type InsertObsPenTestFinding = z.infer<typeof insertObsPenTestFindingSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Observatory — readiness engine, reporting engine, VPAT assistant
// ═══════════════════════════════════════════════════════════════════════════

/** Readiness scoring domains and their weights (percent of overall score). */
export const OBS_READINESS_DOMAINS = [
  "accessibility",
  "security",
  "source_code",
  "architecture",
  "privacy",
  "documentation",
  "ai_governance",
] as const;
export type ObsReadinessDomain = (typeof OBS_READINESS_DOMAINS)[number];

export const OBS_READINESS_WEIGHTS: Record<ObsReadinessDomain, number> = {
  accessibility: 25,
  security: 25,
  source_code: 15,
  architecture: 10,
  privacy: 10,
  documentation: 10,
  ai_governance: 5,
};

export const OBS_READINESS_DOMAIN_LABELS: Record<ObsReadinessDomain, string> = {
  accessibility: "Accessibility",
  security: "Security",
  source_code: "Source Code",
  architecture: "Architecture",
  privacy: "Privacy",
  documentation: "Documentation",
  ai_governance: "AI Governance",
};

/** Readiness status bands (derived from the weighted overall score). */
export const OBS_READINESS_BANDS = [
  "Ready",                          // 90–100
  "Ready With Minor Remediation",   // 75–89
  "Remediation Required",           // 60–74
  "Not Ready",                      // 0–59
] as const;
export type ObsReadinessBand = (typeof OBS_READINESS_BANDS)[number];

/** One domain's contribution to a readiness score snapshot. */
export interface ObsDomainScore {
  domain: ObsReadinessDomain;
  score: number | null;      // 0–100, null when not applicable
  weight: number;            // effective weight after renormalization
  applicable: boolean;
  assessed: boolean;         // any assessment/evidence data exists for the domain
  openFindings: number;
  note?: string;
}

/** A hard blocker preventing a version from being certified Ready. */
export interface ObsReadinessBlocker {
  type: "open_critical_findings" | "unvalidated_critical_pen_test" | "missing_mandatory_evidence";
  reason: string;
  count: number;
  refs?: { id: string; title: string }[];
}

// ── Readiness score snapshots (one row per computation) ────────────────────
export const obsReadinessScores = pgTable("obs_readiness_scores", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  applicationId: varchar("application_id").notNull().references(() => obsApplications.id, { onDelete: "cascade" }),
  versionId: varchar("version_id").notNull().references(() => obsVersions.id, { onDelete: "cascade" }),
  overallScore: integer("overall_score").notNull(), // 0–100 weighted
  band: text("band").notNull(), // OBS_READINESS_BANDS (after blocker enforcement)
  rawBand: text("raw_band").notNull(), // band implied by score alone
  blocked: boolean("blocked").notNull().default(false),
  domainScores: jsonb("domain_scores").notNull(), // ObsDomainScore[]
  blockers: jsonb("blockers").notNull().default(sql`'[]'::jsonb`), // ObsReadinessBlocker[]
  computedBy: varchar("computed_by").references(() => users.id, { onDelete: "set null" }),
  computedAt: timestamp("computed_at").notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("obs_readiness_scores_tenant_idx").on(t.tenantDomain),
  versionIdx: index("obs_readiness_scores_version_idx").on(t.versionId, t.computedAt),
}));

// ── Reports (async generation records; printable HTML + PDF export) ────────
export const OBS_REPORT_TYPES = [
  "executive_readiness",
  "technical_assessment",
  "accessibility_vpat",
  "pen_test",
  "certification_readiness",
] as const;
export type ObsReportType = (typeof OBS_REPORT_TYPES)[number];

export const OBS_REPORT_TYPE_LABELS: Record<ObsReportType, string> = {
  executive_readiness: "Executive Readiness Report",
  technical_assessment: "Technical Assessment Report",
  accessibility_vpat: "Accessibility Report (WCAG/508 + VPAT)",
  pen_test: "Penetration Test Report",
  certification_readiness: "Certification Readiness Report",
};

export const OBS_REPORT_STATUSES = ["generating", "generated", "failed"] as const;
export type ObsReportStatus = (typeof OBS_REPORT_STATUSES)[number];

export const obsReports = pgTable("obs_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  applicationId: varchar("application_id").notNull().references(() => obsApplications.id, { onDelete: "cascade" }),
  versionId: varchar("version_id").references(() => obsVersions.id, { onDelete: "set null" }),
  reportType: text("report_type").notNull(), // OBS_REPORT_TYPES
  title: text("title").notNull(),
  status: text("status").notNull().default("generating"), // OBS_REPORT_STATUSES
  html: text("html"), // printable HTML (set when generated)
  aiSummary: text("ai_summary"), // AI-drafted executive summary (editable)
  includeAiSummary: boolean("include_ai_summary").notNull().default(false),
  error: text("error"),
  generatedAt: timestamp("generated_at"),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("obs_reports_tenant_idx").on(t.tenantDomain, t.createdAt),
}));

// ── VPAT assistant ──────────────────────────────────────────────────────────
export const OBS_VPAT_CONFORMANCE = [
  "Supports",
  "Partially Supports",
  "Supports With Exceptions",
  "Does Not Support",
  "Not Applicable",
  "Not Evaluated",
] as const;
export type ObsVpatConformance = (typeof OBS_VPAT_CONFORMANCE)[number];

/** Mandatory disclaimer shown on every VPAT screen and output. */
export const OBS_VPAT_DISCLAIMER =
  "Draft VPAT support content only. Requires human review and validation. Not a legal certification.";

export const obsVpatEntries = pgTable("obs_vpat_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  versionId: varchar("version_id").notNull().references(() => obsVersions.id, { onDelete: "cascade" }),
  applicationId: varchar("application_id").notNull().references(() => obsApplications.id, { onDelete: "cascade" }),
  controlRef: varchar("control_ref").notNull().references(() => obsControls.id, { onDelete: "cascade" }),
  conformance: text("conformance").notNull().default("Not Evaluated"), // OBS_VPAT_CONFORMANCE
  remarks: text("remarks"),
  reviewerNotes: text("reviewer_notes"),
  aiDrafted: boolean("ai_drafted").notNull().default(false),
  updatedBy: varchar("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("obs_vpat_entries_tenant_idx").on(t.tenantDomain),
  versionIdx: index("obs_vpat_entries_version_idx").on(t.versionId),
  uniqueEntry: uniqueIndex("obs_vpat_entries_version_control_idx").on(t.versionId, t.controlRef),
}));

// ── Performance scan history ────────────────────────────────────────────────
export const OBS_PERF_SCAN_STATUSES = ["running", "completed", "failed"] as const;

export const obsPerformanceScans = pgTable("obs_performance_scans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantDomain: text("tenant_domain").notNull(),
  assessmentId: varchar("assessment_id").notNull().references(() => obsAssessments.id, { onDelete: "cascade" }),
  applicationId: varchar("application_id").notNull().references(() => obsApplications.id, { onDelete: "cascade" }),
  /** URL actually scanned (resolved from application.appUrl at scan time). */
  scanUrl: text("scan_url").notNull(),
  status: text("status").notNull().default("running"), // OBS_PERF_SCAN_STATUSES
  /** Time to First Byte in milliseconds. */
  ttfbMs: integer("ttfb_ms"),
  /** Page load event time from navigation start, in milliseconds. */
  loadTimeMs: integer("load_time_ms"),
  /** Largest Contentful Paint in milliseconds. */
  lcpMs: integer("lcp_ms"),
  /** Cumulative Layout Shift score (multiplied by 10000 and stored as integer for precision). */
  clsScore: real("cls_score"),
  /** Time to Interactive approximation in milliseconds. */
  ttiMs: integer("tti_ms"),
  /** SLA config used for this scan (snapshot of thresholds at scan time). */
  slaConfig: jsonb("sla_config"),
  /** Number of SLA-breach findings created. */
  findingCount: integer("finding_count").notNull().default(0),
  /** Error message if status=failed. */
  scanError: text("scan_error"),
  /** Warnings recorded during measurement (non-fatal). */
  warnings: jsonb("warnings").default(sql`'[]'::jsonb`),
  /** ISO timestamp when the headless measurement was taken. */
  scannedAt: timestamp("scanned_at"),
  triggeredBy: varchar("triggered_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("obs_perf_scans_tenant_idx").on(t.tenantDomain),
  assessmentIdx: index("obs_perf_scans_assessment_idx").on(t.assessmentId, t.createdAt),
}));

// ── Insert schemas + types ──────────────────────────────────────────────────
export const insertObsReadinessScoreSchema = createInsertSchema(obsReadinessScores).omit({ id: true, computedAt: true });
export type ObsReadinessScore = typeof obsReadinessScores.$inferSelect;
export type InsertObsReadinessScore = z.infer<typeof insertObsReadinessScoreSchema>;

export const insertObsReportSchema = createInsertSchema(obsReports).omit({ id: true, createdAt: true });
export type ObsReport = typeof obsReports.$inferSelect;
export type InsertObsReport = z.infer<typeof insertObsReportSchema>;

export const insertObsVpatEntrySchema = createInsertSchema(obsVpatEntries).omit({ id: true, createdAt: true, updatedAt: true });
export type ObsVpatEntry = typeof obsVpatEntries.$inferSelect;
export type InsertObsVpatEntry = z.infer<typeof insertObsVpatEntrySchema>;

export const insertObsPerformanceScanSchema = createInsertSchema(obsPerformanceScans).omit({ id: true, createdAt: true });
export type ObsPerformanceScan = typeof obsPerformanceScans.$inferSelect;
export type InsertObsPerformanceScan = z.infer<typeof insertObsPerformanceScanSchema>;
