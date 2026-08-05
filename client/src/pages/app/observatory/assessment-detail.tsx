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
import { ArrowLeft, Plus, Loader2, Trash2, AlertTriangle, Archive, ScanLine, CheckCircle2, Clock, Gauge } from "lucide-react";
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
  application: { id: string; name: string; appUrl?: string | null; perfSlaConfig?: SlaConfig | null } | null;
  version: { id: string; versionNumber: string } | null;
  findings: { id: string; title: string; severity: string; status: string; domain: string }[];
  evidence: { id: string; title: string; evidenceType: string }[];
}

interface ScanStatus {
  status: "active" | "pending" | "not_found";
  scannable: boolean;
  progress?: { percent?: number; phase?: string };
  runningSec?: number;
  queuePosition?: number;
}

const SCANNABLE_TYPES = new Set(["accessibility", "penetration_test", "performance"]);

function ScanStatusBadge({ scanStatus }: { scanStatus: ScanStatus | undefined }) {
  if (!scanStatus || scanStatus.status === "not_found") return null;
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

  const [scanPolling, setScanPolling] = useState(false);
  const { data: scanStatus } = useQuery<ScanStatus>({
    queryKey: [scanStatusUrl],
    enabled: !!assessment && SCANNABLE_TYPES.has(assessment.type),
    refetchInterval: scanPolling ? 2000 : false,
  });

  // Start/stop polling based on job status
  useEffect(() => {
    if (!scanStatus) return;
    const running = scanStatus.status === "active" || scanStatus.status === "pending";
    setScanPolling(running);
    // When scan finishes (transitions from running → not_found), reload findings
    if (!running && scanPolling) {
      queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/observatory") });
      toast({ title: "Scan complete", description: "Findings have been updated." });
    }
  }, [scanStatus?.status]);

  const triggerScan = useMutation({
    mutationFn: async () => (await apiRequest("POST", scanTriggerUrl, {})).json(),
    onSuccess: () => {
      setScanPolling(true);
      queryClient.invalidateQueries({ queryKey: [scanStatusUrl] });
      toast({ title: "Scan queued", description: "The automated scan has been queued. Findings will appear when it completes." });
    },
    onError: (err: Error) => toast({ title: "Scan failed to start", description: err.message, variant: "destructive" }),
  });

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
                onClick={() => triggerScan.mutate()}
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

        {/* Scan intro banner — shown for scannable types with no findings yet */}
        {isScannable && assessment.findings.length === 0 && !scanRunning && (
          <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 flex items-center gap-3">
            <ScanLine className="h-5 w-5 text-primary flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">Ready to scan automatically</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Click <strong>Run scan</strong> to start a built-in {labelFor(ASSESSMENT_TYPES as any, assessment.type).toLowerCase()} scan against the application URL. Findings will be created automatically.
              </p>
            </div>
            {canWrite && (
              <Button size="sm" onClick={() => triggerScan.mutate()} disabled={triggerScan.isPending}>
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
              {scanRunning && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> Scan in progress…
                </span>
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
                scanSchedule={assessment.scanSchedule ?? "disabled"}
                canWrite={canWrite}
              />
            </CardContent>
          </Card>
        )}
      </div>

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
