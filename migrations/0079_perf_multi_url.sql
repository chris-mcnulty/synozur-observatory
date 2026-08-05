-- Add perf_extra_urls column to obs_applications so tenants can configure
-- additional pages to include in every performance scan beyond the primary appUrl.
DO $$ BEGIN
  ALTER TABLE obs_applications ADD COLUMN perf_extra_urls text[];
EXCEPTION
  WHEN duplicate_column THEN null;
END $$;

-- Per-URL results table: one row per URL per scan batch.
-- The parent obs_performance_scans row is the "batch" (overall status,
-- triggered_by, slaConfig, aggregate findingCount); this table holds the
-- per-page metrics and pass/fail so the history table can show a row per URL.
CREATE TABLE IF NOT EXISTS obs_performance_scan_pages (
  id              varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  tenant_domain   text    NOT NULL,
  scan_id         varchar NOT NULL,
  scan_url        text    NOT NULL,
  status          text    NOT NULL DEFAULT 'running',
  ttfb_ms         integer,
  load_time_ms    integer,
  lcp_ms          integer,
  cls_score       real,
  tti_ms          integer,
  finding_count   integer NOT NULL DEFAULT 0,
  scan_error      text,
  warnings        jsonb   DEFAULT '[]'::jsonb,
  scanned_at      timestamp,
  created_at      timestamp NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE obs_performance_scan_pages
    ADD CONSTRAINT obs_perf_scan_pages_scan_id_fk
    FOREIGN KEY (scan_id) REFERENCES obs_performance_scans(id) ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS obs_perf_scan_pages_scan_idx
  ON obs_performance_scan_pages (scan_id);
CREATE INDEX IF NOT EXISTS obs_perf_scan_pages_assessment_idx
  ON obs_performance_scan_pages (tenant_domain, scan_id);
