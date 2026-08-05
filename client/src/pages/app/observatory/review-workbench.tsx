import { useState, useEffect, useRef } from "react";
import AppLayout from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useUser } from "@/lib/userContext";
import { Link, useParams } from "wouter";
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, NotebookPen, Paperclip, Plus, RefreshCw, ScanLine, Sparkles, Wand2, X } from "lucide-react";
import {
  workbenchBySlug,
  REVIEW_STATUSES,
  AZURE_STATUSES,
  FINDING_SEVERITIES,
  PRIVACY_FRAMEWORK_HINTS,
  ReviewStatusBadge,
  SeverityBadge,
  AssessmentStatusBadge,
} from "./shared";

interface ReviewItem {
  id: string;
  module: string;
  category: string;
  status: string;
  notes: string | null;
  reviewer: string | null;
  reviewedAt: string | null;
  findings: { id: string; title: string; severity: string; status: string }[];
  evidence: { id: string; title: string; evidenceType: string }[];
}

interface AssessmentDetail {
  id: string;
  title: string;
  type: string;
  status: string;
  application: { id: string; name: string; appUrl?: string | null };
  version?: { id: string; versionNumber: string } | null;
}

interface ScanJobStatus {
  status: "active" | "pending" | "not_found" | "failed";
  progress?: { percent?: number; phase?: string };
  runningSec?: number;
  queuePosition?: number;
  errorMessage?: string;
}

interface SourceMeta {
  id: string;
  repositoryUrl: string | null;
  branch: string | null;
  commitHash: string | null;
  language: string | null;
  framework: string | null;
  component: string | null;
  reviewTool: string | null;
  notes: string | null;
}

interface EvidenceRow {
  id: string;
  title: string;
  evidenceType: string;
}

