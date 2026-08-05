/**
 * Observatory — extensibility interfaces for future scanner and repository
 * integrations.
 *
 * ⚠️ DESIGN-ONLY (V1): nothing in this file is implemented or wired up yet.
 * These interfaces document the contract that future automated-assessment
 * providers must satisfy so that scanner output flows into the existing
 * Observatory traceability model (assessment → finding → evidence) without
 * schema changes.
 *
 * Intended future providers:
 *  - Accessibility: axe-core / Pa11y / Lighthouse (via the existing headless
 *    crawler in `server/services/headless-crawler.ts`)
 *  - SAST: CodeQL, Semgrep
 *  - Dependency/SCA: npm audit, OSV, Dependabot alerts (via GitHub)
 *  - DAST: OWASP ZAP
 *  - Repo metadata: GitHub / Azure DevOps
 *
 * Execution model: a scan run should be enqueued on the central job queue
 * (`server/services/job-queue.ts`) — scans are long-running and must not block
 * request handlers. The job handler calls `runScan()`, then maps
 * `ScannerFinding` rows into `obs_findings` (deduplicating via `ruleId` +
 * `location`) and stores the raw report as `obs_evidence` (evidenceType
 * "scan_report") linked to the assessment.
 */

/** A normalized finding produced by any scanner provider. */
export interface ScannerFinding {
  /** Stable rule identifier from the tool, e.g. "color-contrast", "js/sql-injection". */
  ruleId: string;
  title: string;
  description?: string;
  /** Normalized to Observatory severities: Critical | High | Medium | Low | Informational. */
  severity: string;
  /** Standards mapping when the tool provides one. */
  wcagCriterion?: string;
  cweId?: string;
  /** Where the issue was found — a URL/selector for page scans, a file path for code scans. */
  location?: {
    url?: string;
    selector?: string;
    file?: string;
    line?: number;
  };
  /** Raw tool payload for evidence/debugging. */
  raw?: unknown;
}

/** Parameters for a single scan run. */
export interface ScanRequest {
  tenantDomain: string;
  applicationId: string;
  assessmentId: string;
  /** Target: URL for page scanners, repo ref for code scanners. */
  target: {
    url?: string;
    repositoryUrl?: string;
    branch?: string;
    commitHash?: string;
  };
  /** Provider-specific options (rulesets, depth, auth, etc.). */
  options?: Record<string, unknown>;
  /** Job-queue AbortSignal — propagate to long-running I/O so cancelled jobs release resources promptly. */
  signal?: AbortSignal;
}

export interface ScanResult {
  findings: ScannerFinding[];
  /** Raw report to persist as scan_report evidence. */
  rawReport?: { contentType: string; body: string };
  /** Tool + version for provenance, e.g. "axe-core@4.9". */
  tool: string;
  startedAt: Date;
  finishedAt: Date;
}

/**
 * Contract for an automated scanner (accessibility, SAST, SCA, DAST).
 * Implementations must be stateless; credentials come from tenant settings.
 */
export interface ScannerProvider {
  /** Stable key, e.g. "axe_core", "codeql", "semgrep", "zap". */
  readonly key: string;
  /** Human-readable name for settings UIs. */
  readonly name: string;
  /** Which assessment types this provider can serve, e.g. ["accessibility"]. */
  readonly assessmentTypes: string[];
  /**
   * Optional: the complete set of ruleIds this provider can ever produce.
   * When set, the scan-runner's auto-resolve step is scoped to only findings
   * in this namespace, preventing cross-path interference when the same
   * assessment type has multiple entry points (e.g. the dedicated
   * /performance-scan SLA route vs the general /scan provider path).
   */
  readonly ownedRuleIds?: readonly string[];
  /** Cheap availability probe (credentials present, endpoint reachable). */
  isAvailable(tenantDomain: string): Promise<boolean>;
  /** Execute one scan. Called from a job-queue handler, never inline. */
  runScan(request: ScanRequest): Promise<ScanResult>;
}

/**
 * Contract for a source-repository provider (GitHub, Azure DevOps) used to
 * enrich source-code reviews: resolve branches/commits, deep-link findings to
 * files/lines, and pull dependency or code-scanning alerts.
 */
export interface RepoProvider {
  /** Stable key, e.g. "github", "azure_devops". */
  readonly key: string;
  readonly name: string;
  isAvailable(tenantDomain: string): Promise<boolean>;
  /** List branches for a repository URL. */
  listBranches(tenantDomain: string, repositoryUrl: string): Promise<string[]>;
  /** Resolve the head commit of a branch. */
  resolveCommit(tenantDomain: string, repositoryUrl: string, branch: string): Promise<string | null>;
  /** Build a permalink to a file/line at a commit (for finding deep-links). */
  fileLink(repositoryUrl: string, commitHash: string, file: string, line?: number): string;
  /** Pull the tool's own findings (e.g. GitHub code scanning alerts), normalized. */
  fetchAlerts?(tenantDomain: string, repositoryUrl: string): Promise<ScannerFinding[]>;
}

/**
 * Registry of concrete scanner providers. Each provider is registered at
 * module load time and looked up by key in the scan runner.
 */
export const scannerProviders: Record<string, ScannerProvider> = {};
export const repoProviders: Record<string, RepoProvider> = {};

/** Register a scanner provider. Called from each scanner module at init. */
export function registerScanner(provider: ScannerProvider): void {
  scannerProviders[provider.key] = provider;
  console.log(`[Observatory] Registered scanner: ${provider.name} (types: ${provider.assessmentTypes.join(", ")})`);
}

/** Find the first available scanner for a given assessment type. */
export async function findScannerForType(
  assessmentType: string,
  tenantDomain: string,
): Promise<ScannerProvider | null> {
  for (const provider of Object.values(scannerProviders)) {
    if (
      provider.assessmentTypes.includes(assessmentType) &&
      (await provider.isAvailable(tenantDomain).catch(() => false))
    ) {
      return provider;
    }
  }
  return null;
}
