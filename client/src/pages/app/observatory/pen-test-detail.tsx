import { useState } from "react";
import AppLayout from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useUser } from "@/lib/userContext";
import { Link, useParams } from "wouter";
import { ArrowLeft, Link2, Loader2, Plus, ScanLine, Trash2 } from "lucide-react";
import {
  PEN_TEST_RESULTS,
  VALIDATION_STATUSES,
  EXPLOITABILITY_LEVELS,
  PenTestResultBadge,
  ValidationStatusBadge,
  SeverityBadge,
  FindingStatusBadge,
  severityFromCvss,
} from "./shared";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";

interface PenTestFinding {
  id: string;
  findingId: string;
  cvssScore: number | null;
  cvssVector: string | null;
  exploitability: string | null;
  validationStatus: string;
  validatedBy: string | null;
  validatedAt: string | null;
  finding: {
    id: string;
    title: string;
    severity: string;
    status: string;
    description: string | null;
    recommendation: string | null;
    cweId: string | null;
    affectedComponent: string | null;
  };
}

interface PenTestDetail {
  id: string;
  testName: string;
  firm: string | null;
  leadTester: string | null;
  methodology: string | null;
  startDate: string | null;
  endDate: string | null;
  executiveSummary: string | null;
  result: string | null;
  assessment: { id: string; title: string; status: string };
  application: { id: string; name: string };
  findings: PenTestFinding[];
}

const EMPTY_FINDING_FORM = {
  title: "",
  description: "",
  recommendation: "",
  stepsToReproduce: "",
  cweId: "",
  cvssScore: "",
  cvssVector: "",
  exploitability: "",
};

