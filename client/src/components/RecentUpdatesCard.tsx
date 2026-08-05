import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useQuery } from "@tanstack/react-query";
import {
  Globe,
  ExternalLink,
  ChevronRight,
  Loader2,
  Activity,
  Rss,
  Linkedin,
  TrendingUp,
} from "lucide-react";
import { Link } from "wouter";

interface ActivityItem {
  id: string;
  type: string;
  description: string;
  summary?: string;
  impact?: string;
  competitorName?: string;
  createdAt: string;
  details?: any;
}

const impactConfig: Record<string, { color: string }> = {
  High: { color: "bg-red-500/10 text-red-500 border-red-500/20" },
  Medium: { color: "bg-amber-500/10 text-amber-500 border-amber-500/20" },
  Low: { color: "bg-blue-500/10 text-blue-500 border-blue-500/20" },
};

const typeIcons: Record<string, React.ReactNode> = {
  website_change: <Globe className="w-3.5 h-3.5 text-blue-500" />,
  blog_post: <Rss className="w-3.5 h-3.5 text-orange-500" />,
  social_update: <Linkedin className="w-3.5 h-3.5 text-[#0A66C2]" />,
  crawl_completed: <TrendingUp className="w-3.5 h-3.5 text-green-500" />,
};

function formatTimeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getChangeDetails(item: ActivityItem) {
  const details = item.details;
  if (!details?.changeAnalysis?.changes) return null;
  return details.changeAnalysis.changes.slice(0, 3);
}

interface RecentUpdatesCardProps {
  entityType: "company-profile" | "product";
  entityId: string;
  entityName: string;
}

export default function RecentUpdatesCard({ entityType, entityId, entityName }: RecentUpdatesCardProps) {
  const apiPath = entityType === "company-profile"
    ? `/api/activity/by-company-profile/${entityId}`
    : `/api/activity/by-product/${entityId}`;

  const { data: activities = [], isLoading: loadingActivity } = useQuery<ActivityItem[]>({
    queryKey: [apiPath],
    queryFn: async () => {
      const res = await fetch(`${apiPath}?limit=10`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!entityId,
  });

  const meaningfulActivities = activities.filter(
    a => a.type !== "crawl_completed"
  );

  const isLoading = loadingActivity;
  const hasContent = meaningfulActivities.length > 0;

  return (
    <Card data-testid={`card-recent-updates-${entityType}`}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="w-4 h-4" />
          Recent Updates
        </CardTitle>
        <CardDescription>Latest monitoring signals</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {!isLoading && !hasContent && (
          <div className="text-center py-4">
            <p className="text-sm text-muted-foreground">
              No updates yet. Run a monitoring check to detect changes.
            </p>
          </div>
        )}

        {!isLoading && hasContent && (
          <div className="space-y-3">
            {meaningfulActivities.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                  Monitoring Signals
                </p>
                <div className="space-y-2">
                  {meaningfulActivities.slice(0, 5).map((item) => {
                    const impact = impactConfig[item.impact || "Low"] || impactConfig.Low;
                    const icon = typeIcons[item.type] || <Globe className="w-3.5 h-3.5 text-muted-foreground" />;
                    const changes = getChangeDetails(item);

                    return (
                      <div key={item.id} className="group" data-testid={`update-signal-${item.id}`}>
                        <div className="flex items-start gap-2">
                          <div className="mt-0.5 shrink-0">{icon}</div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <span className="text-xs font-medium truncate">{item.description}</span>
                              {item.impact && (
                                <Badge variant="outline" className={`text-[9px] px-1 py-0 shrink-0 ${impact.color}`}>
                                  {item.impact}
                                </Badge>
                              )}
                            </div>
                            {item.summary && (
                              <p className="text-[11px] text-muted-foreground line-clamp-2">{item.summary}</p>
                            )}
                            {changes && changes.length > 0 && (
                              <div className="mt-1 space-y-0.5">
                                {changes.map((c: any, ci: number) => (
                                  <div key={ci} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                    <ChevronRight className="w-2.5 h-2.5 shrink-0" />
                                    <Badge variant="outline" className="text-[9px] px-1 py-0">{c.category}</Badge>
                                    <span className="truncate">{c.description}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            <span className="text-[10px] text-muted-foreground/60">{formatTimeAgo(item.createdAt)}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <Link href="/app/intelligence">
              <span className="text-xs text-primary hover:underline cursor-pointer inline-flex items-center gap-1 mt-1" data-testid="link-view-full-briefing">
                View Full Intelligence Briefing
                <ChevronRight className="w-3 h-3" />
              </span>
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
