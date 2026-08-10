import { useState, useEffect } from "react";
import { useParams, Link, useLocation } from "wouter";
import AppLayout from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useUser } from "@/lib/userContext";
import { ArrowLeft, Plus, Loader2, Trash2, AlertTriangle, Archive, ScanLine, CheckCircle2, Clock, Gauge, Download, History } from "lucide-react";
import {
  AssessmentStatusBadge,
  SeverityBadge,
  FindingStatusBadge,
  ASSESSMENT_TYPES,
  ASSESSMENT_STATUSES,
  FINDING_SEVERITIES,
  FINDING_DOMAINS,
  labelFor,
} from "./shared";
import { formatDate } from "@/lib/utils";
import PerformanceScanPanel from "./performance-scan";

interface Detail {
  id: string;

  title: string;

  type: string;

  status: string;

  assessorName: string | null;

  team: string | null;

  startDate: string | null;

  endDate: string | null;

  overallScore: number | null;

  executiveSummary: string | null;

  scope: string | null;

  outOfScope: string | null;

  applicationId: string;
  /** Automated scan cadence — only relevant for performance assessments. */

  scanSchedule: "daily" | "weekly" | "disabled";

  application: { id: string; name: string; appUrl?: string | null; perfSlaConfig?: SlaConfig | null; perfExtraUrls?: string[] | null } | null;

  version: { id: string; versionNumber: string } | null;

  findings: { id: string; title: string; severity: string; status: string; domain: string }[];

  evidence: { id: string; title: string; evidenceType: string }[];
}

interface ScanStatus {
  status: "active" | "pending" | "not_found" | "failed";
  scannable: boolean;
  progress?: { percent?: number; phase?: string };
  runningSec?: number;
  queuePosition?: number;
  errorMessage?: string;
  /** True when the last accessibility scan stopped early due to the time budget. */
  partial?: boolean;
  scannedPages?: number;
  discoveredPages?: number;
  /** The effective pageLimit used in the last scan — persisted server-side in the scan report. */
  pageLimit?: number;
}

const SCANNABLE_TYPES = new Set(["accessibility", "penetration_test", "performance"]);

interface ScanHistoryRow {
  id: string;
  tool: string;
  findingsNew: number;
  findingsResolved: number;
  findingsUnchanged: number;
  openCritical: number;
  openHigh: number;
  openMedium: number;
  openLow: number;
  openInfo: number;
  scannedPages: number | null;
  discoveredPages: number | null;
  partial: boolean;
  createdAt: string;
}

function ScanStatusBadge({ scanStatus }: { scanStatus: ScanStatus | undefined }) {
  if (!scanStatus || scanStatus.status === "not_found") return null;
  if (scanStatus.status === "failed") {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertTriangle className="h-3 w-3" /> Scan failed
      </Badge>
    );
  }
  if (scanStatus.status === "pending") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Clock className="h-3 w-3" /> Scan queued{scanStatus.queuePosition ? ` (#${scanStatus.queuePosition})` : ""}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1 text-primary">
      <Loader2 className="h-3 w-3 animate-spin" />
      {scanStatus.progress?.phase ?? "Scanning…"}
      {scanStatus.runningSec ? ` (${scanStatus.runningSec}s)` : ""}
    </Badge>
  );
}

