-- Add source_pages column to obs_findings so the accessibility scanner can
-- record every page URL where a violation was detected in a multi-page scan.
-- Stored as a JSON text array, e.g. '["https://example.com/","https://example.com/about"]'.
DO $$ BEGIN
  ALTER TABLE "obs_findings" ADD COLUMN "source_pages" text;
EXCEPTION
  WHEN duplicate_column THEN null;
END $$;
