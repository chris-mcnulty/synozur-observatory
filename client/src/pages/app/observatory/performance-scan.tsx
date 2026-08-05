/**
 * PerformanceScanPanel — embedded in the assessment-detail page when
 * assessment.type === "performance".
 *
 * Shows:
 *   - Automated scan frequency selector (Daily / Weekly / On-demand)
 *   - Current SLA threshold configuration (editable)
 *   - Trigger-scan button (with in-flight guard)
 *   - Scan history table with measured metrics vs thresholds
 *     — includes a "Source" column (Manual / Auto) to distinguish runs
 *   - Each completed scan links to findings it created
 */
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Play, Settings, CheckCircle2, XCircle, Clock, AlertTriangle, CalendarClock, AlertCircle, Globe, Link2, Trash2, Plus } from "lucide-react";
import { formatDate } from "@/lib/utils";

interface PerfScan {
  id: string;
  scanUrl: string;
  status: "running" | "completed" | "failed";
  findingCount: number;
  createdAt: string;
  scanSource: "manual" | "scheduled";
  slaConfig: SlaConfig | null;
  triggeredBy: string | null;
  pages: PerfScanPage[];
}

interface SlaConfig {
  ttfbMs: number;
  loadTimeMs: number;
  lcpMs: number;
  clsScore: number;
  ttiMs: number;
}

type ScanSchedule = "daily" | "weekly" | "disabled";

const DEFAULT_SLA: SlaConfig = {
  ttfbMs: 800,
  loadTimeMs: 3000,
  lcpMs: 2500,
  clsScore: 0.1,
  ttiMs: 3800,
};

const SCHEDULE_LABELS: Record<ScanSchedule, string> = {
  daily: "Daily",
  weekly: "Weekly",
  disabled: "On-demand only",
};

function fmtMs(v: number | null): string {
  if (v === null) return "—";
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
  return `${v} ms`;
}

function metricStatus(value: number | null, threshold: number): "ok" | "breach" | "unknown" {
  if (value === null) return "unknown";
  return value <= threshold ? "ok" : "breach";
}

function MetricCell({ value, threshold, format }: {
  value: number | null;
  threshold: number;
  format: (v: number | null) => string;
}) {
  const status = metricStatus(value, threshold);
  return (
    <span className={
      status === "breach" ? "text-red-400 font-medium"
        : status === "ok" ? "text-green-400"
          : "text-muted-foreground"
    }>
      {format(value)}
    </span>
  );
}

function PageStatusBadge({ page }: { page: PerfScanPage }) {
  if (page.status === "running")
    return (
      <Badge variant="outline" className="bg-blue-500/15 text-blue-400 border-blue-500/30 whitespace-nowrap">
        <Loader2 className="h-3 w-3 mr-1 animate-spin" />Scanning…
      </Badge>
    );
  if (page.status === "failed")
    return (
      <Badge variant="outline" className="bg-red-600/15 text-red-400 border-red-600/30 whitespace-nowrap">
        <XCircle className="h-3 w-3 mr-1" />Failed
      </Badge>
    );
  const breaches = page.findingCount > 0;
  return (
    <Badge
      variant="outline"
      className={breaches
        ? "bg-orange-500/15 text-orange-400 border-orange-500/30 whitespace-nowrap"
        : "bg-green-600/15 text-green-400 border-green-600/30 whitespace-nowrap"}
    >
      {breaches
        ? <><AlertTriangle className="h-3 w-3 mr-1" />{page.findingCount} breach{page.findingCount !== 1 ? "es" : ""}</>
        : <><CheckCircle2 className="h-3 w-3 mr-1" />Pass</>}
    </Badge>
  );
}
function ScanSourceBadge({ source }: { source: "manual" | "scheduled" | undefined }) {
  if (source === "scheduled")
    return (
      <Badge variant="outline" className="bg-purple-600/10 text-purple-400 border-purple-600/25 text-[10px] px-1.5 py-0">
        <CalendarClock className="h-2.5 w-2.5 mr-0.5" />Auto
      </Badge>
    );
  return (
    <Badge variant="outline" className="bg-muted text-muted-foreground border-border text-[10px] px-1.5 py-0">
      Manual
    </Badge>
  );
}

interface Props {
  assessmentId: string;

  applicationId: string;

  applicationSlaConfig?: SlaConfig | null;
  /** Current automated scan cadence from the assessment row. */

  scanSchedule: ScanSchedule;

  canWrite: boolean;

  applicationExtraUrls?: string[];
}

