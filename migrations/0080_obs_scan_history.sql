-- Scan history: one row per completed automated scan run, powering
-- scan-over-scan comparisons (new / fixed / still-open + open counts by severity).
CREATE TABLE IF NOT EXISTS "obs_scan_history" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_domain" text NOT NULL,
  "assessment_id" varchar NOT NULL REFERENCES "obs_assessments"("id") ON DELETE CASCADE,
  "application_id" varchar NOT NULL REFERENCES "obs_applications"("id") ON DELETE CASCADE,
  "tool" text NOT NULL,
  "findings_new" integer NOT NULL DEFAULT 0,
  "findings_resolved" integer NOT NULL DEFAULT 0,
  "findings_unchanged" integer NOT NULL DEFAULT 0,
  "open_critical" integer NOT NULL DEFAULT 0,
  "open_high" integer NOT NULL DEFAULT 0,
  "open_medium" integer NOT NULL DEFAULT 0,
  "open_low" integer NOT NULL DEFAULT 0,
  "open_info" integer NOT NULL DEFAULT 0,
  "scanned_pages" integer,
  "discovered_pages" integer,
  "partial" boolean NOT NULL DEFAULT false,
  "duration_ms" integer,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "obs_scan_history_tenant_idx" ON "obs_scan_history" ("tenant_domain");
CREATE INDEX IF NOT EXISTS "obs_scan_history_assessment_idx" ON "obs_scan_history" ("assessment_id");
