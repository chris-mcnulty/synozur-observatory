import React, { useState, useEffect } from "react";
import AppLayout from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useUser } from "@/lib/userContext";
import { useToast } from "@/hooks/use-toast";
import { useSearch, useLocation } from "wouter";
import { calculateStaleness, getTimeAgo, getStalenessInfo, type StalenessLevel } from "@/lib/staleness";
import {
  Brain,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Shield,
  Zap,
  Target,
  Loader2,
  FileText,
  ChevronRight,
  Eye,
  Sparkles,
  BarChart3,
  ArrowRight,
  Calendar,
  RefreshCw,
  Newspaper,
  ExternalLink,
  Share2,
  Mail,
  Plus,
  X,
  Download,
  Trash2,
  Globe,
  Activity,
  Users,
  AlertCircle,
  Lock,
  Headphones,
  Play,
  Pause,
  Volume2,
  Bell,
  BellOff,
  Mic,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import SharedSourceFreshnessRow, { type SourceFreshnessItem as SharedSourceFreshnessItem, type SourceFreshnessData as SharedSourceFreshnessData } from "@/components/SourceFreshnessRow";
import { BriefingPanelSkeleton } from "@/components/ui/skeletons";
import { AnnotationRail, CommentPopoverButton } from "@/components/collaboration/CollabComponents";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { useJobStatus, jobStatusLabel } from "@/hooks/use-job-status";

interface BriefingTheme {
  title: string;
  description: string;
  competitors: string[];
  significance: "high" | "medium" | "low";
}

interface CompetitorMovement {
  name: string;
  signals: string[];
  interpretation: string;
  threatLevel: "high" | "medium" | "low" | "none";
}

interface ActionItem {
  title: string;
  description: string;
  urgency: "immediate" | "this_week" | "this_month" | "watch";
  category: string;
  relatedCompetitors: string[];
}

interface RiskAlert {
  title: string;
  description: string;
  severity: "critical" | "warning" | "watch";
  source: string;
}

interface BriefingProgress {
  phase: string;
  phaseLabel: string;
  percent: number;
}

interface BriefingData {
  executiveSummary: string;
  keyThemes: BriefingTheme[];
  competitorMovements: CompetitorMovement[];
  actionItems: ActionItem[];
  riskAlerts: RiskAlert[];
  signalDigest: {
    totalSignals: number;
    byType: Record<string, number>;
    byImpact: Record<string, number>;
    highlights: string[];
  };
  newsArticles?: unknown[];
  periodLabel: string;
  generatedAt: string;
  progress?: BriefingProgress;
}

interface IntelligenceBriefing {
  id: string;
  tenantDomain: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  briefingData: BriefingData;
  signalCount: number;
  competitorCount: number;
  createdAt: string;
  podcastStatus?: string;
  podcastAudioUrl?: string;
  hubspotPushedAt?: string | null;
  hubspotPushResult?: {
    pushed?: number;
    skipped?: number;
    tasksPushed?: number;
    reason?: string;
    at?: string;
  } | null;
}

type SourceFreshnessItem = SharedSourceFreshnessItem;

type SourceFreshnessData = SharedSourceFreshnessData;

// StalenessDot is now handled by shared SourceFreshnessRow component

const hasAdminAccess = (role: string) =>
  role === "Global Admin" || role === "Domain Admin";

const urgencyConfig: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  immediate: { label: "Immediate", color: "status-danger", icon: <Zap className="w-3.5 h-3.5" /> },
  this_week: { label: "This Week", color: "status-warning", icon: <Clock className="w-3.5 h-3.5" /> },
  this_month: { label: "This Month", color: "status-info", icon: <Calendar className="w-3.5 h-3.5" /> },
  watch: { label: "Watch", color: "status-neutral", icon: <Eye className="w-3.5 h-3.5" /> },
};

const severityConfig: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  critical: { label: "Critical", color: "status-danger", icon: <AlertTriangle className="w-3.5 h-3.5" /> },
  warning: { label: "Warning", color: "status-warning", icon: <Shield className="w-3.5 h-3.5" /> },
  watch: { label: "Watch", color: "status-info", icon: <Eye className="w-3.5 h-3.5" /> },
};

const significanceConfig: Record<string, { label: string; color: string }> = {
  high: { label: "High", color: "status-danger" },
  medium: { label: "Medium", color: "status-warning" },
  low: { label: "Low", color: "status-info" },
};

