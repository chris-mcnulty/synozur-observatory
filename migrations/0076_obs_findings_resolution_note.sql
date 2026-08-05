-- Add resolution_note to obs_findings so automated re-scans can stamp why a
-- finding was machine-resolved (distinct from a human marking it remediated).
ALTER TABLE obs_findings ADD COLUMN IF NOT EXISTS resolution_note text;
