import { useState } from "react";
import { useParams, Link, useLocation } from "wouter";
import AppLayout from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useUser } from "@/lib/userContext";
import { ArrowLeft, Loader2, Trash2, Archive, BookMarked, Plus, X, Search } from "lucide-react";
import { SeverityBadge, FindingStatusBadge, FINDING_STATUSES, FINDING_DOMAINS, labelFor } from "./shared";
import { formatDate } from "@/lib/utils";

interface ControlRow {
  id: string;
  controlId: string;
  title: string;
  framework: { id: string; name: string; version: string | null };
}

interface Detail {
  id: string;
  title: string;
  description: string | null;
  severity: string;
  domain: string;
  status: string;
  recommendation: string | null;
  remediationNotes: string | null;
  affectedComponent: string | null;
  wcagCriterion: string | null;
  cweId: string | null;
  cvssScore: number | null;
  assignedTo: string | null;
  dueDate: string | null;
  /** JSON array of page URLs where this violation was found (accessibility scan). */
  sourcePages: string | null;
  application: { id: string; name: string } | null;
  assessment: { id: string; title: string } | null;
  version: { id: string; versionNumber: string } | null;
  evidence: { id: string; title: string; evidenceType: string }[];
  controls: ControlRow[];
}

export default function ObservatoryFindingDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { user } = useUser();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = ["Analyst", "Domain Admin", "Global Admin"].includes(user?.role ?? "");

  const { data: finding, isLoading } = useQuery<Detail>({ queryKey: [`/api/observatory/findings/${id}`] });

  const [controlDialogOpen, setControlDialogOpen] = useState(false);
  const [controlSearch, setControlSearch] = useState("");
  const [frameworkFilter, setFrameworkFilter] = useState("all");

  const { data: frameworks } = useQuery<{ id: string; name: string; version: string | null }[]>({
    queryKey: ["/api/observatory/frameworks"],
    enabled: controlDialogOpen,
  });
  const controlQs = new URLSearchParams();
  if (frameworkFilter !== "all") controlQs.set("frameworkId", frameworkFilter);
  if (controlSearch.trim()) controlQs.set("search", controlSearch.trim());
  const { data: controlOptions, isLoading: controlsLoading } = useQuery<
    { id: string; controlId: string; title: string; frameworkName: string }[]
  >({
    queryKey: [`/api/observatory/controls${controlQs.toString() ? `?${controlQs.toString()}` : ""}`],
    enabled: controlDialogOpen,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/observatory") });

  const statusMutation = useMutation({
    mutationFn: async (status: string) => (await apiRequest("PATCH", `/api/observatory/findings/${id}`, { status })).json(),
    onSuccess: () => {
      invalidate();
      toast({ title: "Status updated" });
    },
    onError: (err: Error) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });

  const linkControl = useMutation({
    mutationFn: async (controlId: string) => (await apiRequest("POST", `/api/observatory/findings/${id}/controls/${controlId}`)).json(),
    onSuccess: () => {
      invalidate();
      toast({ title: "Control linked" });
    },
    onError: (err: Error) => toast({ title: "Link failed", description: err.message, variant: "destructive" }),
  });

  const unlinkControl = useMutation({
    mutationFn: async (controlId: string) => (await apiRequest("DELETE", `/api/observatory/findings/${id}/controls/${controlId}`)).json(),
    onSuccess: () => {
      invalidate();
      toast({ title: "Control unlinked" });
    },
    onError: (err: Error) => toast({ title: "Unlink failed", description: err.message, variant: "destructive" }),
  });

  const unlinkEvidence = useMutation({
    mutationFn: async (evidenceId: string) => (await apiRequest("DELETE", `/api/observatory/findings/${id}/evidence/${evidenceId}`)).json(),
    onSuccess: () => {
      invalidate();
      toast({ title: "Evidence unlinked" });
    },
    onError: (err: Error) => toast({ title: "Unlink failed", description: err.message, variant: "destructive" }),
  });

  const deleteFinding = useMutation({
    mutationFn: async () => (await apiRequest("DELETE", `/api/observatory/findings/${id}`)).json(),
    onSuccess: () => {
      invalidate();
      toast({ title: "Finding deleted" });
      navigate("/app/observatory/findings");
    },
    onError: (err: Error) => toast({ title: "Delete failed", description: err.message, variant: "destructive" }),
  });

  if (isLoading || !finding) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      </AppLayout>
    );
  }

  const linkedControlIds = new Set(finding.controls.map((c) => c.id));

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <Link href="/app/observatory/findings">
              <Button variant="ghost" size="sm" className="mb-2 -ml-2" data-testid="button-back-findings">
                <ArrowLeft className="h-4 w-4 mr-1" /> Findings
              </Button>
            </Link>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-semibold" data-testid="text-finding-title">{finding.title}</h1>
              <SeverityBadge severity={finding.severity} />
            </div>
            <p className="text-muted-foreground text-sm mt-1">
              {finding.application && (
                <Link href={`/app/observatory/applications/${finding.application.id}`} className="hover:underline" data-testid="link-finding-application">
                  {finding.application.name}
                </Link>
              )}
              {finding.version ? ` · v${finding.version.versionNumber}` : ""}
              {finding.assessment && (
                <>
                  {" · "}
                  <Link href={`/app/observatory/assessments/${finding.assessment.id}`} className="hover:underline" data-testid="link-finding-assessment">
                    {finding.assessment.title}
                  </Link>
                </>
              )}
              {" · "}{labelFor(FINDING_DOMAINS as any, finding.domain)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canWrite ? (
              <Select value={finding.status} onValueChange={(v) => statusMutation.mutate(v)}>
                <SelectTrigger className="w-[170px]" data-testid="select-finding-status-change"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FINDING_STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <FindingStatusBadge status={finding.status} />
            )}
            {canWrite && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="icon" data-testid="button-delete-finding"><Trash2 className="h-4 w-4" /></Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this finding?</AlertDialogTitle>
                    <AlertDialogDescription>This removes the finding and its control/evidence links. Evidence items remain in the vault.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => deleteFinding.mutate()} data-testid="button-confirm-delete-finding">Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-4">
          <Card className="md:col-span-2">
            <CardHeader><CardTitle className="text-base">Description & remediation</CardTitle></CardHeader>
            <CardContent className="space-y-4 text-sm">
              {finding.description ? <p data-testid="text-finding-description">{finding.description}</p> : <p className="text-muted-foreground">No description.</p>}
              {finding.recommendation && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Recommendation</p>
                  <p data-testid="text-finding-recommendation">{finding.recommendation}</p>
                </div>
              )}
              {finding.remediationNotes && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Remediation notes</p>
                  <p>{finding.remediationNotes}</p>
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">Details</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {finding.affectedComponent && <p><span className="text-muted-foreground">Component:</span> {finding.affectedComponent}</p>}
              {finding.wcagCriterion && <p data-testid="text-finding-wcag"><span className="text-muted-foreground">WCAG:</span> {finding.wcagCriterion}</p>}
              {finding.cweId && <p><span className="text-muted-foreground">CWE:</span> {finding.cweId}</p>}
              {finding.cvssScore != null && <p><span className="text-muted-foreground">CVSS:</span> {finding.cvssScore}</p>}
              {finding.assignedTo && <p><span className="text-muted-foreground">Assigned to:</span> {finding.assignedTo}</p>}
              {finding.dueDate && <p><span className="text-muted-foreground">Due:</span> {formatDate(finding.dueDate)}</p>}
              {finding.sourcePages && (() => {
                let pages: string[] = [];
                try { pages = JSON.parse(finding.sourcePages); } catch { /* ignore */ }
                if (!Array.isArray(pages) || pages.length === 0) return null;
                return (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Detected on {pages.length} page{pages.length > 1 ? "s" : ""}</p>
                    <ul className="space-y-0.5">
                      {pages.map((url) => (
                        <li key={url} className="truncate">
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary underline underline-offset-2 hover:text-primary/80"
                            title={url}
                          >
                            {(() => { try { return new URL(url).pathname || "/"; } catch { return url; } })()}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })()}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base flex items-center gap-2"><BookMarked className="h-4 w-4" /> Linked controls ({finding.controls.length})</CardTitle>
            {canWrite && (
              <Button size="sm" variant="outline" onClick={() => setControlDialogOpen(true)} data-testid="button-link-control">
                <Plus className="h-4 w-4 mr-1" /> Link control
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {finding.controls.length === 0 ? (
              <p className="text-sm text-muted-foreground">No standards controls linked. Linking controls builds the traceability chain to frameworks like WCAG 2.2 and SOC 2.</p>
            ) : (
              <div className="space-y-2">
                {finding.controls.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 border border-border rounded-md px-3 py-2" data-testid={`row-control-${c.id}`}>
                    <div className="min-w-0">
                      <p className="font-medium text-sm">{c.controlId} — {c.title}</p>
                      <p className="text-xs text-muted-foreground">{c.framework.name}{c.framework.version ? ` ${c.framework.version}` : ""}</p>
                    </div>
                    {canWrite && (
                      <Button variant="ghost" size="icon" onClick={() => unlinkControl.mutate(c.id)} data-testid={`button-unlink-control-${c.id}`}>
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base flex items-center gap-2"><Archive className="h-4 w-4" /> Evidence ({finding.evidence.length})</CardTitle>
            <Link href={`/app/observatory/evidence?findingId=${finding.id}`}>
              <Button size="sm" variant="outline" data-testid="button-add-evidence">
                <Plus className="h-4 w-4 mr-1" /> Add evidence
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {finding.evidence.length === 0 ? (
              <p className="text-sm text-muted-foreground">No evidence linked to this finding yet.</p>
            ) : (
              <div className="space-y-2">
                {finding.evidence.map((e) => (
                  <div key={e.id} className="flex items-center justify-between gap-3 border border-border rounded-md px-3 py-2" data-testid={`row-evidence-${e.id}`}>
                    <Link href={`/app/observatory/evidence/${e.id}`} className="min-w-0 flex-1 cursor-pointer hover:underline">
                      <p className="font-medium text-sm truncate">{e.title}</p>
                      <Badge variant="secondary" className="text-xs">{e.evidenceType.replace(/_/g, " ")}</Badge>
                    </Link>
                    <div className="flex items-center gap-2 shrink-0">
                      {canWrite && (
                        <Button variant="ghost" size="icon" onClick={() => unlinkEvidence.mutate(e.id)} data-testid={`button-unlink-evidence-${e.id}`}>
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={controlDialogOpen} onOpenChange={setControlDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Link a control</DialogTitle>
            <DialogDescription>Map this finding to a standards control for traceability.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex gap-2">
              <Select value={frameworkFilter} onValueChange={setFrameworkFilter}>
                <SelectTrigger className="w-[220px]" data-testid="select-control-framework"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All frameworks</SelectItem>
                  {(frameworks ?? []).map((f) => (
                    <SelectItem key={f.id} value={f.id}>{f.name}{f.version ? ` ${f.version}` : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="relative flex-1">
                <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-9" placeholder="Search controls…" value={controlSearch} onChange={(e) => setControlSearch(e.target.value)} data-testid="input-search-controls" />
              </div>
            </div>
            <div className="max-h-[320px] overflow-y-auto space-y-1">
              {controlsLoading ? (
                <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
              ) : (controlOptions ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No controls match.</p>
              ) : (
                (controlOptions ?? []).map((c) => (
                  <button
                    key={c.id}
                    className="w-full text-left border border-border rounded-md px-3 py-2 hover:border-primary/50 disabled:opacity-50"
                    disabled={linkedControlIds.has(c.id) || linkControl.isPending}
                    onClick={() => linkControl.mutate(c.id)}
                    data-testid={`button-pick-control-${c.id}`}
                  >
                    <p className="font-medium text-sm">{c.controlId} — {c.title}</p>
                    <p className="text-xs text-muted-foreground">{c.frameworkName}{linkedControlIds.has(c.id) ? " · already linked" : ""}</p>
                  </button>
                ))
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
