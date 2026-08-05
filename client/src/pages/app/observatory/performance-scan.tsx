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
import { useState } from "react";
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
import { Loader2, Play, Settings, CheckCircle2, XCircle, Clock, AlertTriangle, CalendarClock } from "lucide-react";
import { formatDate } from "@/lib/utils";

interface PerfScan {
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
  scanSource: "manual" | "scheduled";
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

function MetricCell({ value, threshold, format }: { value: number | null; threshold: number; format: (v: number | null) => string }) {
  const status = metricStatus(value, threshold);
  return (
    <span
      className={
        status === "breach"
          ? "text-red-400 font-medium"
          : status === "ok"
            ? "text-green-400"
            : "text-muted-foreground"
      }
    >
      {format(value)}
    </span>
  );
}

function ScanStatusBadge({ status }: { status: PerfScan["status"] }) {
  if (status === "completed")
    return <Badge variant="outline" className="bg-green-600/15 text-green-400 border-green-600/30"><CheckCircle2 className="h-3 w-3 mr-1" />Completed</Badge>;
  if (status === "failed")
    return <Badge variant="outline" className="bg-red-600/15 text-red-400 border-red-600/30"><XCircle className="h-3 w-3 mr-1" />Failed</Badge>;
  return <Badge variant="outline" className="bg-blue-500/15 text-blue-400 border-blue-500/30"><Loader2 className="h-3 w-3 mr-1 animate-spin" />Running</Badge>;
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
  /** perfSlaConfig from the application row (may be null → use defaults). */
  applicationSlaConfig?: SlaConfig | null;
  /** Current automated scan cadence from the assessment row. */
  scanSchedule: ScanSchedule;
  canWrite: boolean;
}

export default function PerformanceScanPanel({
  assessmentId,
  applicationId,
  applicationSlaConfig,
  scanSchedule: initialScanSchedule,
  canWrite,
}: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [slaDialogOpen, setSlaDialogOpen] = useState(false);
  const [slaForm, setSlaForm] = useState<SlaConfig>(applicationSlaConfig ?? DEFAULT_SLA);

  const activeSla: SlaConfig = applicationSlaConfig ?? DEFAULT_SLA;

  // Poll scan history (re-fetches every 5s if any scan is running)
  const { data: scans = [], isLoading } = useQuery<PerfScan[]>({
    queryKey: [`/api/observatory/assessments/${assessmentId}/performance-scans`],
    refetchInterval: (data) => {
      if (!Array.isArray(data)) return false;
      const hasRunning = (data as PerfScan[]).some((s) => s.status === "running");
      return hasRunning ? 5000 : false;
    },
  });

  // Poll job queue status
  const { data: jobStatus } = useQuery<{ status: "active" | "pending" | "not_found" }>({
    queryKey: [`/api/observatory/assessments/${assessmentId}/performance-scan/status`],
    refetchInterval: 5000,
  });

  const isScanRunning = jobStatus?.status === "active" || jobStatus?.status === "pending"
    || scans.some((s) => s.status === "running");

  const invalidate = () => {
    queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/observatory") });
  };

  // Trigger scan
  const triggerScan = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/observatory/assessments/${assessmentId}/performance-scan`)).json(),
    onSuccess: (data) => {
      invalidate();
      toast({ title: "Performance scan started", description: `Scanning ${data.scanUrl}…` });
    },
    onError: (err: Error) => toast({ title: "Scan failed to start", description: err.message, variant: "destructive" }),
  });

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

  // Save SLA config
  const saveSla = useMutation({
    mutationFn: async () => (await apiRequest("PUT", `/api/observatory/applications/${applicationId}/perf-sla`, slaForm)).json(),
    onSuccess: () => {
      invalidate();
      setSlaDialogOpen(false);
      toast({ title: "SLA thresholds saved" });
    },
    onError: (err: Error) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const latestCompleted = scans.find((s) => s.status === "completed");

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
                <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Scanning…</>
              ) : (
                <><Play className="h-4 w-4 mr-1" /> Run Scan</>
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
      </div>

      {/* Latest metrics summary */}
      {latestCompleted && (
        <Card className="border-border">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              Latest Result — {formatDate(latestCompleted.scannedAt ?? latestCompleted.createdAt)}
              <ScanSourceBadge source={latestCompleted.scanSource} />
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
              {[
                { label: "TTFB", value: latestCompleted.ttfbMs, threshold: activeSla.ttfbMs, fmt: fmtMs },
                { label: "Load Time", value: latestCompleted.loadTimeMs, threshold: activeSla.loadTimeMs, fmt: fmtMs },
                { label: "LCP", value: latestCompleted.lcpMs, threshold: activeSla.lcpMs, fmt: fmtMs },
                { label: "CLS", value: latestCompleted.clsScore !== null ? latestCompleted.clsScore * 10000 : null, threshold: activeSla.clsScore * 10000, fmt: (v: number | null) => v === null ? "—" : (v / 10000).toFixed(4) },
                { label: "TTI", value: latestCompleted.ttiMs, threshold: activeSla.ttiMs, fmt: fmtMs },
              ].map(({ label, value, threshold, fmt }) => {
                const status = metricStatus(value, threshold);
                return (
                  <div key={label} className={`rounded-md border p-3 text-center ${status === "breach" ? "border-red-600/40 bg-red-600/5" : status === "ok" ? "border-green-600/30 bg-green-600/5" : "border-border"}`}>
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className={`text-base font-semibold mt-1 ${status === "breach" ? "text-red-400" : status === "ok" ? "text-green-400" : "text-foreground"}`}>
                      {fmt(value as any)}
                    </p>
                    {status === "breach" && <p className="text-xs text-red-400/70 mt-0.5">SLA breach</p>}
                  </div>
                );
              })}
            </div>
            {latestCompleted.findingCount > 0 && (
              <div className="flex items-center gap-1.5 mt-3 text-xs text-orange-400">
                <AlertTriangle className="h-3.5 w-3.5" />
                {latestCompleted.findingCount} SLA breach finding{latestCompleted.findingCount !== 1 ? "s" : ""} created — see Findings tab
              </div>
            )}
            {latestCompleted.warnings && latestCompleted.warnings.length > 0 && (
              <div className="mt-2 text-xs text-muted-foreground">
                ⚠ {latestCompleted.warnings.join("; ")}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Scan history table */}
      <div>
        <p className="text-xs text-muted-foreground mb-2">Scan history (last 50)</p>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading scan history…
          </div>
        ) : scans.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">No scans run yet. Click <strong>Run Scan</strong> to start.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="text-left py-2 pr-3 font-normal">Date</th>
                  <th className="text-left py-2 pr-3 font-normal">Source</th>
                  <th className="text-right py-2 pr-3 font-normal">TTFB</th>
                  <th className="text-right py-2 pr-3 font-normal">Load</th>
                  <th className="text-right py-2 pr-3 font-normal">LCP</th>
                  <th className="text-right py-2 pr-3 font-normal">CLS</th>
                  <th className="text-right py-2 pr-3 font-normal">TTI</th>
                  <th className="text-right py-2 pr-3 font-normal">Findings</th>
                  <th className="text-right py-2 font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {scans.map((scan) => (
                  <tr key={scan.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors" data-testid={`row-perf-scan-${scan.id}`}>
                    <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">
                      {formatDate(scan.scannedAt ?? scan.createdAt)}
                    </td>
                    <td className="py-2 pr-3">
                      <ScanSourceBadge source={scan.scanSource} />
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <MetricCell value={scan.ttfbMs} threshold={activeSla.ttfbMs} format={fmtMs} />
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <MetricCell value={scan.loadTimeMs} threshold={activeSla.loadTimeMs} format={fmtMs} />
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <MetricCell value={scan.lcpMs} threshold={activeSla.lcpMs} format={fmtMs} />
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <MetricCell
                        value={scan.clsScore}
                        threshold={activeSla.clsScore}
                        format={(v) => v === null ? "—" : v.toFixed(4)}
                      />
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <MetricCell value={scan.ttiMs} threshold={activeSla.ttiMs} format={fmtMs} />
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {scan.findingCount > 0 ? (
                        <span className="text-orange-400">{scan.findingCount}</span>
                      ) : scan.status === "completed" ? (
                        <span className="text-green-400">0</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      {scan.status === "failed" && scan.scanError ? (
                        <span title={scan.scanError}><ScanStatusBadge status={scan.status} /></span>
                      ) : (
                        <ScanStatusBadge status={scan.status} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* SLA configuration dialog */}
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