export default function ObservatoryAssessmentDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { user } = useUser();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = ["Analyst", "Domain Admin", "Global Admin"].includes(user?.role ?? "");

  const { data: assessment, isLoading } = useQuery<Detail>({ queryKey: [`/api/observatory/assessments/${id}`] });
  const { data: scanHistory } = useQuery<ScanHistoryRow[]>({ queryKey: [`/api/observatory/assessments/${id}/scan-history`] });
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);

  const exportFixList = async (format: "csv" | "pdf") => {
    setExporting(format);
    try {
      const res = await fetch(`/api/observatory/assessments/${id}/findings/export.${format}`, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Export failed" }));
        toast({ title: "Export failed", description: err.message ?? "Could not generate the export.", variant: "destructive" });
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="([^"]+)"/);
      const a = document.createElement("a");
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = match ? match[1] : `fix-list.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({ title: "Export failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setExporting(null);
    }
  };

  // ── Scan status polling ──────────────────────────────────────────────────
  // Performance assessments use a dedicated scan endpoint with its own status
  // URL so saved SLA config and scan history are always applied correctly.
  const isPerformanceType = !!assessment && assessment.type === "performance";
  const scanStatusUrl = isPerformanceType
    ? `/api/observatory/assessments/${id}/performance-scan/status`
    : `/api/observatory/assessments/${id}/scan-status`;
  const scanTriggerUrl = isPerformanceType
    ? `/api/observatory/assessments/${id}/performance-scan`
    : `/api/observatory/assessments/${id}/scan`;

  // Accessibility scan options dialog
  const isAccessibilityType = !!assessment && assessment.type === "accessibility";
  const [scanDialogOpen, setScanDialogOpen] = useState(false);
  const [pageLimit, setPageLimit] = useState(10);

  // Track whether we were polling so we can detect scan completion/failure transitions
  const [scanPolling, setScanPolling] = useState(false);
  const { data: scanStatus } = useQuery<ScanStatus>({
    queryKey: [scanStatusUrl],
    enabled: !!assessment && SCANNABLE_TYPES.has(assessment.type),
    // Back off the poll interval as the scan runs longer to avoid hammering the endpoint
    refetchInterval: (query) => {
      const s = (query.state.data as ScanStatus | undefined)?.status;
      if (s !== "active" && s !== "pending") return false;
      const runningSec = (query.state.data as ScanStatus | undefined)?.runningSec ?? 0;
      if (runningSec > 60) return 10000;
      if (runningSec > 30) return 5000;
      return 2000;
    },
  });

  // Detect transitions: running → completed or running → failed
  useEffect(() => {
    if (!scanStatus) return;
    const running = scanStatus.status === "active" || scanStatus.status === "pending";
    if (!running && scanPolling) {
      queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/observatory") });
      if (scanStatus.status === "failed") {
        toast({
          title: "Scan failed",
          description: scanStatus.errorMessage ?? "The scan encountered an error. Please try again.",
          variant: "destructive",
        });
      } else {
        toast({ title: "Scan complete", description: "Findings have been updated." });
      }
    }
    setScanPolling(running);
  }, [scanStatus?.status]);

  const triggerScan = useMutation({
    mutationFn: async (opts?: { pageLimit?: number }) =>
      (await apiRequest("POST", scanTriggerUrl, opts?.pageLimit != null ? { pageLimit: opts.pageLimit } : {})).json(),
    onSuccess: () => {
      setScanPolling(true);
      queryClient.invalidateQueries({ queryKey: [scanStatusUrl] });
      toast({ title: "Scan queued", description: "The automated scan has been queued. Findings will appear when it completes." });
    },
    onError: (err: Error) => toast({ title: "Scan failed to start", description: err.message, variant: "destructive" }),
  });

  /** For accessibility assessments open the options dialog; for other types trigger directly. */
  function handleRunScan() {
    if (isAccessibilityType) {
      setScanDialogOpen(true);
    } else {
      triggerScan.mutate({});
    }
  }

  const [findingDialogOpen, setFindingDialogOpen] = useState(false);
  const [findingForm, setFindingForm] = useState({
    title: "",
    description: "",
    severity: "Medium",
    domain: "accessibility",
    recommendation: "",
    affectedComponent: "",
    wcagCriterion: "",
    cweId: "",
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/observatory") });

  const statusMutation = useMutation({
    mutationFn: async (status: string) => (await apiRequest("PATCH", `/api/observatory/assessments/${id}`, { status })).json(),
    onSuccess: () => {
      invalidate();
      toast({ title: "Status updated" });
    },
    onError: (err: Error) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });

  const createFinding = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", "/api/observatory/findings", {
          assessmentId: id,
          title: findingForm.title,
          description: findingForm.description || null,
          severity: findingForm.severity,
          domain: findingForm.domain,
          recommendation: findingForm.recommendation || null,
          affectedComponent: findingForm.affectedComponent || null,
          wcagCriterion: findingForm.wcagCriterion || null,
          cweId: findingForm.cweId || null,
          status: "open",
        })
      ).json(),
    onSuccess: () => {
      invalidate();
      setFindingDialogOpen(false);
      setFindingForm({ title: "", description: "", severity: "Medium", domain: "accessibility", recommendation: "", affectedComponent: "", wcagCriterion: "", cweId: "" });
      toast({ title: "Finding recorded" });
    },
    onError: (err: Error) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const deleteAssessment = useMutation({
    mutationFn: async () => (await apiRequest("DELETE", `/api/observatory/assessments/${id}`)).json(),
    onSuccess: () => {
      invalidate();
      toast({ title: "Assessment deleted" });
      navigate("/app/observatory/assessments");
    },
    onError: (err: Error) => toast({ title: "Delete failed", description: err.message, variant: "destructive" }),
  });

  if (isLoading || !assessment) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      </AppLayout>
    );
  }

  const scanRunning = scanStatus?.status === "active" || scanStatus?.status === "pending";
  const isScannable = SCANNABLE_TYPES.has(assessment.type);

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <Link href="/app/observatory/assessments">
              <Button variant="ghost" size="sm" className="mb-2 -ml-2" data-testid="button-back-assessments">
                <ArrowLeft className="h-4 w-4 mr-1" /> Assessments
              </Button>
            </Link>
            <h1 className="text-2xl font-semibold" data-testid="text-assessment-title">{assessment.title}</h1>
            <p className="text-muted-foreground text-sm mt-1">
              {assessment.application && (
                <Link href={`/app/observatory/applications/${assessment.application.id}`} className="hover:underline" data-testid="link-assessment-application">
                  {assessment.application.name}
                </Link>
              )}
              {assessment.version ? ` · v${assessment.version.versionNumber}` : ""} · {labelFor(ASSESSMENT_TYPES as any, assessment.type)}
              {assessment.assessorName ? ` · ${assessment.assessorName}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Scan status badge */}
            <ScanStatusBadge scanStatus={scanStatus} />

            {/* Run Scan button — only for scannable assessment types */}
            {canWrite && isScannable && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRunScan}
                disabled={scanRunning || triggerScan.isPending}
                data-testid="button-run-scan"
              >
                {scanRunning ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <ScanLine className="h-4 w-4 mr-1" />
                )}
                {scanRunning ? "Scanning…" : "Run scan"}
              </Button>
            )}

            {canWrite ? (
              <Select value={assessment.status} onValueChange={(v) => statusMutation.mutate(v)}>
                <SelectTrigger className="w-[160px]" data-testid="select-assessment-status-change"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ASSESSMENT_STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <AssessmentStatusBadge status={assessment.status} />
            )}
            {canWrite && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="icon" data-testid="button-delete-assessment"><Trash2 className="h-4 w-4" /></Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this assessment?</AlertDialogTitle>
                    <AlertDialogDescription>This removes the assessment and all of its findings. Evidence remains in the vault.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => deleteAssessment.mutate()} data-testid="button-confirm-delete-assessment">Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>

        {/* Scan error banner — shown when the scan fails or the job is lost */}
        {isScannable && scanStatus?.status === "failed" && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 flex items-center gap-3" data-testid="card-scan-error">
            <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-destructive">Scan failed</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {scanStatus.errorMessage ?? "The scan encountered an error. Please try again."}
              </p>
            </div>
            {canWrite && (
              <Button size="sm" variant="outline" onClick={handleRunScan} disabled={triggerScan.isPending}>
                <ScanLine className="h-4 w-4 mr-1" /> Re-scan
              </Button>
            )}
          </div>
        )}

        {/* Partial-scan notice — shown when an accessibility scan stopped early */}
        {assessment.type === "accessibility" && scanStatus?.partial && !scanRunning && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 flex items-center gap-3" data-testid="card-partial-scan-warning">
            <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-amber-600 dark:text-amber-400">Partial scan — not all pages were covered</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Scanned {scanStatus.scannedPages} of {scanStatus.discoveredPages} discovered pages
                {scanStatus.pageLimit != null ? ` (limit: ${scanStatus.pageLimit})` : ""}.
                Increase the page limit and re-scan to cover more of the site.
              </p>
            </div>
            {canWrite && (
              <Button size="sm" variant="outline" onClick={handleRunScan} disabled={triggerScan.isPending}>
                <ScanLine className="h-4 w-4 mr-1" /> Re-scan
              </Button>
            )}
          </div>
        )}

        {/* Scan intro banner — shown for scannable types with no findings yet */}
        {isScannable && assessment.findings.length === 0 && !scanRunning && scanStatus?.status !== "failed" && (
          <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 flex items-center gap-3">
            <ScanLine className="h-5 w-5 text-primary flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">Ready to scan automatically</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Click <strong>Run scan</strong> to start a built-in {labelFor(ASSESSMENT_TYPES as any, assessment.type).toLowerCase()} scan against the application URL. Findings will be created automatically.
              </p>
            </div>
            {canWrite && (
              <Button size="sm" onClick={handleRunScan} disabled={triggerScan.isPending}>
                <ScanLine className="h-4 w-4 mr-1" /> Run scan
              </Button>
            )}
          </div>
        )}

        <div className="grid md:grid-cols-3 gap-4">
          <Card className="md:col-span-2">
            <CardHeader><CardTitle className="text-base">Scope</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {assessment.scope ? <p data-testid="text-assessment-scope">{assessment.scope}</p> : <p className="text-muted-foreground">No scope documented.</p>}
              {assessment.outOfScope && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Out of scope</p>
                  <p>{assessment.outOfScope}</p>
                </div>
              )}
              {assessment.executiveSummary && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Executive summary</p>
                  <p data-testid="text-assessment-summary">{assessment.executiveSummary}</p>
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">Details</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {assessment.team && <p><span className="text-muted-foreground">Team:</span> {assessment.team}</p>}
              {assessment.startDate && <p><span className="text-muted-foreground">Started:</span> {formatDate(assessment.startDate)}</p>}
              {assessment.endDate && <p><span className="text-muted-foreground">Ended:</span> {formatDate(assessment.endDate)}</p>}
              {assessment.overallScore != null && (
                <p data-testid="text-assessment-score"><span className="text-muted-foreground">Overall score:</span> {assessment.overallScore}/100</p>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Findings ({assessment.findings.length})</CardTitle>
            <div className="flex items-center gap-2">
              {assessment.findings.length > 0 && (
                <Link
                  href={`/app/observatory/findings?assessmentId=${assessment.id}`}
                  className="text-xs text-primary hover:underline mr-1"
                  data-testid="link-findings-filtered"
                >
                  Open in Findings
                </Link>
              )}
              {scanRunning && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> Scan in progress…
                </span>
              )}
              {assessment.findings.length > 0 && (
                <>
                  <Button size="sm" variant="outline" onClick={() => exportFixList("csv")} disabled={exporting !== null} data-testid="button-export-fixlist-csv">
                    {exporting === "csv" ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />} CSV
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => exportFixList("pdf")} disabled={exporting !== null} data-testid="button-export-fixlist-pdf">
                    {exporting === "pdf" ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />} PDF
                  </Button>
                </>
              )}
              {canWrite && (
                <Button size="sm" onClick={() => setFindingDialogOpen(true)} data-testid="button-new-finding">
                  <Plus className="h-4 w-4 mr-1" /> New Finding
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {assessment.findings.length === 0 ? (
              <p className="text-sm text-muted-foreground">No findings recorded for this assessment.</p>
            ) : (
              <div className="space-y-2">
                {assessment.findings.map((f) => (
                  <Link key={f.id} href={`/app/observatory/findings/${f.id}`}>
                    <div className="flex items-center justify-between gap-3 border border-border rounded-md px-3 py-2 cursor-pointer hover:border-primary/50" data-testid={`row-finding-${f.id}`}>
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">{f.title}</p>
                        <p className="text-xs text-muted-foreground">{labelFor(FINDING_DOMAINS as any, f.domain)}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <SeverityBadge severity={f.severity} />
                        <FindingStatusBadge status={f.status} />
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><Archive className="h-4 w-4" /> Evidence ({assessment.evidence.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {assessment.evidence.length === 0 ? (
              <p className="text-sm text-muted-foreground">No evidence linked. Add evidence from the Evidence Vault and link it to this assessment.</p>
            ) : (
              <div className="space-y-2">
                {assessment.evidence.map((e) => (
                  <Link key={e.id} href={`/app/observatory/evidence/${e.id}`}>
                    <div className="flex items-center justify-between gap-3 border border-border rounded-md px-3 py-2 cursor-pointer hover:border-primary/50" data-testid={`row-evidence-${e.id}`}>
                      <p className="font-medium text-sm truncate">{e.title}</p>
                      <Badge variant="secondary" className="text-xs shrink-0">{e.evidenceType.replace(/_/g, " ")}</Badge>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {scanHistory && scanHistory.length > 0 && (
          <Card data-testid="card-scan-history">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <History className="h-4 w-4" /> Scan History ({scanHistory.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground mb-3">
                Each scan is compared to the previous one: findings no longer detected are marked fixed automatically, new issues are added, and everything else stays open.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border">
                      <th className="text-left py-2 pr-3 font-medium">Date</th>
                      <th className="text-right py-2 px-2 font-medium">Pages</th>
                      <th className="text-right py-2 px-2 font-medium">New</th>
                      <th className="text-right py-2 px-2 font-medium">Fixed</th>
                      <th className="text-right py-2 px-2 font-medium">Unchanged</th>
                      <th className="text-right py-2 pl-2 font-medium">Open (C / H / M / L)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scanHistory.map((h) => {
                      const totalOpen = h.openCritical + h.openHigh + h.openMedium + h.openLow + h.openInfo;
                      return (
                        <tr key={h.id} className="border-b border-border/50" data-testid={`row-scan-history-${h.id}`}>
                          <td className="py-2 pr-3 whitespace-nowrap">
                            {formatDate(h.createdAt)}
                            {h.partial && <Badge variant="outline" className="ml-2 text-[10px] border-amber-500/50 text-amber-600 dark:text-amber-400">partial</Badge>}
                          </td>
                          <td className="py-2 px-2 text-right text-muted-foreground">
                            {h.scannedPages != null ? `${h.scannedPages}${h.discoveredPages != null && h.discoveredPages !== h.scannedPages ? `/${h.discoveredPages}` : ""}` : "—"}
                          </td>
                          <td className={`py-2 px-2 text-right ${h.findingsNew > 0 ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                            {h.findingsNew > 0 ? `+${h.findingsNew}` : "0"}
                          </td>
                          <td className={`py-2 px-2 text-right ${h.findingsResolved > 0 ? "text-green-600 dark:text-green-400 font-medium" : "text-muted-foreground"}`}>
                            {h.findingsResolved > 0 ? `−${h.findingsResolved}` : "0"}
                          </td>
                          <td className="py-2 px-2 text-right text-muted-foreground">{h.findingsUnchanged}</td>
                          <td className="py-2 pl-2 text-right whitespace-nowrap">
                            <span className="font-medium">{totalOpen}</span>
                            <span className="text-xs text-muted-foreground ml-1">({h.openCritical} / {h.openHigh} / {h.openMedium} / {h.openLow})</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {assessment.type === "performance" && assessment.application && (
          <Card data-testid="card-performance-scan">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Gauge className="h-4 w-4" /> Performance Scans
              </CardTitle>
            </CardHeader>
            <CardContent>
              <PerformanceScanPanel
                assessmentId={assessment.id}
                applicationId={assessment.application.id}
                applicationSlaConfig={assessment.application.perfSlaConfig ?? null}
                applicationExtraUrls={assessment.application.perfExtraUrls ?? []}
                scanSchedule={assessment.scanSchedule ?? "disabled"}
                canWrite={canWrite}
              />
            </CardContent>
          </Card>
        )}
      </div>

      {/* Accessibility scan options dialog */}
      <Dialog open={scanDialogOpen && isAccessibilityType} onOpenChange={setScanDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Run Accessibility Scan</DialogTitle>
            <DialogDescription>
              Choose how many pages to crawl. Higher limits improve coverage but take longer.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-2">
              <Label htmlFor="page-limit-select">Page limit</Label>
              <Select value={String(pageLimit)} onValueChange={(v) => setPageLimit(Number(v))}>
                <SelectTrigger id="page-limit-select" data-testid="select-page-limit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 5, 10, 15, 20, 25].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} {n === 1 ? "page" : "pages"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Default: 10 pages. Maximum: 25 pages per scan.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setScanDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setScanDialogOpen(false);
                triggerScan.mutate({ pageLimit });
              }}
              disabled={triggerScan.isPending}
              data-testid="button-confirm-run-scan"
            >
              <ScanLine className="h-4 w-4 mr-1" /> Start scan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={findingDialogOpen} onOpenChange={setFindingDialogOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Finding</DialogTitle>
            <DialogDescription>Record a finding against this assessment.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Title *</Label>
              <Input value={findingForm.title} onChange={(e) => setFindingForm({ ...findingForm, title: e.target.value })} data-testid="input-finding-title" />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea rows={3} value={findingForm.description} onChange={(e) => setFindingForm({ ...findingForm, description: e.target.value })} data-testid="input-finding-description" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Severity *</Label>
                <Select value={findingForm.severity} onValueChange={(v) => setFindingForm({ ...findingForm, severity: v })}>
                  <SelectTrigger data-testid="select-finding-severity"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FINDING_SEVERITIES.map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Domain *</Label>
                <Select value={findingForm.domain} onValueChange={(v) => setFindingForm({ ...findingForm, domain: v })}>
                  <SelectTrigger data-testid="select-finding-domain"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FINDING_DOMAINS.map((d) => (
                      <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Recommendation</Label>
              <Textarea rows={2} value={findingForm.recommendation} onChange={(e) => setFindingForm({ ...findingForm, recommendation: e.target.value })} data-testid="input-finding-recommendation" />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Component</Label>
                <Input value={findingForm.affectedComponent} onChange={(e) => setFindingForm({ ...findingForm, affectedComponent: e.target.value })} data-testid="input-finding-component" />
              </div>
              <div className="space-y-2">
                <Label>WCAG criterion</Label>
                <Input placeholder="e.g. 1.4.3" value={findingForm.wcagCriterion} onChange={(e) => setFindingForm({ ...findingForm, wcagCriterion: e.target.value })} data-testid="input-finding-wcag" />
              </div>
              <div className="space-y-2">
                <Label>CWE</Label>
                <Input placeholder="e.g. CWE-639" value={findingForm.cweId} onChange={(e) => setFindingForm({ ...findingForm, cweId: e.target.value })} data-testid="input-finding-cwe" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFindingDialogOpen(false)} data-testid="button-cancel-finding">Cancel</Button>
            <Button onClick={() => createFinding.mutate()} disabled={!findingForm.title.trim() || createFinding.isPending} data-testid="button-save-finding">
              {createFinding.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Record finding
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}


interface SlaConfig {
  ttfbMs: number;
  loadTimeMs: number;
  lcpMs: number;
  clsScore: number;
  ttiMs: number;
}
