-- Observatory performance scan scheduling
-- Adds per-assessment scan cadence (daily/weekly/disabled) and scan source tracking.

ALTER TABLE obs_assessments
  ADD COLUMN IF NOT EXISTS scan_schedule text NOT NULL DEFAULT 'disabled',
  ADD COLUMN IF NOT EXISTS last_auto_scan_at timestamp;

ALTER TABLE obs_performance_scans
  ADD COLUMN IF NOT EXISTS scan_source text NOT NULL DEFAULT 'manual';

-- Efficient scheduler sweep: find all non-disabled schedules sorted by last run
CREATE INDEX IF NOT EXISTS obs_assessments_scan_schedule_idx
  ON obs_assessments (scan_schedule, last_auto_scan_at)
  WHERE scan_schedule <> 'disabled';
