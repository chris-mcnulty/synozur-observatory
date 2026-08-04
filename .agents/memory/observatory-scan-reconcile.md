---
name: Observatory scan reconcile semantics
description: How automated scans must merge with existing findings (general runner + pen-test path)
---
Both scan paths (general `observatory-scan-runner.ts` and pen-test route) reconcile instead of accrete:

- Match existing findings by `scanRuleId|affectedComponent`, fallback `title|affectedComponent` for legacy rows (backfill scanRuleId on match). Consume each existing row at most once per run.
- Matched rows: refresh description/severity/metadata but NEVER change status — remediated/accepted_risk/false_positive/in_progress are human decisions.
- Auto-resolve (status=remediated + resolvedAt) only rows that are scanner-created (scanRuleId != null), still `open`, and unmatched by the current scan.
- **Failed-scan guard:** the security scanner returns a synthetic `target-unreachable` finding instead of throwing; auto-resolution must be skipped when it appears, or a transient outage mass-closes real findings. Accessibility/performance scanners throw on unreachable targets.
- Associations (obsPenTestFindings junction, obsFindingEvidence, obsReviewItemFindings) must be inserted idempotently for BOTH inserted and matched findings so legacy rows get repaired.

**Why:** re-scans previously duplicated findings (dedup key mismatch: null affectedComponent) and re-opened human-remediated rows; manual findings must never be auto-closed.
**How to apply:** any new scanner or scan-ingest path must follow this contract; findings it creates must set scanRuleId.

## Production scan hangs (Autoscale)
Accessibility scans in the published app (Autoscale) always die with "Timed out after 300s" — headless-Chromium background jobs get throttled CPU outside request handling; the target site itself is fast. `scheduled_job_runs` (query prod read-only) is the ground truth for scan job outcomes; scan-status polling is in-memory only and lies after instance recycles. Scan failures must restore assessment status (runner now restores prior status) or assessments stay "in_progress" forever. Real fix likely = Reserved VM deployment.
