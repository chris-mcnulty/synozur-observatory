-- Add backlink_finding flag to obs_pen_test_findings.
-- Rows created by the relink-findings backfill endpoint have this set to TRUE;
-- rows created normally (pen test UI, scan runner) keep the default FALSE.
-- The pen test deletion route skips explicitly deleting obs_findings rows for
-- backlinked findings so they remain in the shared register after the pen test
-- is removed.
ALTER TABLE obs_pen_test_findings
  ADD COLUMN IF NOT EXISTS backlink_finding boolean NOT NULL DEFAULT false;