const threatConfig: Record<string, { label: string; color: string }> = {
  high: { label: "High Threat", color: "status-danger" },
  medium: { label: "Medium Threat", color: "status-warning" },
  low: { label: "Low Threat", color: "status-info" },
  none: { label: "No Threat", color: "status-success" },
};

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateRange(start: string, end: string) {
  const s = new Date(start);
  const e = new Date(end);
  const sMonth = s.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const eMonth = e.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${sMonth} – ${eMonth}`;
}

export default function IntelligenceBriefingPage() {
  const { user } = useUser();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const search = useSearch();
  const idFromUrl = new URLSearchParams(search).get("id");
  const [selectedBriefingId, setSelectedBriefingId] = useState<string | null>(idFromUrl);
  const [periodDays, setPeriodDays] = useState("7");
  const [shareEmails, setShareEmails] = useState<string[]>([""]);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [pdfBriefingId, setPdfBriefingId] = useState<string | null>(null);
  const [isGenerateDialogOpen, setIsGenerateDialogOpen] = useState(false);
  const [refreshSelections, setRefreshSelections] = useState<Record<string, boolean>>({});
  const [isRefreshing, setIsRefreshing] = useState(false);
  const isAdmin = user ? hasAdminAccess(user.role) : false;

  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = React.useRef<HTMLAudioElement>(null);

  // Tracks when we first observed a briefing flip to "published", so we
  // can keep polling for the async HubSpot auto-push result for a short
  // window after publish (independent of how long generation itself took).
  const publishObservedAtRef = React.useRef<Map<string, number>>(new Map());

  const { data: tenantInfo } = useQuery<{ features?: Record<string, boolean> }>({
    queryKey: ["/api/tenant/info"],
    queryFn: async () => {
      const r = await fetch("/api/tenant/info", { credentials: "include" });
      return r.ok ? r.json() : {};
    },
  });
  const isAllowed = tenantInfo?.features?.intelligenceBriefings === true;
  const podcastAllowed = tenantInfo?.features?.podcastBriefings === true;
  const scheduledUpdatesAllowed = tenantInfo?.features?.scheduledBriefingUpdates === true;
  const collabAllowed = tenantInfo?.features?.collaboration !== false;

  const handleDownloadPdf = async () => {
    if (!activeBriefingId) return;
    setIsDownloading(true);
    setPdfBriefingId(activeBriefingId);
    try {
      const response = await fetch(`/api/intelligence-briefings/${activeBriefingId}/pdf`, {
        credentials: "include",
      });
      if (!response.ok) {
        let msg = "Failed to download PDF";
        try {
          const errData = await response.json();
          if (errData.error) msg = errData.error;
        } catch {}
        throw new Error(msg);
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const dateStr = briefing ? new Date(briefing.periodEnd).toISOString().split('T')[0] : "export";
      a.download = `Market_Intelligence_${dateStr}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast({ title: "Success", description: "Your PDF is downloading" });
    } catch (error: any) {
      toast({
        title: "Download Failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsDownloading(false);
      setPdfBriefingId(null);
    }
  };

  const pdfJobStatus = useJobStatus(
    pdfBriefingId ? `briefing-pdf:${pdfBriefingId}` : null,
    isDownloading,
  );

  useEffect(() => {
    if (idFromUrl) setSelectedBriefingId(idFromUrl);
  }, [idFromUrl]);

  const { data: briefings = [], isLoading: loadingList } = useQuery<IntelligenceBriefing[]>({
    queryKey: ["/api/intelligence-briefings"],
    queryFn: async () => {
      const res = await fetch("/api/intelligence-briefings?limit=20", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load briefings");
      return res.json();
    },
  });

  const activeBriefingId = selectedBriefingId || (briefings.length > 0 ? briefings[0].id : null);

  const { data: briefing, isLoading: loadingBriefing } = useQuery<IntelligenceBriefing>({
    queryKey: ["/api/intelligence-briefings", activeBriefingId],
    queryFn: async () => {
      const res = await fetch(`/api/intelligence-briefings/${activeBriefingId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load briefing");
      return res.json();
    },
    enabled: !!activeBriefingId,
    // While the active briefing is generating, refetch every 2s so progress
    // phase + percent flow into the UI even when the user navigates back to
    // an already-running briefing they didn't start in this session.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      // While generating, refetch every 2s for progress updates.
      if (data.status === "generating") {
        // Also clear any stale publish-observed marker if the briefing
        // somehow flips back to generating (e.g. a re-run on the same id).
        publishObservedAtRef.current.delete(data.id);
        return 2000;
      }
      // After publish, the HubSpot auto-push fires asynchronously and
      // writes `hubspotPushedAt` back to the briefing once it lands. Poll
      // every 3s for up to ~60s *from the moment we first observed publish*
      // (not from createdAt — generation itself can run for minutes), so
      // the "Pushed to HubSpot" indicator appears without a manual reload.
      if (data.status === "published" && !data.hubspotPushedAt) {
        const ref = publishObservedAtRef.current;
        let firstSeenAt = ref.get(data.id);
        if (firstSeenAt === undefined) {
          firstSeenAt = Date.now();
          ref.set(data.id, firstSeenAt);
        }
        if (Date.now() - firstSeenAt < 60_000) return 3000;
      }
      return false;
    },
  });

  const generationProgress: BriefingProgress | null =
    briefing?.status === "generating"
      ? briefing.briefingData?.progress ?? null
      : null;

  const [generatingBriefingId, setGeneratingBriefingId] = useState<string | null>(null);
  const [generationStartTime, setGenerationStartTime] = useState<number | null>(null);

  // Watches a briefing this session triggered: handles success/failure toasts
  // and timing out. Live progress is sourced from the briefing query above.
  useEffect(() => {
    if (!generatingBriefingId || !briefing || briefing.id !== generatingBriefingId) return;
    const GENERATION_TIMEOUT_MS = 5 * 60 * 1000;
    if (generationStartTime && Date.now() - generationStartTime > GENERATION_TIMEOUT_MS) {
      setGeneratingBriefingId(null);
      setGenerationStartTime(null);
      queryClient.invalidateQueries({ queryKey: ["/api/intelligence-briefings"] });
      toast({ title: "Generation Timed Out", description: "Briefing generation is taking longer than expected. Please check back or try again.", variant: "destructive" });
      return;
    }
    if (briefing.status === "published") {
      setGeneratingBriefingId(null);
      setGenerationStartTime(null);
      queryClient.invalidateQueries({ queryKey: ["/api/intelligence-briefings"] });
      setSelectedBriefingId(briefing.id);
      toast({ title: "Briefing Generated", description: "Your intelligence briefing is ready." });
    } else if (briefing.status === "failed") {
      setGeneratingBriefingId(null);
      setGenerationStartTime(null);
      queryClient.invalidateQueries({ queryKey: ["/api/intelligence-briefings"] });
      toast({ title: "Generation Failed", description: "The briefing could not be generated. Please try again.", variant: "destructive" });
    }
  }, [generatingBriefingId, generationStartTime, briefing, queryClient, toast]);

  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/intelligence-briefings/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ periodDays: parseInt(periodDays) }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Failed to generate briefing");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/intelligence-briefings"] });
      setSelectedBriefingId(data.id);
      if (data.status === "generating") {
        setGeneratingBriefingId(data.id);
        setGenerationStartTime(Date.now());
        toast({ title: "Generating Briefing", description: "Your briefing is being generated. This may take a couple minutes." });
      } else {
        toast({ title: "Briefing Generated", description: "Your intelligence briefing is ready." });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Generation Failed", description: err.message, variant: "destructive" });
    },
  });

  const shareMutation = useMutation({
    mutationFn: async () => {
      const validEmails = shareEmails.filter(e => e.trim() && e.includes("@"));
      if (validEmails.length === 0) throw new Error("Please enter at least one valid email address");

      const res = await fetch(`/api/intelligence-briefings/${activeBriefingId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ emails: validEmails }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Failed to share briefing");
      }
      return res.json();
    },
    onSuccess: (data) => {
      setIsShareDialogOpen(false);
      setShareEmails([""]);
      toast({ 
        title: "Briefing Shared", 
        description: data.message || "The briefing highlights have been shared via email." 
      });
    },
    onError: (err: Error) => {
      toast({ title: "Sharing Failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/intelligence-briefings/${activeBriefingId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to delete briefing");
      }
      return res.json();
    },
    onSuccess: () => {
      setIsDeleteDialogOpen(false);
      const remaining = briefings.filter((b) => b.id !== activeBriefingId);
      setSelectedBriefingId(remaining.length > 0 ? remaining[0].id : null);
      queryClient.invalidateQueries({ queryKey: ["/api/intelligence-briefings"] });
      toast({ title: "Briefing Deleted", description: "The intelligence briefing has been deleted." });
    },
    onError: (err: Error) => {
      toast({ title: "Delete Failed", description: err.message, variant: "destructive" });
    },
  });

  const removeActionItemMutation = useMutation({
    mutationFn: async (index: number) => {
      const res = await fetch(`/api/intelligence-briefings/${activeBriefingId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removeActionIndex: index }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to remove action item");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/intelligence-briefings", activeBriefingId] });
      toast({ title: "Action item removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't remove", description: err.message, variant: "destructive" });
    },
  });

  const podcastGenerateMutation = useMutation({
    mutationFn: async (briefingId: string) => {
      const res = await fetch(`/api/intelligence-briefings/${briefingId}/podcast`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to generate podcast");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Generating Podcast", description: "Your podcast is being generated. This may take a few minutes." });
    },
    onError: (err: Error) => {
      toast({ title: "Podcast Generation Failed", description: err.message, variant: "destructive" });
    },
  });

  const { data: podcastStatus, refetch: refetchPodcastStatus } = useQuery<{ podcastStatus: string; podcastAudioUrl: string | null }>({
    queryKey: ["/api/intelligence-briefings", activeBriefingId, "podcast-status"],
    queryFn: async () => {
      const res = await fetch(`/api/intelligence-briefings/${activeBriefingId}/podcast-status`, { credentials: "include" });
      if (!res.ok) return { podcastStatus: "none", podcastAudioUrl: null };
      return res.json();
    },
    enabled: !!activeBriefingId && podcastAllowed,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.podcastStatus === "generating") return 5000;
      return false;
    },
  });

  const { data: subscription } = useQuery<{ enabled: boolean; frequency: string; id?: string }>({
    queryKey: ["/api/briefing-subscriptions"],
    queryFn: async () => {
      const res = await fetch("/api/briefing-subscriptions", { credentials: "include" });
      if (!res.ok) return { enabled: false, frequency: "weekly" };
      return res.json();
    },
    enabled: scheduledUpdatesAllowed,
  });

  const { data: scheduledConfig } = useQuery<{ enabled: boolean; frequency: string; id?: string }>({
    queryKey: ["/api/scheduled-briefing-config"],
    queryFn: async () => {
      const res = await fetch("/api/scheduled-briefing-config", { credentials: "include" });
      if (!res.ok) return { enabled: false, frequency: "weekly" };
      return res.json();
    },
    enabled: scheduledUpdatesAllowed && isAdmin,
  });

  const scheduledConfigMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await fetch("/api/scheduled-briefing-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ enabled, frequency: "weekly" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to update config");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/scheduled-briefing-config"] });
      toast({
        title: data.enabled ? "Scheduled Updates Enabled" : "Scheduled Updates Disabled",
        description: data.enabled
          ? "Weekly intelligence briefings will be auto-generated for this market."
          : "Automatic weekly briefing generation has been turned off.",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Update Failed", description: err.message, variant: "destructive" });
    },
  });

  const subscriptionMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await fetch("/api/briefing-subscriptions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ enabled, frequency: "weekly" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to update subscription");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/briefing-subscriptions"] });
      toast({
        title: data.enabled ? "Subscribed" : "Unsubscribed",
        description: data.enabled
          ? "You'll receive weekly intelligence briefing emails."
          : "You've been unsubscribed from weekly briefing emails.",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Update Failed", description: err.message, variant: "destructive" });
    },
  });

  const handleTogglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play();
      setIsPlaying(true);
    }
  };

  const handleDownloadAudio = async () => {
    if (!activeBriefingId) return;
    try {
      const response = await fetch(`/api/intelligence-briefings/${activeBriefingId}/podcast-audio`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to download audio");
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const dateStr = briefing ? new Date(briefing.periodEnd).toISOString().split("T")[0] : "export";
      a.download = `Intelligence_Briefing_Podcast_${dateStr}.mp3`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast({ title: "Success", description: "Your podcast is downloading" });
    } catch (error: any) {
      toast({ title: "Download Failed", description: error.message, variant: "destructive" });
    }
  };

  const { data: freshness, refetch: refetchFreshness } = useQuery<SourceFreshnessData>({
    queryKey: ["/api/intelligence-briefings/source-freshness"],
    queryFn: async () => {
      const res = await fetch("/api/intelligence-briefings/source-freshness", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load source freshness");
      return res.json();
    },
    enabled: isAdmin,
    staleTime: 60000,
  });

  const staleSourceKeys = React.useMemo(() => {
    if (!freshness) return [];
    const keys: string[] = [];
    const checkItem = (item: SourceFreshnessItem, prefix: string) => {
      if (calculateStaleness(item.lastCrawl) !== "fresh") keys.push(`${prefix}:${item.id}:crawl`);
      if (calculateStaleness(item.lastWebsiteMonitor) !== "fresh") keys.push(`${prefix}:${item.id}:monitor`);
      if (calculateStaleness(item.lastSocialMonitor) !== "fresh") keys.push(`${prefix}:${item.id}:social`);
    };
    if (freshness.baseline) checkItem(freshness.baseline, "baseline");
    freshness.competitors.forEach(c => checkItem(c, "competitor"));
    return keys;
  }, [freshness]);

  const handleOpenGenerateDialog = () => {
    refetchFreshness();
    const defaultSelections: Record<string, boolean> = {};
    staleSourceKeys.forEach(k => { defaultSelections[k] = false; });
    setRefreshSelections(defaultSelections);
    setIsGenerateDialogOpen(true);
  };

  const handleRefreshAndGenerate = async (refreshFirst: boolean) => {
    if (refreshFirst) {
      const selectedKeys = Object.entries(refreshSelections).filter(([, v]) => v).map(([k]) => k);
      if (selectedKeys.length > 0) {
        setIsRefreshing(true);
        try {
          for (const key of selectedKeys) {
            const [type, id, source] = key.split(":");
            let url = "";
            if (type === "baseline") {
              if (source === "crawl" || source === "monitor") {
                url = `/api/company-profile/${id}/refresh`;
              } else if (source === "social") {
                url = `/api/company-profile/${id}/refresh-social`;
              }
            } else {
              if (source === "crawl") {
                url = `/api/competitors/${id}/crawl`;
              } else if (source === "monitor") {
                url = `/api/competitors/${id}/monitor-website`;
              } else if (source === "social") {
                url = `/api/competitors/${id}/monitor-social`;
              }
            }
            if (url) {
              const res = await fetch(url, { method: "POST", credentials: "include" });
              if (!res.ok) {
                console.warn(`Refresh failed for ${key}: ${res.status}`);
              }
            }
          }
          toast({ title: "Refreshes Triggered", description: `${selectedKeys.length} source refresh(es) started. Generating briefing with latest data...` });
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch {
          toast({ title: "Some Refreshes Failed", description: "Proceeding with generation anyway.", variant: "destructive" });
        } finally {
          setIsRefreshing(false);
        }
      }
    }
    setIsGenerateDialogOpen(false);
    generateMutation.mutate();
  };

  const handleAddEmail = () => setShareEmails([...shareEmails, ""]);
  const handleRemoveEmail = (index: number) => {
    const newEmails = [...shareEmails];
    newEmails.splice(index, 1);
    setShareEmails(newEmails.length > 0 ? newEmails : [""]);
  };
  const handleEmailChange = (index: number, value: string) => {
    const newEmails = [...shareEmails];
    newEmails[index] = value;
    setShareEmails(newEmails);
  };

  const rawBd = briefing?.briefingData;
  const bd = rawBd
    ? {
        ...rawBd,
        executiveSummary: rawBd.executiveSummary ?? "",
        keyThemes: rawBd.keyThemes ?? [],
        riskAlerts: rawBd.riskAlerts ?? [],
        competitorMovements: rawBd.competitorMovements ?? [],
        actionItems: rawBd.actionItems ?? [],
        newsArticles: rawBd.newsArticles ?? [],
        signalDigest: {
          ...(rawBd.signalDigest ?? {}),
          totalSignals: rawBd.signalDigest?.totalSignals ?? 0,
          highlights: rawBd.signalDigest?.highlights ?? [],
          byType: rawBd.signalDigest?.byType ?? {},
        },
      }
    : undefined;
  const isLoading = loadingList || loadingBriefing;

  if (!isAllowed) {
    return (
      <AppLayout>
        <div className="p-6 max-w-7xl mx-auto flex items-center justify-center min-h-[60vh]">
          <Card className="max-w-md text-center" data-testid="card-locked-intelligence-briefings">
            <CardHeader>
              <div className="mx-auto mb-4 p-4 bg-primary/10 rounded-full w-fit">
                <Lock className="w-10 h-10 text-primary" />
              </div>
              <CardTitle>Intelligence Briefings</CardTitle>
              <CardDescription>Available on Pro, Enterprise, and Unlimited plans. Get AI-synthesized market intelligence reports with executive summaries and action items.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild className="w-full" data-testid="button-contact-sales-briefings">
                <a href="mailto:contactus@synozur.com?subject=Plan Upgrade Inquiry - Intelligence Briefings">Contact Sales</a>
              </Button>
            </CardContent>
          </Card>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="max-w-6xl mx-auto space-y-6 p-4 md:p-6">
        {activeBriefingId && collabAllowed && (
          <AnnotationRail
            targetKind="briefing"
            targetId={activeBriefingId}
            readOnly={user?.role === "Consultant"}
          />
        )}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2" data-testid="heading-intelligence-briefing">
              <Brain className="w-6 h-6 text-primary" />
              Intelligence Briefing
              {activeBriefingId && collabAllowed && (
                <CommentPopoverButton
                  targetKind="briefing"
                  targetId={activeBriefingId}
                  readOnly={user?.role === "Consultant"}
                />
              )}
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              AI-synthesized market intelligence from your competitive signals
            </p>
          </div>

          {scheduledUpdatesAllowed && (
            <div className="flex items-center gap-2">
              {isAdmin && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={scheduledConfig?.enabled ? "default" : "outline"}
                        size="sm"
                        className="h-9 gap-2"
                        onClick={() => scheduledConfigMutation.mutate(!scheduledConfig?.enabled)}
                        disabled={scheduledConfigMutation.isPending}
                        data-testid="button-toggle-scheduled-config"
                      >
                        {scheduledConfigMutation.isPending ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Calendar className="w-4 h-4" />
                        )}
                        {scheduledConfig?.enabled ? "Auto-Gen On" : "Auto-Gen Off"}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {scheduledConfig?.enabled
                        ? "Weekly briefings are auto-generated for subscribers. Click to disable."
                        : "Enable weekly auto-generation of briefings for this market."}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              <Button
                variant={subscription?.enabled ? "default" : "outline"}
                size="sm"
                className="h-9 gap-2"
                onClick={() => subscriptionMutation.mutate(!subscription?.enabled)}
                disabled={subscriptionMutation.isPending}
                data-testid="button-toggle-subscription"
              >
                {subscriptionMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : subscription?.enabled ? (
                  <Bell className="w-4 h-4" />
                ) : (
                  <BellOff className="w-4 h-4" />
                )}
                {subscription?.enabled ? "Subscribed" : "Subscribe Weekly"}
              </Button>
            </div>
          )}

          <div className="flex items-center gap-2">
            {loadingList && briefings.length === 0 ? (
              <Skeleton className="h-10 w-[220px] rounded-md" data-testid="skeleton-briefing-history" />
            ) : briefings.length > 1 ? (
              <Select
                value={activeBriefingId || ""}
                onValueChange={(val) => setSelectedBriefingId(val)}
              >
                <SelectTrigger className="w-[220px]" data-testid="select-briefing-history">
                  <SelectValue placeholder="Select briefing..." />
                </SelectTrigger>
                <SelectContent>
                  {briefings.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {formatDateRange(b.periodStart, b.periodEnd)} ({b.signalCount} signals)
                      {b.status === "failed" && " — Failed"}
                      {b.status === "generating" && " — Generating..."}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}

            {briefing && (
              <div className="flex items-center gap-2">
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="h-10" 
                  onClick={handleDownloadPdf}
                  disabled={isDownloading}
                  data-testid="button-download-pdf"
                >
                  {isDownloading ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4 mr-2" />
                  )}
                  {isDownloading ? jobStatusLabel(pdfJobStatus, "Generating…") : "PDF"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-10"
                  data-testid="button-push-briefing-hubspot"
                  onClick={async () => {
                    if (!briefing) return;
                    try {
                      const res = await fetch(`/api/briefings/${encodeURIComponent(briefing.id)}/hubspot/push-summary`, {
                        method: "POST",
                        credentials: "include",
                        headers: { "Content-Type": "application/json" },
                      });
                      if (!res.ok) {
                        const e = await res.json().catch(() => ({}));
                        throw new Error(e.error || "Failed to push to HubSpot");
                      }
                      toast({ title: "Pushed to HubSpot", description: "Briefing attached as a Note on matched companies." });
                    } catch (err: any) {
                      toast({ title: "HubSpot push failed", description: err?.message || "Unknown error", variant: "destructive" });
                    }
                  }}
                >
                  <Share2 className="w-4 h-4 mr-2" />
                  Push to HubSpot
                </Button>
                {briefing.hubspotPushedAt && (
                  <Badge
                    variant="secondary"
                    className="h-10 flex items-center gap-1 px-2"
                    data-testid="badge-pushed-to-hubspot"
                    title={
                      briefing.hubspotPushResult
                        ? `Pushed ${briefing.hubspotPushResult.pushed ?? 0} note(s)` +
                          (briefing.hubspotPushResult.tasksPushed
                            ? `, ${briefing.hubspotPushResult.tasksPushed} task(s)`
                            : "") +
                          ` on ${new Date(briefing.hubspotPushedAt).toLocaleString()}`
                        : `Pushed on ${new Date(briefing.hubspotPushedAt).toLocaleString()}`
                    }
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Pushed to HubSpot
                  </Badge>
                )}
                <Dialog open={isShareDialogOpen} onOpenChange={setIsShareDialogOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm" className="h-10" data-testid="button-share-briefing">
                      <Share2 className="w-4 h-4 mr-2" />
                      Share
                    </Button>
                  </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Share Intelligence Briefing</DialogTitle>
                    <DialogDescription>
                      Send highlights of this briefing via email to your team members.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Recipients</label>
                      {shareEmails.map((email, index) => (
                        <div key={index} className="flex gap-2">
                          <div className="relative flex-1">
                            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                              placeholder="colleague@company.com"
                              className="pl-9"
                              value={email}
                              onChange={(e) => handleEmailChange(index, e.target.value)}
                              data-testid={`input-share-email-${index}`}
                            />
                          </div>
                          {shareEmails.length > 1 && (
                            <Button 
                              variant="ghost" 
                              size="icon" 
                              onClick={() => handleRemoveEmail(index)}
                              data-testid={`button-remove-email-${index}`}
                            >
                              <X className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      ))}
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="w-full mt-2" 
                        onClick={handleAddEmail}
                        data-testid="button-add-email"
                      >
                        <Plus className="w-4 h-4 mr-2" />
                        Add another email
                      </Button>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button 
                      onClick={() => shareMutation.mutate()} 
                      disabled={shareMutation.isPending}
                      className="w-full sm:w-auto"
                      data-testid="button-confirm-share"
                    >
                      {shareMutation.isPending ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Mail className="w-4 h-4 mr-2" />
                      )}
                      Send Highlights
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
                {isAdmin && (
                  <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
                    <DialogTrigger asChild>
                      <Button variant="outline" size="sm" className="h-10 text-destructive hover:text-destructive" data-testid="button-delete-briefing">
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-md">
                      <DialogHeader>
                        <DialogTitle>Delete Intelligence Briefing</DialogTitle>
                        <DialogDescription>
                          Are you sure you want to delete this briefing? This action cannot be undone.
                        </DialogDescription>
                      </DialogHeader>
                      <DialogFooter className="gap-2 sm:gap-0">
                        <Button variant="outline" onClick={() => setIsDeleteDialogOpen(false)} data-testid="button-cancel-delete">
                          Cancel
                        </Button>
                        <Button 
                          variant="destructive" 
                          onClick={() => deleteMutation.mutate()} 
                          disabled={deleteMutation.isPending}
                          data-testid="button-confirm-delete"
                        >
                          {deleteMutation.isPending ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4 mr-2" />
                          )}
                          Delete
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                )}
              </div>
            )}

            {isAdmin && (
              <div className="flex items-center gap-2">
                <Select value={periodDays} onValueChange={setPeriodDays}>
                  <SelectTrigger className="w-[110px]" data-testid="select-briefing-period">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7">7 days</SelectItem>
                    <SelectItem value="14">14 days</SelectItem>
                    <SelectItem value="30">30 days</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  onClick={handleOpenGenerateDialog}
                  disabled={generateMutation.isPending || isRefreshing || !!generatingBriefingId}
                  data-testid="button-generate-briefing"
                >
                  {(generateMutation.isPending || isRefreshing || !!generatingBriefingId) ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Sparkles className="w-4 h-4 mr-2" />
                  )}
                  {generatingBriefingId
                    ? generationProgress
                      ? `${generationProgress.phaseLabel} ${Math.round(generationProgress.percent)}%`
                      : "Generating…"
                    : "Generate"}
                </Button>
              </div>
            )}
          </div>
        </div>

        {isLoading && !bd && <BriefingPanelSkeleton />}

        {!isLoading && !bd && briefings.length === 0 && (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <Brain className="w-12 h-12 text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-semibold mb-2">No Intelligence Briefings Yet</h3>
              <p className="text-muted-foreground text-sm max-w-md mb-6">
                Generate your first intelligence briefing to get AI-synthesized insights from your competitive monitoring signals.
              </p>
              {isAdmin && (
                <Button onClick={handleOpenGenerateDialog} disabled={generateMutation.isPending || isRefreshing || !!generatingBriefingId} data-testid="button-generate-first-briefing">
                  {(generateMutation.isPending || isRefreshing || !!generatingBriefingId) ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
                  {generatingBriefingId ? "Generating..." : "Generate First Briefing"}
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {briefing && briefing.status === "generating" && (
          <div className="space-y-4">
            <Card data-testid="card-briefing-generating">
              <CardContent className="flex items-start gap-3 py-4">
                <Loader2 className="w-5 h-5 animate-spin text-primary shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold">Generating Intelligence Briefing</h3>
                  <p
                    className="text-muted-foreground text-xs"
                    data-testid="text-briefing-phase"
                  >
                    {generationProgress?.phaseLabel || "Preparing…"}
                  </p>
                  <div className="w-full max-w-md mt-2">
                    <Progress
                      value={generationProgress?.percent ?? 0}
                      data-testid="progress-briefing"
                    />
                  </div>
                  <p
                    className="text-xs text-muted-foreground mt-1"
                    data-testid="text-briefing-percent"
                  >
                    {generationProgress
                      ? `${Math.round(generationProgress.percent)}% complete`
                      : "Starting up…"}
                  </p>
                  <p className="text-muted-foreground text-xs mt-2">
                    You can navigate away — the briefing will keep generating and be ready when you return.
                  </p>
                </div>
              </CardContent>
            </Card>
            <BriefingPanelSkeleton />
          </div>
        )}

        {briefing && briefing.status === "failed" && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <AlertCircle className="w-12 h-12 text-destructive mb-4" />
              <h3 className="text-lg font-semibold mb-2">Briefing Generation Failed</h3>
              <p className="text-muted-foreground text-sm max-w-md mb-4">
                {(briefing.briefingData as any)?.error || "This briefing could not be generated. Please try generating a new one."}
              </p>
              {isAdmin && (
                <Button onClick={handleOpenGenerateDialog} data-testid="button-retry-generate">
                  <Sparkles className="w-4 h-4 mr-2" />
                  Generate New Briefing
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {bd && briefing && briefing.status !== "generating" && briefing.status !== "failed" && (
          <div className="space-y-6 animate-in fade-in duration-200 motion-reduce:animate-none">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Card>
                <CardContent className="pt-4 pb-3 px-4">
                  <div className="text-xs text-muted-foreground mb-1">Period</div>
                  <div className="text-sm font-semibold" data-testid="text-briefing-period">
                    {formatDateRange(briefing.periodStart, briefing.periodEnd)}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3 px-4">
                  <div className="text-xs text-muted-foreground mb-1">Signals</div>
                  <div className="text-sm font-semibold" data-testid="text-signal-count">{bd.signalDigest.totalSignals}</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3 px-4">
                  <div className="text-xs text-muted-foreground mb-1">Competitors</div>
                  <div className="text-sm font-semibold" data-testid="text-competitor-count">{briefing.competitorCount}</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3 px-4">
                  <div className="text-xs text-muted-foreground mb-1">News Articles</div>
                  <div className="text-sm font-semibold" data-testid="text-news-count">{bd.newsArticles?.length || 0}</div>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <FileText className="w-5 h-5 text-primary" />
                  Executive Summary
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="prose prose-sm dark:prose-invert max-w-none" data-testid="text-executive-summary">
                  {bd.executiveSummary.split("\n\n").map((para, i) => (
                    <p key={i} className="text-sm leading-relaxed text-foreground/90 mb-3">{para}</p>
                  ))}
                </div>
              </CardContent>
            </Card>

            {podcastAllowed && (
              <Card data-testid="card-podcast-player">
                <CardContent className="pt-4 pb-4 px-4">
                  {podcastStatus?.podcastStatus === "ready" && podcastStatus.podcastAudioUrl ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="p-2 bg-primary/10 rounded-full">
                            <Headphones className="w-4 h-4 text-primary" />
                          </div>
                          <div>
                            <h3 className="text-sm font-semibold">Podcast Briefing</h3>
                            <p className="text-xs text-muted-foreground">Two-host conversational summary</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={handleDownloadAudio}
                            data-testid="button-download-podcast"
                          >
                            <Download className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-9 w-9 p-0 rounded-full shrink-0"
                          onClick={handleTogglePlay}
                          data-testid="button-play-podcast"
                        >
                          {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                        </Button>
                        <div className="flex-1">
                          <audio
                            ref={audioRef}
                            src={podcastStatus.podcastAudioUrl}
                            onEnded={() => setIsPlaying(false)}
                            onPause={() => setIsPlaying(false)}
                            onPlay={() => setIsPlaying(true)}
                            className="w-full h-8"
                            controls
                            controlsList="nodownload"
                            style={{ filter: "invert(0.8) hue-rotate(180deg)", height: "32px" }}
                            data-testid="audio-podcast-player"
                          />
                        </div>
                      </div>
                    </div>
                  ) : podcastStatus?.podcastStatus === "generating" ? (
                    <div className="flex items-center gap-3 py-2">
                      <div className="p-2 bg-primary/10 rounded-full">
                        <Loader2 className="w-4 h-4 text-primary animate-spin" />
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold">Generating Podcast</h3>
                        <p className="text-xs text-muted-foreground">Converting your briefing into an audio podcast. This may take a few minutes...</p>
                      </div>
                    </div>
                  ) : podcastStatus?.podcastStatus === "failed" ? (
                    <div className="flex items-center justify-between py-2">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-destructive/10 rounded-full">
                          <AlertCircle className="w-4 h-4 text-destructive" />
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold">Podcast Generation Failed</h3>
                          <p className="text-xs text-muted-foreground">Something went wrong. You can try again.</p>
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { podcastGenerateMutation.mutate(activeBriefingId!); refetchPodcastStatus(); }}
                        disabled={podcastGenerateMutation.isPending}
                        data-testid="button-retry-podcast"
                      >
                        <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                        Retry
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between py-2">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-muted rounded-full">
                          <Mic className="w-4 h-4 text-muted-foreground" />
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold">Podcast Briefing</h3>
                          <p className="text-xs text-muted-foreground">Generate an AI podcast summary of this briefing</p>
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { podcastGenerateMutation.mutate(activeBriefingId!); setTimeout(() => refetchPodcastStatus(), 1000); }}
                        disabled={podcastGenerateMutation.isPending}
                        data-testid="button-generate-podcast"
                      >
                        {podcastGenerateMutation.isPending ? (
                          <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                        ) : (
                          <Headphones className="w-3.5 h-3.5 mr-1.5" />
                        )}
                        Generate Podcast
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {bd.keyThemes.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-primary" />
                  Key Themes
                </h2>
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                  {bd.keyThemes.map((theme, i) => {
                    const sig = significanceConfig[theme.significance] || significanceConfig.medium;
                    return (
                      <Card key={i} data-testid={`card-theme-${i}`}>
                        <CardContent className="pt-4 pb-4 px-4">
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <h3 className="text-sm font-semibold">{theme.title}</h3>
                            <Badge variant="outline" className={`text-[10px] shrink-0 ${sig.color}`}>{sig.label}</Badge>
                          </div>
                          <p className="text-xs text-muted-foreground leading-relaxed mb-2">{theme.description}</p>
                          {theme.competitors.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {theme.competitors.map((c, ci) => (
                                <span key={ci} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{c}</span>
                              ))}
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}

            {bd.riskAlerts.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-destructive" />
                  Risk Alerts
                </h2>
                <div className="space-y-2">
                  {bd.riskAlerts.map((risk, i) => {
                    const sev = severityConfig[risk.severity] || severityConfig.watch;
                    return (
                      <Card key={i} className={risk.severity === "critical" ? "border-red-500/30" : ""} data-testid={`card-risk-${i}`}>
                        <CardContent className="flex items-start gap-3 pt-4 pb-4 px-4">
                          <div className="shrink-0 mt-0.5">{sev.icon}</div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="text-sm font-semibold">{risk.title}</h3>
                              <Badge variant="outline" className={`text-[10px] ${sev.color}`}>{sev.label}</Badge>
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">{risk.description}</p>
                            <p className="text-[10px] text-muted-foreground/70 mt-1">Source: {risk.source}</p>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}

            {bd.competitorMovements.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                  <Target className="w-5 h-5 text-primary" />
                  Competitive Movements
                </h2>
                <div className="space-y-3">
                  {bd.competitorMovements.map((mov, i) => {
                    const threat = threatConfig[mov.threatLevel] || threatConfig.none;
                    return (
                      <Card key={i} data-testid={`card-movement-${i}`}>
                        <CardContent className="pt-4 pb-4 px-4">
                          <div className="flex items-center justify-between mb-2">
                            <h3 className="text-sm font-semibold">{mov.name}</h3>
                            <Badge variant="outline" className={`text-[10px] ${threat.color}`}>{threat.label}</Badge>
                          </div>
                          {mov.signals.length > 0 && (
                            <ul className="space-y-1 mb-2">
                              {mov.signals.map((sig, si) => (
                                <li key={si} className="text-xs text-muted-foreground flex items-start gap-1.5">
                                  <ChevronRight className="w-3 h-3 mt-0.5 shrink-0 text-primary/50" />
                                  {sig}
                                </li>
                              ))}
                            </ul>
                          )}
                          <Separator className="my-2" />
                          <p className="text-xs text-foreground/80 leading-relaxed">
                            <span className="font-medium">Analysis: </span>{mov.interpretation}
                          </p>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}

            {bd.actionItems.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-primary" />
                  Recommended Actions
                </h2>
                <div className="space-y-2">
                  {bd.actionItems.map((item, i) => {
                    const urg = urgencyConfig[item.urgency] || urgencyConfig.watch;
                    const actionContext = encodeURIComponent(`${item.title}: ${item.description}`);
                    return (
                      <Card key={i} data-testid={`card-action-${i}`}>
                        <CardContent className="flex items-start gap-3 pt-4 pb-4 px-4">
                          <div className="shrink-0 mt-0.5">{urg.icon}</div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start gap-2 mb-1 flex-wrap">
                              <h3 className="text-sm font-semibold flex-1 min-w-0">{item.title}</h3>
                              <Badge variant="outline" className={`text-[10px] shrink-0 ${urg.color}`}>{urg.label}</Badge>
                              <Badge variant="secondary" className="text-[10px] shrink-0">{item.category}</Badge>
                              <button
                                type="button"
                                aria-label="Remove action item"
                                data-testid={`action-remove-${i}`}
                                className="shrink-0 p-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                                disabled={removeActionItemMutation.isPending}
                                onClick={() => removeActionItemMutation.mutate(i)}
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">{item.description}</p>
                            {item.relatedCompetitors.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1.5">
                                {item.relatedCompetitors.map((c, ci) => (
                                  <span key={ci} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{c}</span>
                                ))}
                              </div>
                            )}
                            <div className="flex gap-1.5 mt-2">
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 px-2 text-[10px]"
                                      onClick={() => navigate(`/app/marketing/email-newsletters?briefingAction=${actionContext}`)}
                                      data-testid={`action-email-${i}`}
                                    >
                                      <Mail className="w-3 h-3 mr-1" />
                                      Email
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>Create an email addressing this action item</TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 px-2 text-[10px]"
                                      onClick={() => navigate(`/app/marketing/campaigns?briefingAction=${actionContext}`)}
                                      data-testid={`action-social-${i}`}
                                    >
                                      <Share2 className="w-3 h-3 mr-1" />
                                      Social Post
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>Create a social post about this action item</TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 px-2 text-[10px]"
                                      data-testid={`action-hubspot-${i}`}
                                      onClick={async () => {
                                        try {
                                          const res = await fetch("/api/integrations/hubspot/push-task", {
                                            method: "POST",
                                            credentials: "include",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({
                                              subject: item.title.slice(0, 500),
                                              body: `${item.description || ""}\n\nFrom Orbit briefing.`,
                                            }),
                                          });
                                          if (!res.ok) {
                                            const e = await res.json().catch(() => ({}));
                                            throw new Error(e.error || "Failed to push task");
                                          }
                                          toast({ title: "Task pushed to HubSpot" });
                                        } catch (err: any) {
                                          toast({ title: "HubSpot push failed", description: err?.message || "Unknown error", variant: "destructive" });
                                        }
                                      }}
                                    >
                                      <Share2 className="w-3 h-3 mr-1" />
                                      HubSpot Task
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>Push this action item as a HubSpot Task</TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}

            {bd.signalDigest.highlights.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <BarChart3 className="w-5 h-5 text-primary" />
                    Signal Highlights
                  </CardTitle>
                  <CardDescription>Top signals from this period</CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {bd.signalDigest.highlights.map((h, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm" data-testid={`text-highlight-${i}`}>
                        <ArrowRight className="w-3.5 h-3.5 mt-1 shrink-0 text-primary/60" />
                        <span className="text-foreground/80">{h}</span>
                      </li>
                    ))}
                  </ul>

                  {Object.keys(bd.signalDigest.byType).length > 0 && (
                    <div className="mt-4 pt-4 border-t border-border">
                      <div className="text-xs text-muted-foreground mb-2 font-medium">Signal Breakdown</div>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(bd.signalDigest.byType).map(([type, count]) => (
                          <div key={type} className="flex items-center gap-1.5 text-xs bg-muted/50 rounded px-2 py-1">
                            <span className="text-muted-foreground">{type.replace(/_/g, " ")}:</span>
                            <span className="font-semibold">{count as number}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        )}
        <Dialog open={isGenerateDialogOpen} onOpenChange={setIsGenerateDialogOpen}>
          <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Activity className="w-5 h-5 text-primary" />
                Data Source Freshness
              </DialogTitle>
              <DialogDescription>
                Review the freshness of your data sources before generating a briefing for the last {periodDays} days.
              </DialogDescription>
            </DialogHeader>
            {freshness ? (
              <div className="space-y-4 py-2">
                {freshness.competitors.length === 0 && !freshness.baseline ? (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-muted border">
                    <AlertTriangle className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground font-medium">No data sources configured for this market yet.</span>
                  </div>
                ) : freshness.overallStaleness === "fresh" ? (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20">
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                    <span className="text-sm text-green-500 font-medium">All sources are fresh — ready to generate.</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                    <span className="text-sm text-amber-500 font-medium">
                      Some sources are {freshness.overallStaleness}. Select any to refresh before generating.
                    </span>
                  </div>
                )}

                {freshness.baseline && (
                  <div>
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Baseline</div>
                    <SharedSourceFreshnessRow
                      item={freshness.baseline}
                      prefix="baseline"
                      selections={refreshSelections}
                      onToggle={(key) => setRefreshSelections(prev => ({ ...prev, [key]: !prev[key] }))}
                      onRefresh={async (sourceType, itemId) => {
                        const url = sourceType === "social"
                          ? `/api/company-profile/${itemId}/refresh-social`
                          : `/api/company-profile/${itemId}/crawl`;
                        await fetch(url, { method: "POST", credentials: "include" });
                      }}
                    />
                  </div>
                )}

                {freshness.competitors.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                      Competitors ({freshness.competitors.length})
                    </div>
                    <div className="space-y-1">
                      {freshness.competitors.map(c => (
                        <SharedSourceFreshnessRow
                          key={c.id}
                          item={c}
                          prefix="competitor"
                          selections={refreshSelections}
                          onToggle={(key) => setRefreshSelections(prev => ({ ...prev, [key]: !prev[key] }))}
                          onRefresh={async (sourceType, itemId) => {
                            const url = sourceType === "social"
                              ? `/api/competitors/${itemId}/refresh-social`
                              : `/api/competitors/${itemId}/crawl`;
                            await fetch(url, { method: "POST", credentials: "include" });
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}

              </div>
            ) : (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            )}
            <DialogFooter className="gap-2 sm:gap-0">
              {freshness?.overallStaleness !== "fresh" && Object.values(refreshSelections).some(v => v) ? (
                <Button
                  onClick={() => handleRefreshAndGenerate(true)}
                  disabled={isRefreshing || generateMutation.isPending}
                  data-testid="button-refresh-and-generate"
                >
                  {isRefreshing ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4 mr-2" />
                  )}
                  Refresh & Generate
                </Button>
              ) : null}
              <Button
                variant={freshness?.overallStaleness === "fresh" ? "default" : "outline"}
                onClick={() => handleRefreshAndGenerate(false)}
                disabled={isRefreshing || generateMutation.isPending}
                data-testid="button-generate-anyway"
              >
                {generateMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4 mr-2" />
                )}
                {freshness?.overallStaleness === "fresh" ? "Generate Briefing" : "Generate Anyway"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}

// SourceFreshnessRow is now imported from @/components/SourceFreshnessRow