export default function ObservatoryPenTestDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useUser();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = ["Analyst", "Domain Admin", "Global Admin"].includes(user?.role ?? "");

  const [findingDialogOpen, setFindingDialogOpen] = useState(false);
  const [findingForm, setFindingForm] = useState(EMPTY_FINDING_FORM);
  const [deleteTarget, setDeleteTarget] = useState<PenTestFinding | null>(null);
  const [summaryEditing, setSummaryEditing] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [scanConfirmOpen, setScanConfirmOpen] = useState(false);

  const { data: penTest, isLoading } = useQuery<PenTestDetail>({
    queryKey: [`/api/observatory/pen-tests/${id}`],
    enabled: !!id,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/observatory") });

  const patchPenTestMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await apiRequest("PATCH", `/api/observatory/pen-tests/${id}`, body)).json(),
    onSuccess: () => {
      invalidate();
      setSummaryEditing(false);
    },
    onError: (err: Error) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });

  const createFindingMutation = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", `/api/observatory/pen-tests/${id}/findings`, {
          title: findingForm.title,
          description: findingForm.description || null,
          recommendation: findingForm.recommendation || null,
          stepsToReproduce: findingForm.stepsToReproduce || null,
          cweId: findingForm.cweId || null,
          cvssScore: findingForm.cvssScore === "" ? null : Number(findingForm.cvssScore),
          cvssVector: findingForm.cvssVector || null,
          exploitability: findingForm.exploitability || null,
        })
      ).json(),
    onSuccess: () => {
      invalidate();
      setFindingDialogOpen(false);
      setFindingForm(EMPTY_FINDING_FORM);
      toast({ title: "Finding recorded", description: "Also added to the shared findings register." });
    },
    onError: (err: Error) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const patchFindingMutation = useMutation({
    mutationFn: async ({ extId, ...body }: { extId: string } & Record<string, unknown>) =>
      (await apiRequest("PATCH", `/api/observatory/pen-test-findings/${extId}`, body)).json(),
    onSuccess: () => invalidate(),
    onError: (err: Error) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });

  const deleteFindingMutation = useMutation({
    mutationFn: async (extId: string) =>
      (await apiRequest("DELETE", `/api/observatory/pen-test-findings/${extId}`)).json(),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
      toast({ title: "Finding deleted" });
    },
    onError: (err: Error) => toast({ title: "Delete failed", description: err.message, variant: "destructive" }),
  });

  const relinkFindingsMutation = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/observatory/pen-tests/${id}/relink-findings`)).json() as Promise<{ relinked: number; message?: string }>,
    onSuccess: (data) => {
      invalidate();
      toast({
        title: data.relinked > 0 ? `${data.relinked} finding(s) recovered` : "No orphaned findings",
        description: data.relinked > 0
          ? `${data.relinked} finding(s) from the shared register have been linked to this pen test.`
          : (data.message ?? "All findings are already linked."),
      });
    },
    onError: (err: Error) => toast({ title: "Recovery failed", description: err.message, variant: "destructive" }),
  });

  const triggerScanMutation = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/observatory/pen-tests/${id}/security-scan`)).json(),
    onSuccess: (data) => {
      setScanConfirmOpen(false);
      toast({
        title: data.status === "queued" ? "Security scan started" : "Scan already running",
        description: data.status === "queued"
          ? "Findings will appear here once the scan completes (usually under a minute)."
          : "A scan is already in progress for this application.",
      });
    },
    onError: (err: Error) => {
      setScanConfirmOpen(false);
      toast({ title: "Scan failed to start", description: err.message, variant: "destructive" });
    },
  });

  // Poll scan status while a job is running so the UI updates automatically
  const { data: scanStatus } = useQuery<{ status: "active" | "pending" | "not_found"; progress?: { phase?: string } }>({
    queryKey: [`/api/observatory/pen-tests/${id}/security-scan/status`],
    enabled: !!id,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === "active" || s === "pending" ? 3000 : false;
    },
    // When a running scan transitions to not_found it has finished — refresh findings
    select: (data) => {
      if (data.status === "not_found") {
        queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).includes(`/api/observatory/pen-tests/${id}`) });
      }
      return data;
    },
  });

  const scanRunning = scanStatus?.status === "active" || scanStatus?.status === "pending";

  if (isLoading || !penTest) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      </AppLayout>
    );
  }

  const previewSeverity =
    findingForm.cvssScore !== "" && !Number.isNaN(Number(findingForm.cvssScore))
      ? severityFromCvss(Number(findingForm.cvssScore))
      : null;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <Link href="/app/observatory/pen-tests">
              <Button variant="ghost" size="sm" className="mb-1 -ml-2" data-testid="button-back-to-pen-tests">
                <ArrowLeft className="h-4 w-4 mr-1" /> Penetration Tests
              </Button>
            </Link>
            <h1 className="text-2xl font-semibold truncate" data-testid="text-pen-test-detail-name">{penTest.testName}</h1>
            <p className="text-muted-foreground text-sm mt-1">
              {penTest.application.name} · {penTest.assessment.title}
              {penTest.firm ? ` · ${penTest.firm}` : ""}
              {penTest.leadTester ? ` · ${penTest.leadTester}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {canWrite && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setScanConfirmOpen(true)}
                disabled={scanRunning || triggerScanMutation.isPending}
                data-testid="button-run-security-scan"
              >
                {scanRunning ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Scanning…</>
                ) : (
                  <><ScanLine className="h-4 w-4 mr-2" />Run automated scan</>
                )}
              </Button>
            )}
            {canWrite ? (
              <Select
                value={penTest.result ?? "none"}
                onValueChange={(v) => patchPenTestMutation.mutate({ result: v === "none" ? null : v })}
              >
                <SelectTrigger className="w-[230px]" data-testid="select-pen-test-result"><SelectValue placeholder="Overall result" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">In Progress (no result)</SelectItem>
                  {PEN_TEST_RESULTS.map((r) => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <PenTestResultBadge result={penTest.result} />
            )}
            <Link href={`/app/observatory/assessments/${penTest.assessment.id}`}>
              <Button variant="outline" size="sm" data-testid="button-open-pen-assessment">Assessment record</Button>
            </Link>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-2 text-sm">
          <div><span className="text-muted-foreground">Methodology:</span> {penTest.methodology ?? "—"}</div>
          <div><span className="text-muted-foreground">Start:</span> {penTest.startDate ? formatDate(penTest.startDate) : "—"}</div>
          <div><span className="text-muted-foreground">End:</span> {penTest.endDate ? formatDate(penTest.endDate) : "—"}</div>
          <div><span className="text-muted-foreground">Findings:</span> {penTest.findings.length}</div>
        </div>

        <Card data-testid="card-executive-summary">
          <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Executive summary</CardTitle>
            {canWrite && !summaryEditing && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSummaryDraft(penTest.executiveSummary ?? "");
                  setSummaryEditing(true);
                }}
                data-testid="button-edit-summary"
              >
                Edit
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {summaryEditing ? (
              <div className="space-y-3">
                <Textarea rows={5} value={summaryDraft} onChange={(e) => setSummaryDraft(e.target.value)} data-testid="input-executive-summary" />
                <div className="flex gap-2 justify-end">
                  <Button variant="outline" size="sm" onClick={() => setSummaryEditing(false)} data-testid="button-cancel-summary">Cancel</Button>
                  <Button
                    size="sm"
                    onClick={() => patchPenTestMutation.mutate({ executiveSummary: summaryDraft || null })}
                    disabled={patchPenTestMutation.isPending}
                    data-testid="button-save-summary"
                  >
                    {patchPenTestMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Save
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm whitespace-pre-wrap text-muted-foreground" data-testid="text-executive-summary">
                {penTest.executiveSummary || "No executive summary recorded yet."}
              </p>
            )}
          </CardContent>
        </Card>

        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-medium" data-testid="text-pen-findings-title">Findings</h2>
          {canWrite && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => relinkFindingsMutation.mutate()}
                disabled={relinkFindingsMutation.isPending}
                title="Recover findings from older scans that are missing their pen test link"
                data-testid="button-relink-findings"
              >
                {relinkFindingsMutation.isPending
                  ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Recovering…</>
                  : <><Link2 className="h-4 w-4 mr-2" />Recover orphaned findings</>
                }
              </Button>
              <Button size="sm" onClick={() => setFindingDialogOpen(true)} data-testid="button-new-pen-finding">
                <Plus className="h-4 w-4 mr-2" /> Add finding
              </Button>
            </div>
          )}
        </div>

        {penTest.findings.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No findings recorded for this engagement yet.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {penTest.findings.map((f) => (
              <Card key={f.id} data-testid={`card-pen-finding-${f.id}`}>
                <CardContent className="py-3 px-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <SeverityBadge severity={f.finding.severity} />
                        <Link href={`/app/observatory/findings/${f.finding.id}`}>
                          <span className="font-medium text-sm hover:underline cursor-pointer" data-testid={`text-pen-finding-title-${f.id}`}>
                            {f.finding.title}
                          </span>
                        </Link>
                        <FindingStatusBadge status={f.finding.status} />
                        {f.finding.affectedComponent === "Automated Scan" && (
                          <Badge variant="secondary" className="text-xs gap-1">
                            <ScanLine className="h-3 w-3" /> Automated
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {f.cvssScore != null ? `CVSS ${f.cvssScore.toFixed(1)}` : "CVSS —"}
                        {f.cvssVector ? ` · ${f.cvssVector}` : ""}
                        {f.exploitability ? ` · Exploitability: ${f.exploitability}` : ""}
                        {f.finding.cweId ? ` · ${f.finding.cweId}` : ""}
                      </p>
                      {f.validatedBy && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Validated by {f.validatedBy}{f.validatedAt ? ` on ${formatDate(f.validatedAt)}` : ""}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {canWrite ? (
                        <Select
                          value={f.validationStatus}
                          onValueChange={(v) => patchFindingMutation.mutate({ extId: f.id, validationStatus: v })}
                        >
                          <SelectTrigger className="w-[180px]" data-testid={`select-validation-${f.id}`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {VALIDATION_STATUSES.map((s) => (
                              <SelectItem key={s} value={s}>{s}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <ValidationStatusBadge status={f.validationStatus} />
                      )}
                      {canWrite && (
                        <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(f)} data-testid={`button-delete-pen-finding-${f.id}`}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={findingDialogOpen} onOpenChange={setFindingDialogOpen}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New pen test finding</DialogTitle>
            <DialogDescription>Creates a security finding in the shared register with CVSS tracking on this engagement.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Title *</Label>
              <Input value={findingForm.title} onChange={(e) => setFindingForm({ ...findingForm, title: e.target.value })} data-testid="input-pen-finding-title" />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea rows={3} value={findingForm.description} onChange={(e) => setFindingForm({ ...findingForm, description: e.target.value })} data-testid="input-pen-finding-description" />
            </div>
            <div className="space-y-2">
              <Label>Steps to reproduce</Label>
              <Textarea rows={2} value={findingForm.stepsToReproduce} onChange={(e) => setFindingForm({ ...findingForm, stepsToReproduce: e.target.value })} data-testid="input-pen-finding-steps" />
            </div>
            <div className="space-y-2">
              <Label>Recommendation</Label>
              <Textarea rows={2} value={findingForm.recommendation} onChange={(e) => setFindingForm({ ...findingForm, recommendation: e.target.value })} data-testid="input-pen-finding-recommendation" />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>CVSS score</Label>
                <Input
                  type="number"
                  min="0"
                  max="10"
                  step="0.1"
                  value={findingForm.cvssScore}
                  onChange={(e) => setFindingForm({ ...findingForm, cvssScore: e.target.value })}
                  data-testid="input-pen-finding-cvss"
                />
                {previewSeverity && <p className="text-xs text-muted-foreground">Severity: {previewSeverity}</p>}
              </div>
              <div className="space-y-2 col-span-2">
                <Label>CVSS vector</Label>
                <Input
                  value={findingForm.cvssVector}
                  onChange={(e) => setFindingForm({ ...findingForm, cvssVector: e.target.value })}
                  placeholder="CVSS:3.1/AV:N/AC:L/…"
                  data-testid="input-pen-finding-vector"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Exploitability</Label>
                <Select value={findingForm.exploitability || "unset"} onValueChange={(v) => setFindingForm({ ...findingForm, exploitability: v === "unset" ? "" : v })}>
                  <SelectTrigger data-testid="select-pen-finding-exploitability"><SelectValue placeholder="Optional" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unset">Not set</SelectItem>
                    {EXPLOITABILITY_LEVELS.map((l) => (
                      <SelectItem key={l} value={l}>{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>CWE ID</Label>
                <Input value={findingForm.cweId} onChange={(e) => setFindingForm({ ...findingForm, cweId: e.target.value })} placeholder="CWE-89" data-testid="input-pen-finding-cwe" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFindingDialogOpen(false)} data-testid="button-cancel-pen-finding">Cancel</Button>
            <Button
              onClick={() => createFindingMutation.mutate()}
              disabled={!findingForm.title.trim() || createFindingMutation.isPending}
              data-testid="button-save-pen-finding"
            >
              {createFindingMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Record finding
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Automated scan confirmation */}
      <AlertDialog open={scanConfirmOpen} onOpenChange={setScanConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run automated security scan?</AlertDialogTitle>
            <AlertDialogDescription>
              The scanner will check the application URL for security headers, TLS configuration, cookie flags, server version disclosure, and common exposed paths. Each issue found will be added as a finding on this pen test engagement, marked <strong>Automated Scan</strong> so they are distinct from your manual findings.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-security-scan">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => triggerScanMutation.mutate()}
              disabled={triggerScanMutation.isPending}
              data-testid="button-confirm-security-scan"
            >
              {triggerScanMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Start scan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this finding?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes "{deleteTarget?.finding.title}" from both this pen test and the shared findings register. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-finding">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteFindingMutation.mutate(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-finding"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