export default function PerformanceScanPanel({
  assessmentId,
  applicationId,
  applicationSlaConfig,
  applicationExtraUrls = [],
  scanSchedule: initialScanSchedule,
  canWrite,
}: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ── SLA dialog state
  const [slaDialogOpen, setSlaDialogOpen] = useState(false);
  const [slaForm, setSlaForm] = useState<SlaConfig>(applicationSlaConfig ?? DEFAULT_SLA);

  // ── URL management dialog state
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [urlList, setUrlList] = useState<string[]>(applicationExtraUrls);
  const [newUrl, setNewUrl] = useState("");
  const [newUrlError, setNewUrlError] = useState("");

  const activeSla: SlaConfig = applicationSlaConfig ?? DEFAULT_SLA;

  // ── Queries ───────────────────────────────────────────────────────────────

  // Poll scan history; re-fetch every 5 s while any scan/page is running.
  const { data: scans = [], isLoading } = useQuery<PerfScan[]>({
    queryKey: [`/api/observatory/assessments/${assessmentId}/performance-scans`],
    refetchInterval: (data) => {
      if (!Array.isArray(data)) return false;
      const hasRunning = (data as PerfScan[]).some(
        (s) => s.status === "running" || s.pages.some((p) => p.status === "running"),
      );
      return hasRunning ? 5000 : false;
    },
  });

  // Poll job queue status.
  const { data: jobStatus } = useQuery<{ status: "active" | "pending" | "not_found" }>({
    queryKey: [`/api/observatory/assessments/${assessmentId}/performance-scan/status`],
    refetchInterval: 5000,
  });

  const isScanRunning =
    jobStatus?.status === "active" ||
    jobStatus?.status === "pending" ||
    scans.some((s) => s.status === "running" || s.pages.some((p) => p.status === "running"));

  const invalidate = () => {
    queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/observatory") });
  };

  // ── Mutations ─────────────────────────────────────────────────────────────
  // Set scan schedule
  const setSchedule = useMutation({
    mutationFn: async (scanSchedule: ScanSchedule) =>
      (await apiRequest("PUT", `/api/observatory/assessments/${assessmentId}/scan-schedule`, { scanSchedule })).json(),
    onSuccess: (_data, scanSchedule) => {
      invalidate();
      const label = SCHEDULE_LABELS[scanSchedule];
      toast({
        title: "Scan schedule updated",
        description: scanSchedule === "disabled"
          ? "Automated scans disabled. Scans will only run when triggered manually."
          : `Performance scans will now run automatically ${label.toLowerCase()}.`,
      });
    },
    onError: (err: Error) => toast({ title: "Failed to update schedule", description: err.message, variant: "destructive" }),
  });


  const triggerScan = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/observatory/assessments/${assessmentId}/performance-scan`)).json(),
    onSuccess: (data) => {
      invalidate();
      const label = data.urlCount > 1 ? `${data.urlCount} pages` : data.scanUrl;
      toast({ title: "Performance scan started", description: `Scanning ${label}…` });
    },
    onError: (err: Error) =>
      toast({ title: "Scan failed to start", description: err.message, variant: "destructive" }),
  });

  const saveSla = useMutation({
    mutationFn: async () =>
      (await apiRequest("PUT", `/api/observatory/applications/${applicationId}/perf-sla`, slaForm)).json(),
    onSuccess: () => {
      invalidate();
      setSlaDialogOpen(false);
      toast({ title: "SLA thresholds saved" });
    },
    onError: (err: Error) =>
      toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const saveUrls = useMutation({
    mutationFn: async (extraUrls: string[]) =>
      (await apiRequest("PUT", `/api/observatory/applications/${applicationId}/perf-urls`, { extraUrls })).json(),
    onSuccess: () => {
      invalidate();
      setUrlDialogOpen(false);
      toast({ title: "Monitored URLs saved" });
    },
    onError: (err: Error) =>
      toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  // ── URL dialog helpers ────────────────────────────────────────────────────

  const handleAddUrl = () => {
    const trimmed = newUrl.trim();
    if (!trimmed) return;
    if (!isValidHttpUrl(trimmed)) {
      setNewUrlError("Must be a valid http:// or https:// URL");
      return;
    }
    if (urlList.includes(trimmed)) {
      setNewUrlError("URL is already in the list");
      return;
    }
    if (urlList.length >= 20) {
      setNewUrlError("Maximum 20 extra URLs allowed");
      return;
    }
    setUrlList([...urlList, trimmed]);
    setNewUrl("");
    setNewUrlError("");
  };

  const handleRemoveUrl = (idx: number) => {
    setUrlList(urlList.filter((_, i) => i !== idx));
  };

  const openUrlDialog = () => {
    setUrlList(applicationExtraUrls);
    setNewUrl("");
    setNewUrlError("");
    setUrlDialogOpen(true);
  };

  // ── Derived data ──────────────────────────────────────────────────────────

  // Flatten all page rows across all batches for the history table,
  // newest batch first, pages within a batch in creation order.
  // Include the parent scan's scanSource so the Source column can show Manual/Auto.
  const allPageRows: (PerfScanPage & { batchId: string; batchDate: string; scanSource: "manual" | "scheduled" })[] = [];
  for (const scan of scans) {
    for (const page of scan.pages) {
      allPageRows.push({ ...page, batchId: scan.id, batchDate: scan.createdAt, scanSource: scan.scanSource });
    }
  }

  // Latest completed page for primary URL (for the summary card).
  const latestPrimaryPage = allPageRows.find(
    (p) => p.status === "completed",
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Header toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="font-medium text-sm">Automated Performance Scan</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Measures TTFB, Load Time, LCP, CLS, and TTI via headless browser and flags SLA breaches as findings.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Frequency selector */}
          {canWrite && (
            <div className="flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <Select
                value={initialScanSchedule}
                onValueChange={(v) => setSchedule.mutate(v as ScanSchedule)}
                disabled={setSchedule.isPending}
              >
                <SelectTrigger className="h-8 text-xs w-36" data-testid="select-scan-schedule">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="disabled" data-testid="schedule-option-disabled">On-demand only</SelectItem>
                  <SelectItem value="weekly" data-testid="schedule-option-weekly">Weekly</SelectItem>
                  <SelectItem value="daily" data-testid="schedule-option-daily">Daily</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {!canWrite && initialScanSchedule !== "disabled" && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <CalendarClock className="h-3.5 w-3.5" />
              {SCHEDULE_LABELS[initialScanSchedule]}
            </span>
          )}
          {canWrite && (
            <Button variant="outline" size="sm" onClick={openUrlDialog} data-testid="button-open-url-config">
              <Globe className="h-4 w-4 mr-1" /> Pages
              {applicationExtraUrls.length > 0 && (
                <span className="ml-1 text-xs bg-muted rounded px-1">{applicationExtraUrls.length + 1}</span>
              )}
            </Button>
          )}
          {canWrite && (
            <Button variant="outline" size="sm" onClick={() => { setSlaForm(activeSla); setSlaDialogOpen(true); }} data-testid="button-open-sla-config">
              <Settings className="h-4 w-4 mr-1" /> SLA Thresholds
            </Button>
          )}
          {canWrite && (
            <Button
              size="sm"
              onClick={() => triggerScan.mutate()}
              disabled={isScanRunning || triggerScan.isPending}
              data-testid="button-trigger-perf-scan"
            >
              {isScanRunning ? (
                <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Scanning…</>
              ) : (
                <><Play className="h-4 w-4 mr-1" />Run Scan</>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Schedule info banner (when automated schedule is active) */}
      {initialScanSchedule !== "disabled" && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-purple-600/8 border border-purple-600/20 text-xs text-purple-300">
          <CalendarClock className="h-3.5 w-3.5 shrink-0" />
          <span>
            Scans run automatically <strong>{SCHEDULE_LABELS[initialScanSchedule].toLowerCase()}</strong>.
            Existing open findings with the same rule are not duplicated.
          </span>
        </div>
      )}

      {/* SLA summary chips */}
      <div className="flex flex-wrap gap-2 text-xs">
        {[
          { label: "TTFB", value: `${activeSla.ttfbMs} ms` },
          { label: "Load Time", value: `${activeSla.loadTimeMs} ms` },
          { label: "LCP", value: `${activeSla.lcpMs} ms` },
          { label: "CLS", value: String(activeSla.clsScore) },
          { label: "TTI", value: `${activeSla.ttiMs} ms` },
        ].map(({ label, value }) => (
          <span key={label} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-muted text-muted-foreground border border-border">
            <Clock className="h-3 w-3" /><span className="font-medium">{label}</span> ≤ {value}
          </span>
        ))}
        {applicationExtraUrls.length > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-muted text-muted-foreground border border-border">
            <Globe className="h-3 w-3" />
            <span className="font-medium">{applicationExtraUrls.length + 1} pages</span> per scan
          </span>
        )}
      </div>

      {/* Latest completed page summary */}
      {latestPrimaryPage && (
        <Card className="border-border">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              Latest Result — {formatDate(latestPrimaryPage.scannedAt ?? latestPrimaryPage.createdAt)}
              <span className="text-xs text-muted-foreground font-normal truncate max-w-[180px]" title={latestPrimaryPage.scanUrl}>
                {urlPathname(latestPrimaryPage.scanUrl)}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
              {[
                { label: "TTFB", value: latestPrimaryPage.ttfbMs, threshold: activeSla.ttfbMs, fmt: fmtMs },
                { label: "Load", value: latestPrimaryPage.loadTimeMs, threshold: activeSla.loadTimeMs, fmt: fmtMs },
                { label: "LCP", value: latestPrimaryPage.lcpMs, threshold: activeSla.lcpMs, fmt: fmtMs },
                {
                  label: "CLS",
                  value: latestPrimaryPage.clsScore !== null ? latestPrimaryPage.clsScore * 10000 : null,
                  threshold: activeSla.clsScore * 10000,
                  fmt: (v: number | null) => v === null ? "—" : (v / 10000).toFixed(4),
                },
                { label: "TTI", value: latestPrimaryPage.ttiMs, threshold: activeSla.ttiMs, fmt: fmtMs },
              ].map(({ label, value, threshold, fmt }) => {
                const status = metricStatus(value, threshold);
                return (
                  <div
                    key={label}
                    className={`rounded-md border p-3 text-center ${status === "breach" ? "border-red-600/40 bg-red-600/5" : status === "ok" ? "border-green-600/30 bg-green-600/5" : "border-border"}`}
                  >
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className={`text-base font-semibold mt-1 ${status === "breach" ? "text-red-400" : status === "ok" ? "text-green-400" : "text-foreground"}`}>
                      {fmt(value as any)}
                    </p>
                    {status === "breach" && <p className="text-xs text-red-400/70 mt-0.5">SLA breach</p>}
                  </div>
                );
              })}
            </div>
            {latestPrimaryPage.findingCount > 0 && (
              <div className="flex items-center gap-1.5 mt-3 text-xs text-orange-400">
                <AlertTriangle className="h-3.5 w-3.5" />
                {latestPrimaryPage.findingCount} SLA breach finding{latestPrimaryPage.findingCount !== 1 ? "s" : ""} created — see Findings tab
              </div>
            )}
            {latestPrimaryPage.warnings?.length > 0 && (
              <div className="mt-2 text-xs text-muted-foreground">
                ⚠ {latestPrimaryPage.warnings.join("; ")}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Scan history table — one row per URL per batch */}
      <div>
        <p className="text-xs text-muted-foreground mb-2">
          Scan history — one row per page per scan run (last 50 batches)
        </p>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading scan history…
          </div>
        ) : allPageRows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No scans run yet. Click <strong>Run Scan</strong> to start.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="text-left py-2 pr-3 font-normal">Date</th>
                  <th className="text-left py-2 pr-3 font-normal">Page</th>
                  <th className="text-left py-2 pr-3 font-normal">Source</th>
                  <th className="text-right py-2 pr-3 font-normal">TTFB</th>
                  <th className="text-right py-2 pr-3 font-normal">Load</th>
                  <th className="text-right py-2 pr-3 font-normal">LCP</th>
                  <th className="text-right py-2 pr-3 font-normal">CLS</th>
                  <th className="text-right py-2 pr-3 font-normal">TTI</th>
                  <th className="text-right py-2 font-normal">Result</th>
                </tr>
              </thead>
              <tbody>
                {allPageRows.map((page) => (
                  <tr
                    key={page.id}
                    className="border-b border-border/50 hover:bg-muted/30 transition-colors"
                    data-testid={`row-perf-page-${page.id}`}
                  >
                    <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap text-xs">
                      {formatDate(page.scannedAt ?? page.createdAt)}
                    </td>
                    <td className="py-2 pr-3 max-w-[160px]">
                      <span
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground truncate"
                        title={page.scanUrl}
                      >
                        <Link2 className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                        <span className="truncate">{urlPathname(page.scanUrl)}</span>
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      <ScanSourceBadge source={page.scanSource} />
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <MetricCell value={page.ttfbMs} threshold={activeSla.ttfbMs} format={fmtMs} />
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <MetricCell value={page.loadTimeMs} threshold={activeSla.loadTimeMs} format={fmtMs} />
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <MetricCell value={page.lcpMs} threshold={activeSla.lcpMs} format={fmtMs} />
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <MetricCell
                        value={page.clsScore}
                        threshold={activeSla.clsScore}
                        format={(v) => v === null ? "—" : v.toFixed(4)}
                      />
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <MetricCell value={page.ttiMs} threshold={activeSla.ttiMs} format={fmtMs} />
                    </td>
                    <td className="py-2 text-right">
                      {page.status === "failed" && page.scanError ? (
                        <span title={page.scanError}>
                          <PageStatusBadge page={page} />
                        </span>
                      ) : (
                        <PageStatusBadge page={page} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── URL management dialog ──────────────────────────────────────────── */}
      <Dialog open={urlDialogOpen} onOpenChange={setUrlDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Monitored Pages</DialogTitle>
            <DialogDescription>
              Add extra pages to include in every performance scan. The primary application URL is always scanned;
              add inner pages here to catch slow routes that the homepage wouldn't reveal.
              Maximum 20 additional URLs.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {/* Existing URL list */}
            {urlList.length === 0 ? (
              <p className="text-xs text-muted-foreground">No extra pages configured. Only the primary app URL will be scanned.</p>
            ) : (
              <ul className="space-y-1.5">
                {urlList.map((u, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm rounded border border-border bg-muted/40 px-3 py-1.5">
                    <Link2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="flex-1 truncate text-xs" title={u}>{u}</span>
                    {canWrite && (
                      <button
                        type="button"
                        onClick={() => handleRemoveUrl(i)}
                        className="text-muted-foreground hover:text-red-400 transition-colors shrink-0"
                        aria-label={`Remove ${u}`}
                        data-testid={`button-remove-url-${i}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/* Add new URL */}
            {canWrite && urlList.length < 20 && (
              <div className="space-y-1">
                <Label className="text-xs">Add a page URL</Label>
                <div className="flex gap-2">
                  <Input
                    type="url"
                    placeholder="https://example.com/pricing"
                    value={newUrl}
                    onChange={(e) => { setNewUrl(e.target.value); setNewUrlError(""); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddUrl(); } }}
                    className="text-sm"
                    data-testid="input-new-perf-url"
                  />
                  <Button type="button" size="sm" variant="outline" onClick={handleAddUrl} data-testid="button-add-url">
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                {newUrlError && <p className="text-xs text-red-400">{newUrlError}</p>}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setUrlDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={() => saveUrls.mutate(urlList)}
              disabled={saveUrls.isPending}
              data-testid="button-save-urls"
            >
              {saveUrls.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── SLA configuration dialog ───────────────────────────────────────── */}
      <Dialog open={slaDialogOpen} onOpenChange={setSlaDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>SLA Thresholds</DialogTitle>
            <DialogDescription>
              Set the maximum acceptable values for each performance metric. Scans that exceed these thresholds will create findings.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {[
              { key: "ttfbMs" as const, label: "TTFB (ms)", hint: "Default: 800 ms" },
              { key: "loadTimeMs" as const, label: "Load Time (ms)", hint: "Default: 3 000 ms" },
              { key: "lcpMs" as const, label: "LCP (ms)", hint: "Default: 2 500 ms" },
              { key: "ttiMs" as const, label: "TTI (ms)", hint: "Default: 3 800 ms" },
            ].map(({ key, label, hint }) => (
              <div key={key} className="space-y-1">
                <Label className="text-sm">{label}</Label>
                <Input
                  type="number"
                  min={50}
                  value={slaForm[key]}
                  onChange={(e) => setSlaForm({ ...slaForm, [key]: Number(e.target.value) })}
                  data-testid={`input-sla-${key}`}
                />
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
            ))}
            <div className="space-y-1">
              <Label className="text-sm">CLS Score</Label>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={slaForm.clsScore}
                onChange={(e) => setSlaForm({ ...slaForm, clsScore: Number(e.target.value) })}
                data-testid="input-sla-clsScore"
              />
              <p className="text-xs text-muted-foreground">Default: 0.1 (Google "Good" threshold)</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSlaDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => saveSla.mutate()} disabled={saveSla.isPending} data-testid="button-save-sla">
              {saveSla.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface PerfScanPage {
  id: string;
  scanUrl: string;
  status: "running" | "completed" | "failed";
  ttfbMs: number | null;
  loadTimeMs: number | null;
  lcpMs: number | null;
  clsScore: number | null;
  ttiMs: number | null;
  findingCount: number;
  scanError: string | null;
  warnings: string[];
  scannedAt: string | null;
  createdAt: string;
}

function urlPathname(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname || "/";
  } catch {
    return url;
  }
}

function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
