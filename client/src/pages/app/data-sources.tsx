import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Database,
  Globe,
  Linkedin,
  Instagram,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Minus,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
  Clock,
  Users,
  FileText,
  Rss,
  ChevronDown,
  ChevronRight,
  FileCode,
  Loader2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import AppLayout from "@/components/layout/AppLayout";
import { useToast } from "@/hooks/use-toast";
import StalenessDot from "@/components/ui/StalenessDot";
import DataFreshnessBar from "@/components/DataFreshnessBar";

interface SocialMetrics {
  platform: string;
  companyName: string;
  isBaseline: boolean;
  url?: string;
  followers?: number;
  posts?: number;
  lastChecked?: string;
  status: "connected" | "blocked" | "not_configured";
}

interface DataSourceSummary {
  websitesTracked: number;
  socialProfiles: number;
  documentsUploaded: number;
  lastCrawl?: string;
}

const getSentimentIcon = (sentiment: string) => {
  switch (sentiment) {
    case "positive":
      return <TrendingUp className="w-4 h-4 text-green-500" />;
    case "negative":
      return <TrendingDown className="w-4 h-4 text-red-500" />;
    default:
      return <Minus className="w-4 h-4 text-muted-foreground" />;
  }
};

const getSentimentBadgeColor = (sentiment: string) => {
  switch (sentiment) {
    case "positive":
      return "bg-green-500/10 text-green-400 border-green-500/30";
    case "negative":
      return "bg-red-500/10 text-red-400 border-red-500/30";
    default:
      return "bg-muted text-muted-foreground";
  }
};

const getPlatformIcon = (platform: string) => {
  switch (platform.toLowerCase()) {
    case "linkedin":
      return <Linkedin className="w-5 h-5 text-blue-500" />;
    case "instagram":
      return <Instagram className="w-5 h-5 text-pink-500" />;
    default:
      return <Globe className="w-5 h-5" />;
  }
};

const getPageTypeLabel = (pageType: string) => {
  const labels: Record<string, string> = {
    homepage: "Home",
    about: "About",
    services: "Services",
    products: "Products",
    blog: "Blog",
    other: "Other",
  };
  return labels[pageType] || pageType;
};

