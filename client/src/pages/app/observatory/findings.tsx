import { useState } from "react";
import AppLayout from "@/components/layout/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { AlertTriangle, Loader2, Search } from "lucide-react";
import { SeverityBadge, FindingStatusBadge, FINDING_SEVERITIES, FINDING_DOMAINS, FINDING_STATUSES, labelFor } from "./shared";

interface FindingRow {
  id: string;
  title: string;
  severity: string;
  domain: string;
  status: string;
  applicationName: string;
  assessmentTitle: string;
  wcagCriterion: string | null;
  cweId: string | null;
}

export default function ObservatoryFindings() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const applicationIdFilter = params.get("applicationId") ?? "";
  const assessmentIdFilter = params.get("assessmentId") ?? "";

  const [severity, setSeverity] = useState("all");
  const [domain, setDomain] = useState("all");
  const [status, setStatus] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");

  const qp = new URLSearchParams();
  if (applicationIdFilter) qp.set("applicationId", applicationIdFilter);
  if (assessmentIdFilter) qp.set("assessmentId", assessmentIdFilter);
  if (severity !== "all") qp.set("severity", severity);
  if (domain !== "all") qp.set("domain", domain);
  if (status !== "all") qp.set("status", status);
  if (searchTerm.trim()) qp.set("search", searchTerm.trim());
  const qs = qp.toString();

  const { data: findings, isLoading } = useQuery<FindingRow[]>({
    queryKey: [`/api/observatory/findings${qs ? `?${qs}` : ""}`],
  });

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-findings-title">Findings</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {assessmentIdFilter || applicationIdFilter
              ? "Filtered view — showing findings for one item only."
              : "Every finding across assessments. Findings are recorded from an assessment's detail page."}
          </p>
        </div>

        {(assessmentIdFilter || applicationIdFilter) && (
          <div className="flex items-center gap-3 rounded-md border bg-muted/40 px-4 py-2 text-sm" data-testid="banner-findings-filter">
            <span className="text-muted-foreground">
              Showing findings for{" "}
              <span className="font-medium text-foreground">
                {(findings?.[0] &&
                  (assessmentIdFilter
                    ? `${findings[0].applicationName} · ${findings[0].assessmentTitle}`
                    : findings[0].applicationName)) ||
                  (assessmentIdFilter ? "this assessment" : "this application")}
              </span>
            </span>
            <Link
              href="/app/observatory/findings"
              className="text-primary hover:underline shrink-0"
              data-testid="link-clear-findings-filter"
            >
              Show all findings
            </Link>
          </div>
        )}

        <div className="flex gap-3 flex-wrap items-center">
          <div className="relative">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9 w-[240px]"
              placeholder="Search findings…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              data-testid="input-search-findings"
            />
          </div>
          <Select value={severity} onValueChange={setSeverity}>
            <SelectTrigger className="w-[150px]" data-testid="select-filter-severity"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All severities</SelectItem>
              {FINDING_SEVERITIES.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={domain} onValueChange={setDomain}>
            <SelectTrigger className="w-[160px]" data-testid="select-filter-domain"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All domains</SelectItem>
              {FINDING_DOMAINS.map((d) => (
                <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-[160px]" data-testid="select-filter-finding-status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {FINDING_STATUSES.map((s) => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (findings ?? []).length === 0 ? (
          <Card>
            <CardContent className="py-12 flex flex-col items-center text-center gap-3">
              <AlertTriangle className="h-10 w-10 text-muted-foreground" />
              <p className="font-medium">No findings match</p>
              <p className="text-sm text-muted-foreground">Adjust the filters, or record findings from an assessment.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {(findings ?? []).map((f) => (
              <Link key={f.id} href={`/app/observatory/findings/${f.id}`}>
                <Card className="cursor-pointer hover:border-primary/50 transition-colors" data-testid={`card-finding-${f.id}`}>
                  <CardContent className="py-3 px-4 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate" data-testid={`text-finding-title-${f.id}`}>{f.title}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {f.applicationName} · {f.assessmentTitle} · {labelFor(FINDING_DOMAINS as any, f.domain)}
                        {f.wcagCriterion ? ` · WCAG ${f.wcagCriterion}` : ""}
                        {f.cweId ? ` · ${f.cweId}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <SeverityBadge severity={f.severity} />
                      <FindingStatusBadge status={f.status} />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