export default function ObservatoryReviewWorkbench() {
  const { module: slug, assessmentId } = useParams<{ module: string; assessmentId: string }>();
  const wb = workbenchBySlug(slug);
  const { user } = useUser();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = ["Analyst", "Domain Admin", "Global Admin"].includes(user?.role ?? "");

  const [notesItem, setNotesItem] = useState<ReviewItem | null>(null);
  const [notesForm, setNotesForm] = useState({ notes: "", reviewer: "" });
  const [findingItem, setFindingItem] = useState<ReviewItem | null>(null);
  const [findingForm, setFindingForm] = useState({ title: "", description: "", recommendation: "", severity: "Medium", sourceFile: "", sourceLine: "" });
  const [evidenceItem, setEvidenceItem] = useState<ReviewItem | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState("");
  const [metaEditing, setMetaEditing] = useState(false);
  const [metaForm, setMetaForm] = useState({ repositoryUrl: "", branch: "", commitHash: "", language: "", framework: "", component: "", reviewTool: "", notes: "" });

  // ── Accessibility scan state ─────────────────────────────────────────────
  const isAccessibility = wb?.moduleKey === "accessibility";
  // Track open-finding count before scan starts so we can show a delta in the completion toast.
  const preScanOpenCountRef = useRef<number>(0);
  // Track previous status to detect transitions
  const prevScanStatusRef = useRef<string | undefined>(undefined);

  const { data: scanStatus, refetch: refetchScanStatus } = useQuery<ScanJobStatus>({
    queryKey: [`/api/observatory/assessments/${assessmentId}/scan-status`],
    enabled: !!assessmentId && isAccessibility,
    // Back off poll interval as the scan runs longer to avoid hammering the endpoint.
    // Stops automatically when status is not_found or failed.
    refetchInterval: (query) => {
      const s = (query.state.data as ScanJobStatus | undefined)?.status;
      if (s !== "active" && s !== "pending") return false;
      const runningSec = (query.state.data as ScanJobStatus | undefined)?.runningSec ?? 0;
      if (runningSec > 60) return 10000;
      if (runningSec > 30) return 5000;
      return 3000;
    },
  });

  // Detect scan completion or failure transitions
  useEffect(() => {
    const prev = prevScanStatusRef.current;
    const curr = scanStatus?.status;
    if ((prev === "active" || prev === "pending") && curr && curr !== "active" && curr !== "pending") {
      invalidate();
      if (curr === "failed") {
        toast({
          title: "Scan failed",
          description: scanStatus?.errorMessage ?? "The scan encountered an error. Please try again.",
          variant: "destructive",
        });
      } else {
        // Show resolved/new delta in the completion toast.
        // Wait briefly for invalidate() refetches to settle before reading fresh data.
        setTimeout(() => {
          const freshItems: ReviewItem[] | undefined = queryClient.getQueryData([
            `/api/observatory/assessments/${assessmentId}/review-items`,
          ]);
          const openAfter = (freshItems ?? [])
            .flatMap((i) => i.findings)
            .filter((f) => f.status === "open").length;
          const preScanOpen = preScanOpenCountRef.current;
          const resolved = Math.max(0, preScanOpen - openAfter);
          const newFindings = Math.max(0, openAfter - preScanOpen + resolved);
          const parts: string[] = [];
          if (resolved > 0) parts.push(`${resolved} finding${resolved === 1 ? "" : "s"} auto-resolved`);
          if (newFindings > 0) parts.push(`${newFindings} new finding${newFindings === 1 ? "" : "s"} detected`);
          if (parts.length === 0) parts.push("No changes to open findings");
          toast({ title: "Re-scan complete", description: parts.join(" · ") + "." });
        }, 800);
      }
    }
    prevScanStatusRef.current = curr;
  }, [scanStatus?.status]);

  const triggerScanMutation = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/observatory/assessments/${assessmentId}/scan`)).json(),
    onSuccess: () => {
      refetchScanStatus();
      toast({ title: "Scan queued", description: "Accessibility scan is running. Findings will appear here when complete." });
    },
    onError: (err: Error) => toast({ title: "Could not start scan", description: err.message, variant: "destructive" }),
  });

  const { data: assessment } = useQuery<AssessmentDetail>({
    queryKey: [`/api/observatory/assessments/${assessmentId}`],
    enabled: !!assessmentId,
  });
  const { data: items, isLoading } = useQuery<ReviewItem[]>({
    queryKey: [`/api/observatory/assessments/${assessmentId}/review-items`],
    enabled: !!assessmentId,
  });
  const isSource = wb?.moduleKey === "source_code";
  const { data: sourceMeta } = useQuery<SourceMeta | null>({
    queryKey: [`/api/observatory/assessments/${assessmentId}/source-meta`],
    enabled: !!assessmentId && isSource,
  });
  const { data: allEvidence } = useQuery<EvidenceRow[]>({
    queryKey: ["/api/observatory/evidence"],
    enabled: !!evidenceItem,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/observatory") });

  const initMutation = useMutation({
    mutationFn: async (moduleKey: string) =>
      (await apiRequest("POST", `/api/observatory/assessments/${assessmentId}/review-items/init`, { module: moduleKey })).json(),
    onSuccess: () => invalidate(),
    onError: (err: Error) => toast({ title: "Could not initialize checklist", description: err.message, variant: "destructive" }),
  });

  const patchItemMutation = useMutation({
    mutationFn: async ({ id, ...body }: { id: string; status?: string; notes?: string | null; reviewer?: string | null }) =>
      (await apiRequest("PATCH", `/api/observatory/review-items/${id}`, body)).json(),
    onSuccess: () => invalidate(),
    onError: (err: Error) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });

  const createFindingMutation = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", `/api/observatory/review-items/${findingItem!.id}/findings`, {
          title: findingForm.title,
          description: findingForm.description || null,
          recommendation: findingForm.recommendation || null,
          severity: findingForm.severity,
          domain: wb!.findingDomain,
          sourceFile: findingForm.sourceFile.trim() || null,
          sourceLine: findingForm.sourceLine.trim() ? Number(findingForm.sourceLine) : null,
        })
      ).json(),
    onSuccess: () => {
      invalidate();
      setFindingItem(null);
      setFindingForm({ title: "", description: "", recommendation: "", severity: "Medium", sourceFile: "", sourceLine: "" });
      toast({ title: "Finding created", description: "Added to the shared findings register and linked to this row." });
    },
    onError: (err: Error) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const draftMutation = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", "/api/observatory/ai/draft-finding", {
          notes: notesSeedForDraft(),
          module: wb?.moduleKey,
          category: findingItem?.category,
          applicationName: assessment?.application?.name,
        })
      ).json(),
    onSuccess: (draft: { title: string; description: string; recommendation: string; severity: string }) => {
      setFindingForm({
        ...findingForm,
        title: draft.title || findingForm.title,
        description: draft.description || findingForm.description,
        recommendation: draft.recommendation || findingForm.recommendation,
        severity: draft.severity || findingForm.severity,
      });
      toast({ title: "Draft ready", description: "Review and adjust before saving." });
    },
    onError: (err: Error) => toast({ title: "AI drafting failed", description: err.message, variant: "destructive" }),
  });

  function notesSeedForDraft(): string {
    const rowNotes = findingItem?.notes?.trim();
    const typed = [findingForm.title, findingForm.description].filter(Boolean).join("\n").trim();
    return typed || rowNotes || `Issue observed in ${findingItem?.category ?? "review"} during ${wb?.label ?? "review"}.`;
  }

  const linkEvidenceMutation = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/observatory/review-items/${evidenceItem!.id}/evidence/${selectedEvidenceId}`)).json(),
    onSuccess: () => {
      invalidate();
      setEvidenceItem(null);
      setSelectedEvidenceId("");
      toast({ title: "Evidence linked" });
    },
    onError: (err: Error) => toast({ title: "Link failed", description: err.message, variant: "destructive" }),
  });

  const unlinkEvidenceMutation = useMutation({
    mutationFn: async ({ itemId, evidenceId }: { itemId: string; evidenceId: string }) =>
      (await apiRequest("DELETE", `/api/observatory/review-items/${itemId}/evidence/${evidenceId}`)).json(),
    onSuccess: () => invalidate(),
    onError: (err: Error) => toast({ title: "Unlink failed", description: err.message, variant: "destructive" }),
  });

  const saveMetaMutation = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("PUT", `/api/observatory/assessments/${assessmentId}/source-meta`, {
          repositoryUrl: metaForm.repositoryUrl || null,
          branch: metaForm.branch || null,
          commitHash: metaForm.commitHash || null,
          language: metaForm.language || null,
          framework: metaForm.framework || null,
          component: metaForm.component || null,
          reviewTool: metaForm.reviewTool || null,
          notes: metaForm.notes || null,
        })
      ).json(),
    onSuccess: () => {
      invalidate();
      setMetaEditing(false);
      toast({ title: "Source metadata saved" });
    },
    onError: (err: Error) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  if (!wb) {
    return (
      <AppLayout>
        <div className="py-16 text-center text-muted-foreground" data-testid="text-unknown-module">Unknown review module.</div>
      </AppLayout>
    );
  }

  const isArchitecture = wb.moduleKey === "architecture";
  const primaryItems = (items ?? []).filter((i) => i.module === wb.moduleKey);
  const azureItems = (items ?? []).filter((i) => i.module === "architecture_azure");
  const initialized = primaryItems.length > 0;

  // Whether any scan-linked findings already exist — drives "Re-scan" vs "Run scan" UX.
  const hasExistingFindings = primaryItems.some((i) => i.findings.length > 0);

  const openNotes = (item: ReviewItem) => {
    setNotesForm({ notes: item.notes ?? "", reviewer: item.reviewer ?? "" });
    setNotesItem(item);
  };

  // A category counts as reviewed when either:
  //   (a) the analyst has manually set a status (not "Not Tested"), OR
  //   (b) all linked scan findings have been resolved/remediated (none open).
  // This ensures the counter reflects re-scan auto-remediation without touching
  // review-item statuses in the database.
  const completed = primaryItems.filter(
    (i) =>
      i.status !== "Not Tested" ||
      (i.findings.length > 0 && i.findings.every((f) => f.status !== "open")),
  ).length;

  function renderChecklist(rows: ReviewItem[], statuses: readonly string[], sectionTestId: string) {
    return (
      <div className="space-y-2" data-testid={sectionTestId}>
        {rows.map((item) => (
          <Card key={item.id} data-testid={`card-review-item-${item.id}`}>
            <CardContent className="py-3 px-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm" data-testid={`text-review-category-${item.id}`}>{item.category}</p>
                  {wb!.moduleKey === "privacy" && PRIVACY_FRAMEWORK_HINTS[item.category] && (
                    <p className="text-xs text-muted-foreground mt-0.5">{PRIVACY_FRAMEWORK_HINTS[item.category]}</p>
                  )}
                  {item.notes && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{item.notes}</p>}
                  {(item.findings.length > 0 || item.evidence.length > 0) && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {item.findings.map((f) => (
                        <Link key={f.id} href={`/app/observatory/findings/${f.id}`}>
                          <Badge variant="outline" className="cursor-pointer text-xs gap-1 hover:border-primary/50" data-testid={`badge-item-finding-${f.id}`}>
                            <SeverityBadge severity={f.severity} /> {f.title}
                          </Badge>
                        </Link>
                      ))}
                      {item.evidence.map((ev) => (
                        <Badge key={ev.id} variant="secondary" className="text-xs gap-1" data-testid={`badge-item-evidence-${ev.id}`}>
                          <Paperclip className="h-3 w-3" /> {ev.title}
                          {canWrite && (
                            <button
                              className="ml-0.5 hover:text-destructive"
                              onClick={() => unlinkEvidenceMutation.mutate({ itemId: item.id, evidenceId: ev.id })}
                              data-testid={`button-unlink-evidence-${item.id}-${ev.id}`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          )}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {item.reviewer && <span className="text-xs text-muted-foreground hidden md:inline">{item.reviewer}</span>}
                  {canWrite ? (
                    <Select
                      value={item.status}
                      onValueChange={(v) => patchItemMutation.mutate({ id: item.id, status: v })}
                    >
                      <SelectTrigger className="w-[210px]" data-testid={`select-item-status-${item.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {statuses.map((s) => (
                          <SelectItem key={s} value={s}>{s}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <ReviewStatusBadge status={item.status} />
                  )}
                  {canWrite && (
                    <>
                      <Button variant="ghost" size="icon" onClick={() => openNotes(item)} title="Notes & reviewer" data-testid={`button-item-notes-${item.id}`}>
                        <NotebookPen className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Create finding"
                        onClick={() => {
                          setFindingForm({ title: "", description: item.notes ?? "", recommendation: "", severity: "Medium", sourceFile: "", sourceLine: "" });
                          setFindingItem(item);
                        }}
                        data-testid={`button-item-finding-${item.id}`}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Link evidence"
                        onClick={() => setEvidenceItem(item)}
                        data-testid={`button-item-evidence-${item.id}`}
                      >
                        <Paperclip className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <Link href={`/app/observatory/review/${wb.slug}`}>
              <Button variant="ghost" size="sm" className="mb-1 -ml-2" data-testid="button-back-to-hub">
                <ArrowLeft className="h-4 w-4 mr-1" /> {wb.label}
              </Button>
            </Link>
            <h1 className="text-2xl font-semibold truncate" data-testid="text-workbench-title">
              {assessment?.title ?? "…"}
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              {assessment?.application?.name}
              {assessment?.version?.versionNumber ? ` · v${assessment.version.versionNumber}` : ""}
              {initialized ? ` · ${completed}/${primaryItems.length} reviewed` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {assessment && <AssessmentStatusBadge status={assessment.status} />}
            {isAccessibility && canWrite && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  // Capture the current open-finding count before the scan starts
                  // so we can compute the resolved/new delta in the completion toast.
                  preScanOpenCountRef.current = primaryItems
                    .flatMap((i) => i.findings)
                    .filter((f) => f.status === "open").length;
                  triggerScanMutation.mutate();
                }}
                disabled={
                  triggerScanMutation.isPending ||
                  scanStatus?.status === "active" ||
                  scanStatus?.status === "pending"
                }
                data-testid="button-run-a11y-scan"
                title={
                  hasExistingFindings
                    ? "Re-run the accessibility scan. Findings no longer detected will be automatically marked resolved."
                    : "Run an automated WCAG 2.1/2.2 accessibility scan with axe-core"
                }
              >
                {(triggerScanMutation.isPending || scanStatus?.status === "active" || scanStatus?.status === "pending") ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Scanning…</>
                ) : hasExistingFindings ? (
                  <><RefreshCw className="h-4 w-4 mr-2" /> Re-scan</>
                ) : (
                  <><ScanLine className="h-4 w-4 mr-2" /> Run accessibility scan</>
                )}
              </Button>
            )}
            {assessment && (
              <Link href={`/app/observatory/assessments/${assessment.id}`}>
                <Button variant="outline" size="sm" data-testid="button-open-assessment">Assessment record</Button>
              </Link>
            )}
          </div>
        </div>

        {/* Scan status banner — running */}
        {isAccessibility && scanStatus && (scanStatus.status === "active" || scanStatus.status === "pending") && (
          <Card className="border-blue-500/30 bg-blue-500/5" data-testid="card-scan-status">
            <CardContent className="py-3 px-4 flex items-center gap-3">
              <Loader2 className="h-4 w-4 animate-spin text-blue-500 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {scanStatus.status === "pending"
                    ? hasExistingFindings ? "Re-scan queued" : "Scan queued"
                    : hasExistingFindings ? "Re-scanning for accessibility issues" : "Accessibility scan running"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {scanStatus.status === "active"
                    ? `Running for ${scanStatus.runningSec ?? 0}s — WCAG 2.1/2.2 violations checked with axe-core${hasExistingFindings ? "; findings no longer detected will be auto-resolved" : ""}`
                    : `Position ${scanStatus.queuePosition ?? "—"} in queue`}
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Scan error banner — failed or lost */}
        {isAccessibility && scanStatus?.status === "failed" && (
          <Card className="border-destructive/40 bg-destructive/5" data-testid="card-scan-error">
            <CardContent className="py-3 px-4 flex items-center gap-3">
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-destructive">Scan failed</p>
                <p className="text-xs text-muted-foreground">
                  {scanStatus.errorMessage ?? "The scan encountered an error. Please try again."}
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {isSource && (
          <Card data-testid="card-source-meta">
            <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Repository & scope</CardTitle>
              {canWrite && !metaEditing && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setMetaForm({
                      repositoryUrl: sourceMeta?.repositoryUrl ?? "",
                      branch: sourceMeta?.branch ?? "",
                      commitHash: sourceMeta?.commitHash ?? "",
                      language: sourceMeta?.language ?? "",
                      framework: sourceMeta?.framework ?? "",
                      component: sourceMeta?.component ?? "",
                      reviewTool: sourceMeta?.reviewTool ?? "",
                      notes: sourceMeta?.notes ?? "",
                    });
                    setMetaEditing(true);
                  }}
                  data-testid="button-edit-source-meta"
                >
                  {sourceMeta ? "Edit" : "Add details"}
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {metaEditing ? (
                <div className="space-y-4">
                  <div className="grid md:grid-cols-3 gap-4">
                    <div className="space-y-2 md:col-span-3">
                      <Label>Repository URL</Label>
                      <Input value={metaForm.repositoryUrl} onChange={(e) => setMetaForm({ ...metaForm, repositoryUrl: e.target.value })} placeholder="https://github.com/org/repo" data-testid="input-meta-repo" />
                    </div>
                    <div className="space-y-2">
                      <Label>Branch</Label>
                      <Input value={metaForm.branch} onChange={(e) => setMetaForm({ ...metaForm, branch: e.target.value })} data-testid="input-meta-branch" />
                    </div>
                    <div className="space-y-2">
                      <Label>Commit</Label>
                      <Input value={metaForm.commitHash} onChange={(e) => setMetaForm({ ...metaForm, commitHash: e.target.value })} data-testid="input-meta-commit" />
                    </div>
                    <div className="space-y-2">
                      <Label>Review tool</Label>
                      <Input value={metaForm.reviewTool} onChange={(e) => setMetaForm({ ...metaForm, reviewTool: e.target.value })} placeholder="Manual, Semgrep…" data-testid="input-meta-tool" />
                    </div>
                    <div className="space-y-2">
                      <Label>Language</Label>
                      <Input value={metaForm.language} onChange={(e) => setMetaForm({ ...metaForm, language: e.target.value })} data-testid="input-meta-language" />
                    </div>
                    <div className="space-y-2">
                      <Label>Framework</Label>
                      <Input value={metaForm.framework} onChange={(e) => setMetaForm({ ...metaForm, framework: e.target.value })} data-testid="input-meta-framework" />
                    </div>
                    <div className="space-y-2">
                      <Label>Component</Label>
                      <Input value={metaForm.component} onChange={(e) => setMetaForm({ ...metaForm, component: e.target.value })} data-testid="input-meta-component" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Notes</Label>
                    <Textarea rows={2} value={metaForm.notes} onChange={(e) => setMetaForm({ ...metaForm, notes: e.target.value })} data-testid="input-meta-notes" />
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button variant="outline" size="sm" onClick={() => setMetaEditing(false)} data-testid="button-cancel-meta">Cancel</Button>
                    <Button size="sm" onClick={() => saveMetaMutation.mutate()} disabled={saveMetaMutation.isPending} data-testid="button-save-meta">
                      {saveMetaMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Save
                    </Button>
                  </div>
                </div>
              ) : sourceMeta ? (
                <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-2 text-sm" data-testid="text-source-meta">
                  <div><span className="text-muted-foreground">Repository:</span> {sourceMeta.repositoryUrl ?? "—"}</div>
                  <div><span className="text-muted-foreground">Branch:</span> {sourceMeta.branch ?? "—"}</div>
                  <div><span className="text-muted-foreground">Commit:</span> <span className="font-mono text-xs">{sourceMeta.commitHash ? sourceMeta.commitHash.slice(0, 10) : "—"}</span></div>
                  <div><span className="text-muted-foreground">Tool:</span> {sourceMeta.reviewTool ?? "—"}</div>
                  <div><span className="text-muted-foreground">Language:</span> {sourceMeta.language ?? "—"}</div>
                  <div><span className="text-muted-foreground">Framework:</span> {sourceMeta.framework ?? "—"}</div>
                  <div><span className="text-muted-foreground">Component:</span> {sourceMeta.component ?? "—"}</div>
                  {sourceMeta.notes && <div className="sm:col-span-2 lg:col-span-4"><span className="text-muted-foreground">Notes:</span> {sourceMeta.notes}</div>}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No repository details recorded yet. Add the repo, branch, and commit under review.</p>
              )}
            </CardContent>
          </Card>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : !initialized ? (
          <Card>
            <CardContent className="py-12 flex flex-col items-center text-center gap-3">
              <Sparkles className="h-10 w-10 text-muted-foreground" />
              <p className="font-medium">Checklist not started</p>
              <p className="text-sm text-muted-foreground max-w-md">
                Initialize the {wb.label.toLowerCase()} checklist to seed the standard review categories for this assessment.
              </p>
              {canWrite && (
                <Button
                  onClick={async () => {
                    await initMutation.mutateAsync(wb.moduleKey);
                    if (isArchitecture) await initMutation.mutateAsync("architecture_azure");
                  }}
                  disabled={initMutation.isPending}
                  data-testid="button-init-checklist"
                >
                  {initMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Start checklist
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <>
            {isArchitecture && <h2 className="text-lg font-medium">Architecture areas</h2>}
            {renderChecklist(primaryItems, REVIEW_STATUSES, "section-primary-checklist")}
            {isArchitecture && azureItems.length > 0 && (
              <>
                <h2 className="text-lg font-medium pt-2" data-testid="text-azure-section-title">Azure capability checklist</h2>
                {renderChecklist(azureItems, AZURE_STATUSES, "section-azure-checklist")}
              </>
            )}
          </>
        )}
      </div>

      {/* Notes & reviewer dialog */}
      <Dialog open={!!notesItem} onOpenChange={(o) => !o && setNotesItem(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{notesItem?.category}</DialogTitle>
            <DialogDescription>Reviewer notes for this checklist row.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea rows={5} value={notesForm.notes} onChange={(e) => setNotesForm({ ...notesForm, notes: e.target.value })} data-testid="input-item-notes" />
            </div>
            <div className="space-y-2">
              <Label>Reviewer</Label>
              <Input value={notesForm.reviewer} onChange={(e) => setNotesForm({ ...notesForm, reviewer: e.target.value })} data-testid="input-item-reviewer" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNotesItem(null)} data-testid="button-cancel-notes">Cancel</Button>
            <Button
              onClick={() =>
                patchItemMutation.mutate(
                  { id: notesItem!.id, notes: notesForm.notes || null, reviewer: notesForm.reviewer || null },
                  { onSuccess: () => setNotesItem(null) },
                )
              }
              disabled={patchItemMutation.isPending}
              data-testid="button-save-notes"
            >
              {patchItemMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create finding dialog */}
      <Dialog open={!!findingItem} onOpenChange={(o) => !o && setFindingItem(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New finding — {findingItem?.category}</DialogTitle>
            <DialogDescription>Creates a finding in the shared register, linked to this checklist row.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => draftMutation.mutate()}
                disabled={draftMutation.isPending}
                data-testid="button-ai-draft-finding"
              >
                {draftMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Wand2 className="h-4 w-4 mr-2" />}
                Draft with AI
              </Button>
            </div>
            <div className="space-y-2">
              <Label>Title *</Label>
              <Input value={findingForm.title} onChange={(e) => setFindingForm({ ...findingForm, title: e.target.value })} data-testid="input-finding-title" />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea rows={3} value={findingForm.description} onChange={(e) => setFindingForm({ ...findingForm, description: e.target.value })} data-testid="input-finding-description" />
            </div>
            <div className="space-y-2">
              <Label>Recommendation</Label>
              <Textarea rows={2} value={findingForm.recommendation} onChange={(e) => setFindingForm({ ...findingForm, recommendation: e.target.value })} data-testid="input-finding-recommendation" />
            </div>
            <div className="space-y-2">
              <Label>Severity</Label>
              <Select value={findingForm.severity} onValueChange={(v) => setFindingForm({ ...findingForm, severity: v })}>
                <SelectTrigger data-testid="select-finding-severity"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FINDING_SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {isSource && (
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-2 col-span-2">
                  <Label>Affected source file *</Label>
                  <Input
                    placeholder="e.g. src/services/auth.ts"
                    value={findingForm.sourceFile}
                    onChange={(e) => setFindingForm({ ...findingForm, sourceFile: e.target.value })}
                    data-testid="input-finding-source-file"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Line</Label>
                  <Input
                    type="number"
                    min={1}
                    placeholder="e.g. 42"
                    value={findingForm.sourceLine}
                    onChange={(e) => setFindingForm({ ...findingForm, sourceLine: e.target.value })}
                    data-testid="input-finding-source-line"
                  />
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFindingItem(null)} data-testid="button-cancel-finding">Cancel</Button>
            <Button
              onClick={() => createFindingMutation.mutate()}
              disabled={!findingForm.title.trim() || (isSource && !findingForm.sourceFile.trim()) || createFindingMutation.isPending}
              data-testid="button-save-finding"
            >
              {createFindingMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Create finding
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Link evidence dialog */}
      <Dialog open={!!evidenceItem} onOpenChange={(o) => !o && setEvidenceItem(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Link evidence — {evidenceItem?.category}</DialogTitle>
            <DialogDescription>Attach an existing evidence record to this checklist row.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Evidence</Label>
            <Select value={selectedEvidenceId} onValueChange={setSelectedEvidenceId}>
              <SelectTrigger data-testid="select-link-evidence"><SelectValue placeholder="Select evidence…" /></SelectTrigger>
              <SelectContent>
                {(allEvidence ?? []).map((ev) => (
                  <SelectItem key={ev.id} value={ev.id}>{ev.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(allEvidence ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">No evidence records yet — add them in the Evidence library first.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEvidenceItem(null)} data-testid="button-cancel-link-evidence">Cancel</Button>
            <Button
              onClick={() => linkEvidenceMutation.mutate()}
              disabled={!selectedEvidenceId || linkEvidenceMutation.isPending}
              data-testid="button-save-link-evidence"
            >
              {linkEvidenceMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
