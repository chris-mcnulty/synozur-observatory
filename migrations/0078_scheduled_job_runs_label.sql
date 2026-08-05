-- Add job_label to scheduled_job_runs so scan-status fallback queries can be
-- scoped to the exact job label (e.g. "scan:accessibility:asmnt-1") rather
-- than relying on targetId alone, which is shared across multiple job kinds.
ALTER TABLE scheduled_job_runs ADD COLUMN IF NOT EXISTS job_label text;
CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_job_label ON scheduled_job_runs(job_label);