function WebsiteEntry({ name, url, lastCrawled, crawlData, badge, isBaseline, entityId, onRefresh, isRefreshing }: {
  name: string;
  url: string;
  lastCrawled?: string;
  crawlData?: any;
  badge: string;
  isBaseline?: boolean;
  entityId?: string;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const pages = crawlData?.pagesCrawled || crawlData?.pages || [];

  return (
    <div className={`rounded-lg ${isBaseline ? "border-2 border-primary/30 bg-primary/5" : "border border-border/50 bg-card/50"}`}>
      <div className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${isBaseline ? "bg-primary/20" : "bg-muted"}`}>
              <Globe className={`w-5 h-5 ${isBaseline ? "text-primary" : ""}`} />
            </div>
            <div>
              <h3 className="font-semibold">{name}</h3>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-muted-foreground hover:text-primary flex items-center gap-1"
              >
                {url} <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StalenessDot lastUpdated={lastCrawled} size="sm" />
            <Badge variant="outline" className={isBaseline ? "bg-primary/10 text-primary border-primary/30" : ""}>
              {badge}
            </Badge>
            {onRefresh && (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 h-7 text-xs px-2"
                onClick={(e) => { e.stopPropagation(); onRefresh(); }}
                disabled={isRefreshing}
                data-testid={`refresh-entry-${entityId || name.toLowerCase().replace(/\s+/g, '-')}`}
              >
                {isRefreshing ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3" />
                )}
                Refresh
              </Button>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between mt-3">
          <div className="flex items-center gap-3">
            {lastCrawled && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Last crawled {new Date(lastCrawled).toLocaleDateString()}
              </p>
            )}
            {pages.length > 0 && (
              <Badge variant="secondary" className="text-xs">
                {pages.length} {pages.length === 1 ? "page" : "pages"} monitored
              </Badge>
            )}
          </div>
          {pages.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(!expanded)}
              className="text-xs"
              data-testid={`button-expand-pages-${name.toLowerCase().replace(/\s+/g, '-')}`}
            >
              {expanded ? <ChevronDown className="w-4 h-4 mr-1" /> : <ChevronRight className="w-4 h-4 mr-1" />}
              {expanded ? "Hide pages" : "Show pages"}
            </Button>
          )}
        </div>
      </div>
      {expanded && pages.length > 0 && (
        <div className="border-t border-border/50 px-4 py-3">
          <div className="space-y-2">
            {pages.map((page: any, index: number) => (
              <div
                key={index}
                className="flex items-center justify-between py-2 px-3 rounded-md bg-background/50 text-sm"
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <FileCode className="w-4 h-4 text-muted-foreground shrink-0" />
                  <a
                    href={page.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-primary truncate"
                    title={page.url}
                  >
                    {page.title || page.url}
                  </a>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-3">
                  <Badge variant="outline" className="text-xs">
                    {getPageTypeLabel(page.pageType)}
                  </Badge>
                  {page.wordCount != null && (
                    <span className="text-xs text-muted-foreground">{page.wordCount.toLocaleString()} words</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          {crawlData?.totalWordCount != null && (
            <p className="text-xs text-muted-foreground mt-3 pt-2 border-t border-border/30">
              Total content: {crawlData.totalWordCount.toLocaleString()} words across {pages.length} pages
            </p>
          )}
        </div>
      )}
      {!lastCrawled && pages.length === 0 && (
        <div className="border-t border-border/50 px-4 py-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Not yet crawled.</p>
            {onRefresh && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 h-7 text-xs"
                onClick={onRefresh}
                disabled={isRefreshing}
                data-testid={`crawl-now-${entityId || name.toLowerCase().replace(/\s+/g, '-')}`}
              >
                {isRefreshing ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3" />
                )}
                Crawl Now
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function DataSourcesPage() {
  const [activeTab, setActiveTab] = useState("overview");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: competitors = [], isLoading: loadingCompetitors } = useQuery({
    queryKey: ["/api/competitors"],
    queryFn: async () => {
      const res = await fetch("/api/competitors", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch competitors");
      return res.json();
    },
  });

  const { data: companyProfile } = useQuery({
    queryKey: ["/api/company-profile"],
    queryFn: async () => {
      const res = await fetch("/api/company-profile", { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
  });

  const { data: documents = [] } = useQuery({
    queryKey: ["/api/documents"],
    queryFn: async () => {
      const res = await fetch("/api/documents", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: tenantInfo } = useQuery<{ plan: string; features?: any }>({
    queryKey: ["/api/tenant/info"],
    queryFn: async () => {
      const res = await fetch("/api/tenant/info", { credentials: "include" });
      if (!res.ok) return { plan: "trial" };
      return res.json();
    },
  });

  const autoRefreshAllowed = tenantInfo?.features?.websiteMonitoring !== false && tenantInfo?.features?.socialMonitoring !== false;

  const [refreshingWebsites, setRefreshingWebsites] = useState<Set<string>>(new Set());
  const [refreshingSocial, setRefreshingSocial] = useState<Set<string>>(new Set());

  const refreshWebsite = async (entityId: string, isBaseline: boolean) => {
    setRefreshingWebsites(prev => new Set(prev).add(entityId));
    try {
      const url = isBaseline
        ? `/api/company-profile/${entityId}/crawl`
        : `/api/competitors/${entityId}/crawl`;
      await fetch(url, { method: "POST", credentials: "include" });
      toast({ title: "Crawl started", description: "Website crawl has been queued" });
      queryClient.invalidateQueries({ queryKey: ["/api/competitors"] });
      queryClient.invalidateQueries({ queryKey: ["/api/company-profile"] });
    } catch {
      toast({ title: "Error", description: "Failed to start crawl", variant: "destructive" });
    } finally {
      setRefreshingWebsites(prev => { const n = new Set(prev); n.delete(entityId); return n; });
    }
  };

  const refreshAllWebsites = async () => {
    const ids = new Set<string>();
    if (companyProfile?.id) ids.add(`baseline-${companyProfile.id}`);
    competitors.forEach((c: any) => ids.add(c.id));
    setRefreshingWebsites(ids);
    try {
      if (companyProfile?.id) {
        await fetch(`/api/company-profile/${companyProfile.id}/crawl`, { method: "POST", credentials: "include" });
      }
      for (const c of competitors) {
        await fetch(`/api/competitors/${c.id}/crawl`, { method: "POST", credentials: "include" });
      }
      toast({ title: "Website crawls started", description: `Queued ${(companyProfile ? 1 : 0) + competitors.length} websites` });
      queryClient.invalidateQueries({ queryKey: ["/api/competitors"] });
      queryClient.invalidateQueries({ queryKey: ["/api/company-profile"] });
    } catch {
      toast({ title: "Error", description: "Failed to start website crawls", variant: "destructive" });
    } finally {
      setRefreshingWebsites(new Set());
    }
  };

  const refreshSocial = async (entityId: string) => {
    setRefreshingSocial(prev => new Set(prev).add(entityId));
    try {
      await fetch(`/api/competitors/${entityId}/refresh-social`, { method: "POST", credentials: "include" });
      toast({ title: "Social refresh started", description: "Social profile update queued" });
      queryClient.invalidateQueries({ queryKey: ["/api/competitors"] });
    } catch {
      toast({ title: "Error", description: "Failed to refresh social data", variant: "destructive" });
    } finally {
      setRefreshingSocial(prev => { const n = new Set(prev); n.delete(entityId); return n; });
    }
  };

  const refreshAllSocial = async () => {
    const withLinkedIn = competitors.filter((c: any) => c.linkedInUrl);
    const ids = new Set<string>(withLinkedIn.map((c: any) => c.id));
    setRefreshingSocial(ids);
    try {
      for (const c of withLinkedIn) {
        await fetch(`/api/competitors/${c.id}/refresh-social`, { method: "POST", credentials: "include" });
      }
      toast({ title: "Social refresh started", description: `Queued ${withLinkedIn.length} social profiles` });
      queryClient.invalidateQueries({ queryKey: ["/api/competitors"] });
    } catch {
      toast({ title: "Error", description: "Failed to refresh social data", variant: "destructive" });
    } finally {
      setRefreshingSocial(new Set());
    }
  };

  const handleFreshnessBarRefresh = async (sources: string[]) => {
    const promises: Promise<void>[] = [];
    if (sources.includes("website")) promises.push(refreshAllWebsites());
    if (sources.includes("social")) promises.push(refreshAllSocial());
    await Promise.all(promises);
  };

  // Calculate oldest timestamps for global freshness bar
  const oldestWebsite = (() => {
    const dates = [
      companyProfile?.lastFullCrawl,
      ...competitors.map((c: any) => c.lastFullCrawl),
    ].filter(Boolean);
    if (dates.length === 0) return null;
    return dates.sort((a: string, b: string) => new Date(a).getTime() - new Date(b).getTime())[0];
  })();

  const oldestSocial = (() => {
    const dates = competitors.map((c: any) => c.lastSocialCrawl).filter(Boolean);
    if (dates.length === 0) return null;
    return dates.sort((a: string, b: string) => new Date(a).getTime() - new Date(b).getTime())[0];
  })();

  const buildSocialMetrics = (): SocialMetrics[] => {
    const metrics: SocialMetrics[] = [];
    
    const allCompanies = [
      ...(companyProfile ? [{ ...companyProfile, isBaseline: true }] : []),
      ...competitors.map((c: any) => ({ ...c, isBaseline: false })),
    ];

    for (const company of allCompanies) {
      const companyName = company.name || "Unknown";
      const isBaseline = !!company.isBaseline;
      if (company.linkedInUrl) {
        metrics.push({
          platform: "LinkedIn",
          companyName,
          isBaseline,
          url: company.linkedInUrl,
          status: "connected",
          lastChecked: company.linkedinLastChecked,
        });
      }
      if (company.instagramUrl) {
        metrics.push({
          platform: "Instagram",
          companyName,
          isBaseline,
          url: company.instagramUrl,
          status: company.instagramContent ? "connected" : "blocked",
          lastChecked: company.instagramLastChecked,
        });
      }
    }

    return metrics;
  };

  const socialMetrics = buildSocialMetrics();
  
  const summary: DataSourceSummary = {
    websitesTracked: (companyProfile ? 1 : 0) + competitors.length,
    socialProfiles: socialMetrics.filter(m => m.status === "connected").length,
    documentsUploaded: documents.length,
    lastCrawl: competitors[0]?.lastCrawled || companyProfile?.lastCrawled,
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Database className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold" data-testid="text-page-title">Data Sources</h1>
              <p className="text-muted-foreground text-sm">View all the intelligence sources feeding into your competitive analysis</p>
            </div>
          </div>
        </div>

        <DataFreshnessBar
          mode="global"
          websiteLastUpdated={oldestWebsite}
          socialLastUpdated={oldestSocial}
          autoRefreshAllowed={autoRefreshAllowed}
          tenantPlan={tenantInfo?.plan}
          onRefresh={handleFreshnessBarRefresh}
        />

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-blue-500/10">
                    <Globe className="w-5 h-5 text-blue-500" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{summary.websitesTracked}</p>
                    <p className="text-sm text-muted-foreground">Websites Tracked</p>
                  </div>
                </div>
                <StalenessDot
                  lastUpdated={oldestWebsite}
                  label="Website data freshness"
                  size="md"
                />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-purple-500/10">
                    <Users className="w-5 h-5 text-purple-500" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{summary.socialProfiles}</p>
                    <p className="text-sm text-muted-foreground">Social Profiles</p>
                  </div>
                </div>
                <StalenessDot
                  lastUpdated={oldestSocial}
                  label="Social data freshness"
                  size="md"
                />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-500/10">
                  <FileText className="w-5 h-5 text-green-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{summary.documentsUploaded}</p>
                  <p className="text-sm text-muted-foreground">Documents Uploaded</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="overview" data-testid="tab-overview">Overview</TabsTrigger>
            <TabsTrigger value="social" data-testid="tab-social">Social Media</TabsTrigger>
            <TabsTrigger value="websites" data-testid="tab-websites">Websites</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-6 space-y-6">
            <div className="grid gap-6 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Users className="w-5 h-5" />
                    Social Media Status
                  </CardTitle>
                  <CardDescription>Connected social profiles and their status</CardDescription>
                </CardHeader>
                <CardContent>
                  {socialMetrics.length > 0 ? (
                    <div className="space-y-3">
                      {socialMetrics.slice(0, 6).map((metric, index) => (
                        <div
                          key={index}
                          className="flex items-center justify-between p-3 rounded-lg bg-card/50 border border-border/50"
                        >
                          <div className="flex items-center gap-3">
                            {getPlatformIcon(metric.platform)}
                            <div>
                              <p className="font-medium text-sm">
                                {metric.companyName}
                                {metric.isBaseline && <span className="text-xs text-primary ml-1">(You)</span>}
                              </p>
                              <p className="text-xs text-muted-foreground">{metric.platform}</p>
                              {metric.url && (
                                <a
                                  href={metric.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1"
                                >
                                  View profile <ExternalLink className="w-3 h-3" />
                                </a>
                              )}
                            </div>
                          </div>
                          <Badge
                            variant="outline"
                            className={
                              metric.status === "connected"
                                ? "bg-green-500/10 text-green-400 border-green-500/30"
                                : metric.status === "blocked"
                                ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/30"
                                : "bg-muted text-muted-foreground"
                            }
                          >
                            {metric.status === "connected" && <CheckCircle2 className="w-3 h-3 mr-1" />}
                            {metric.status === "blocked" && <AlertCircle className="w-3 h-3 mr-1" />}
                            {metric.status}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-8 text-muted-foreground">
                      <Users className="w-12 h-12 mx-auto mb-3 opacity-50" />
                      <p>No social profiles configured</p>
                      <p className="text-xs mt-2">Add LinkedIn or Instagram URLs to competitors</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="social" className="mt-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Social Media Profiles</CardTitle>
                  <CardDescription>Track competitor presence across social platforms</CardDescription>
                </div>
                {competitors.filter((c: any) => c.linkedInUrl).length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={refreshAllSocial}
                    disabled={refreshingSocial.size > 0}
                    data-testid="refresh-all-social-button"
                  >
                    <RefreshCw className={`w-4 h-4 mr-2 ${refreshingSocial.size > 0 ? "animate-spin" : ""}`} />
                    Refresh All Social
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                {loadingCompetitors ? (
                  <div className="space-y-4">
                    {[1, 2, 3].map(i => (
                      <Skeleton key={i} className="h-20 w-full" />
                    ))}
                  </div>
                ) : (
                  <div className="space-y-4">
                    {competitors.map((competitor: any) => (
                      <div
                        key={competitor.id}
                        className="p-4 rounded-lg border border-border/50 bg-card/50"
                      >
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="font-semibold">{competitor.name}</h3>
                          {competitor.lastCrawled && (
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              Last updated {new Date(competitor.lastCrawled).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          {["linkedin", "instagram"].map((platform) => {
                            const url = competitor[`${platform}Url`];
                            return (
                              <div
                                key={platform}
                                className={`p-3 rounded-lg ${
                                  url ? "bg-primary/5 border border-primary/20" : "bg-muted/30"
                                }`}
                              >
                                <div className="flex items-center gap-2 mb-1">
                                  {getPlatformIcon(platform)}
                                  <span className="text-sm font-medium capitalize">{platform}</span>
                                </div>
                                {url ? (
                                  <a
                                    href={url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs text-primary hover:underline flex items-center gap-1"
                                  >
                                    Connected <ExternalLink className="w-3 h-3" />
                                  </a>
                                ) : (
                                  <span className="text-xs text-muted-foreground">Not configured</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    {competitors.length === 0 && (
                      <div className="text-center py-12 text-muted-foreground">
                        <Users className="w-12 h-12 mx-auto mb-3 opacity-50" />
                        <p>No competitors added yet</p>
                        <p className="text-xs mt-2">Add competitors to track their social media presence</p>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="websites" className="mt-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Website Tracking</CardTitle>
                  <CardDescription>Monitored websites and their crawled pages</CardDescription>
                </div>
                {(competitors.length > 0 || companyProfile) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={refreshAllWebsites}
                    disabled={refreshingWebsites.size > 0}
                    data-testid="refresh-all-websites-button"
                  >
                    <RefreshCw className={`w-4 h-4 mr-2 ${refreshingWebsites.size > 0 ? "animate-spin" : ""}`} />
                    Refresh All Websites
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {companyProfile && (
                    <WebsiteEntry
                      name={companyProfile.name || companyProfile.companyName}
                      url={companyProfile.websiteUrl}
                      lastCrawled={companyProfile.lastCrawled}
                      crawlData={companyProfile.crawlData}
                      badge="Baseline"
                      isBaseline
                      entityId={companyProfile.id}
                      onRefresh={() => refreshWebsite(companyProfile.id, true)}
                      isRefreshing={refreshingWebsites.has(`baseline-${companyProfile.id}`)}
                    />
                  )}

                  {competitors.map((competitor: any) => (
                    <WebsiteEntry
                      key={competitor.id}
                      name={competitor.name}
                      url={competitor.websiteUrl || competitor.url}
                      lastCrawled={competitor.lastCrawled || competitor.lastFullCrawl}
                      crawlData={competitor.crawlData}
                      badge="Competitor"
                      entityId={competitor.id}
                      onRefresh={() => refreshWebsite(competitor.id, false)}
                      isRefreshing={refreshingWebsites.has(competitor.id)}
                    />
                  ))}

                  {!companyProfile && competitors.length === 0 && (
                    <div className="text-center py-12 text-muted-foreground">
                      <Globe className="w-12 h-12 mx-auto mb-3 opacity-50" />
                      <p>No websites configured yet</p>
                      <p className="text-xs mt-2">Add your company profile and competitors to start tracking</p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
