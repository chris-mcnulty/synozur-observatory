import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  RefreshCw,
  Globe,
  Linkedin,
  Newspaper,
  Building2,
  Target,
  Swords,
  FileText,
  Sparkles,
  Clock,
  LayoutDashboard,
  BarChart2,
  Lightbulb,
  Activity,
  Settings,
  Users,
  LineChart,
  Shield,
  BookOpen,
  ClipboardList,
  Crown,
  Package,
  HelpCircle,
  Brain,
  Rocket,
  Megaphone,
  MessageCircle,
  Mail,
  Library,
  Image,
  LayoutList,
  AtSign,
  HardDrive,
  Puzzle,
  TicketIcon,
  Map,
  Database,
  Info,
  Gem,
  Lock,
  UserCircle,
  Plus,
  Download,
  Play,
  Search,
  Zap,
} from "lucide-react";
import { useLocation } from "wouter";
import { getFullStalenessInfo } from "@/lib/staleness";

interface CommandAction {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  category: string;
  action: () => void;
  keywords?: string[];
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const [, setLocation] = useLocation();
  const [recentActions, setRecentActions] = useState<string[]>([]);

  useEffect(() => {
    const stored = localStorage.getItem("orbit_cmd_recent");
    if (stored) {
      try {
        setRecentActions(JSON.parse(stored));
      } catch { /* ignore */ }
    }
  }, []);

  const trackAction = useCallback((actionId: string) => {
    setRecentActions((prev) => {
      const updated = [actionId, ...prev.filter((id) => id !== actionId)].slice(0, 8);
      localStorage.setItem("orbit_cmd_recent", JSON.stringify(updated));
      return updated;
    });
  }, []);

  const nav = useCallback((path: string, id: string) => {
    trackAction(id);
    setLocation(path);
    onOpenChange(false);
  }, [trackAction, setLocation, onOpenChange]);

  // Fetch competitors for live search
  const { data: competitors = [] } = useQuery({
    queryKey: ["commandPalette", "/api/competitors"],
    queryFn: async () => {
      const res = await fetch("/api/competitors", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open,
  });

  const { data: companyProfile } = useQuery({
    queryKey: ["commandPalette", "/api/company-profile"],
    queryFn: async () => {
      const res = await fetch("/api/company-profile", { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: open,
  });

  const { data: activityData = [] } = useQuery({
    queryKey: ["commandPalette", "/api/activity"],
    queryFn: async () => {
      const res = await fetch("/api/activity", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open,
  });

  // Products, documents, battle cards, and campaigns for global content search.
  // Fetched only when the palette is open to avoid unnecessary load.
  // Namespaced query keys prevent cache collisions with other consumers.
  const { data: products = [] } = useQuery({
    queryKey: ["commandPalette", "/api/products"],
    queryFn: async () => {
      const res = await fetch("/api/products", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open,
  });

  const { data: documents = [] } = useQuery({
    queryKey: ["commandPalette", "/api/documents"],
    queryFn: async () => {
      const res = await fetch("/api/documents", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open,
  });

  const { data: battlecards = [] } = useQuery({
    queryKey: ["commandPalette", "/api/battlecards"],
    queryFn: async () => {
      const res = await fetch("/api/battlecards", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open,
  });

  const { data: campaigns = [] } = useQuery({
    queryKey: ["commandPalette", "/api/campaigns"],
    queryFn: async () => {
      const res = await fetch("/api/campaigns", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open,
  });

  const { data: reports = [] } = useQuery({
    queryKey: ["commandPalette", "/api/reports"],
    queryFn: async () => {
      const res = await fetch("/api/reports", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open,
  });

  // -- Navigation shortcuts (35+ pages) --
  const navigationActions: CommandAction[] = useMemo(() => [
    { id: "nav-overview", label: "Overview", description: "Dashboard home", icon: <LayoutDashboard className="w-4 h-4" />, category: "Navigation", action: () => nav("/app", "nav-overview"), keywords: ["dashboard", "home"] },
    { id: "nav-company-profile", label: "Company Baseline", description: "Your company profile", icon: <Building2 className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/company-profile", "nav-company-profile"), keywords: ["baseline", "company"] },
    { id: "nav-competitors", label: "Competitors", description: "View and manage competitors", icon: <Target className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/competitors", "nav-competitors") },
    { id: "nav-products", label: "Products", description: "Product management", icon: <Package className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/products", "nav-products") },
    { id: "nav-documents", label: "Documents", description: "Grounding documents", icon: <BookOpen className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/documents", "nav-documents") },
    { id: "nav-analysis", label: "Analysis", description: "Competitive analysis", icon: <BarChart2 className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/analysis", "nav-analysis"), keywords: ["themes", "gaps"] },
    { id: "nav-action-items", label: "Action Items", description: "Recommendations & tasks", icon: <Lightbulb className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/action-items", "nav-action-items"), keywords: ["recommendations", "tasks"] },
    { id: "nav-battlecards", label: "Battle Cards", description: "Sales battlecards", icon: <Swords className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/battlecards", "nav-battlecards"), keywords: ["sales"] },
    { id: "nav-data-sources", label: "Data Sources", description: "Manage data sources and freshness", icon: <Database className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/data-sources", "nav-data-sources"), keywords: ["freshness", "crawl"] },
    { id: "nav-activity", label: "Activity", description: "Recent competitor activity", icon: <Activity className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/activity", "nav-activity") },
    { id: "nav-refresh-center", label: "Intelligence Health", description: "Refresh center", icon: <RefreshCw className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/refresh-center", "nav-refresh-center"), keywords: ["refresh", "health"] },
    { id: "nav-intelligence", label: "Intelligence", description: "AI intelligence briefings", icon: <Brain className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/intelligence", "nav-intelligence"), keywords: ["briefing"] },
    { id: "nav-marketing", label: "Marketing Home", description: "Marketing overview", icon: <Megaphone className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/marketing", "nav-marketing") },
    { id: "nav-messaging", label: "Messaging Framework", description: "Brand messaging strategy", icon: <MessageCircle className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/marketing/messaging-framework", "nav-messaging") },
    { id: "nav-gtm", label: "GTM Plan", description: "Go-to-market strategy", icon: <Rocket className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/marketing/gtm-plan", "nav-gtm"), keywords: ["go to market"] },
    { id: "nav-personas", label: "Personas", description: "Buyer personas & ICPs", icon: <UserCircle className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/marketing/personas", "nav-personas"), keywords: ["icp", "buyer"] },
    { id: "nav-marketing-planner", label: "Marketing Projects", description: "Strategic marketing plans", icon: <Gem className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/marketing/projects", "nav-marketing-planner"), keywords: ["planner", "plan", "projects"] },
    { id: "nav-campaigns", label: "Social Campaigns", description: "Social media campaigns", icon: <LayoutList className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/marketing/campaigns", "nav-campaigns") },
    { id: "nav-email", label: "Email Newsletters", description: "Email marketing", icon: <Mail className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/marketing/email-newsletters", "nav-email"), keywords: ["newsletter"] },
    { id: "nav-content-library", label: "Digital/Web Assets", description: "URLs, articles, and web-based content", icon: <Library className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/marketing/content-library", "nav-content-library"), keywords: ["content library", "asset library", "web assets"] },
    { id: "nav-brand-library", label: "Visual/Brand Assets", description: "Approved images, logos, and visuals", icon: <Image className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/marketing/brand-library", "nav-brand-library"), keywords: ["brand library", "brand assets", "images", "logos"] },
    { id: "nav-social-accounts", label: "Social Accounts", description: "Connected social accounts", icon: <AtSign className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/marketing/social-accounts", "nav-social-accounts") },
    { id: "nav-browser-ext", label: "Browser Extension", description: "Saturn Capture extension", icon: <Puzzle className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/marketing/browser-extension", "nav-browser-ext") },
    { id: "nav-reports", label: "Reports", description: "PDF competitive reports", icon: <FileText className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/reports", "nav-reports") },
    { id: "nav-assessments", label: "Assessments", description: "Competitive assessments", icon: <ClipboardList className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/assessments", "nav-assessments") },
    { id: "nav-users", label: "User Management", description: "Manage users", icon: <Users className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/users", "nav-users") },
    { id: "nav-usage", label: "Usage & Traffic", description: "Analytics", icon: <LineChart className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/usage", "nav-usage"), keywords: ["analytics", "traffic"] },
    { id: "nav-settings", label: "Settings", description: "App settings", icon: <Settings className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/settings", "nav-settings") },
    { id: "nav-admin", label: "Admin Dashboard", description: "Global admin panel", icon: <Crown className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/admin", "nav-admin") },
    { id: "nav-ai-settings", label: "AI Settings", description: "AI model configuration", icon: <Brain className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/admin/ai-settings", "nav-ai-settings") },
    { id: "nav-spe-storage", label: "Document Storage", description: "SharePoint storage admin", icon: <HardDrive className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/admin/spe-storage", "nav-spe-storage") },
    { id: "nav-getting-started", label: "Getting Started", description: "Onboarding guide", icon: <Rocket className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/getting-started", "nav-getting-started"), keywords: ["onboarding"] },
    { id: "nav-support", label: "Support", description: "Help & support", icon: <TicketIcon className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/support", "nav-support") },
    { id: "nav-guide", label: "User Guide", description: "Documentation", icon: <HelpCircle className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/guide", "nav-guide") },
    { id: "nav-changelog", label: "Changelog", description: "What's new", icon: <FileText className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/changelog", "nav-changelog") },
    { id: "nav-roadmap", label: "Roadmap", description: "Product roadmap", icon: <Map className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/roadmap", "nav-roadmap") },
    { id: "nav-about", label: "About", description: "About Orbit", icon: <Info className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/about", "nav-about") },
    { id: "nav-positioning-map", label: "Positioning Map", description: "Competitive positioning map", icon: <Map className="w-4 h-4" />, category: "Navigation", action: () => nav("/app/positioning-map", "nav-positioning-map"), keywords: ["scatter", "axis", "position"] },
  ], [nav]);

  // -- Competitor search --
  const competitorActions: CommandAction[] = useMemo(() =>
    competitors.map((c: any) => ({
      id: `comp-${c.id}`,
      label: c.name,
      description: c.websiteUrl || "Competitor",
      icon: <Target className="w-4 h-4" />,
      category: "Competitors",
      action: () => nav(`/app/competitors/${c.id}`, `comp-${c.id}`),
      keywords: [c.name?.toLowerCase(), c.websiteUrl?.toLowerCase()].filter(Boolean),
    })),
  [competitors, nav]);

  // -- Product search --
  const productActions: CommandAction[] = useMemo(() =>
    products.map((p: any) => ({
      id: `product-${p.id}`,
      label: p.name,
      description: p.companyName || p.clientName || "Product",
      icon: <Package className="w-4 h-4" />,
      category: "Products",
      action: () => nav(`/app/products/${p.id}`, `product-${p.id}`),
      keywords: [p.name?.toLowerCase(), p.companyName?.toLowerCase(), p.clientName?.toLowerCase()].filter(Boolean),
    })),
  [products, nav]);

  // -- Document search --
  const documentActions: CommandAction[] = useMemo(() =>
    documents.slice(0, 25).map((d: any) => ({
      id: `doc-${d.id}`,
      label: d.title || d.fileName || "Document",
      description: d.description || d.fileName || "Grounding document",
      icon: <BookOpen className="w-4 h-4" />,
      category: "Documents",
      action: () => nav("/app/documents", `doc-${d.id}`),
      keywords: [d.title?.toLowerCase(), d.fileName?.toLowerCase(), d.description?.toLowerCase()].filter(Boolean),
    })),
  [documents, nav]);

  // -- Battle card search --
  const battleCardActions: CommandAction[] = useMemo(() =>
    battlecards.slice(0, 25).map((b: any) => ({
      id: `bc-${b.id}`,
      label: b.title || b.competitorName || "Battle Card",
      description: b.competitorName ? `Battle card — ${b.competitorName}` : "Battle card",
      icon: <Swords className="w-4 h-4" />,
      category: "Battle Cards",
      action: () => nav("/app/battlecards", `bc-${b.id}`),
      keywords: [b.title?.toLowerCase(), b.competitorName?.toLowerCase()].filter(Boolean),
    })),
  [battlecards, nav]);

  // -- Campaign search --
  const campaignActions: CommandAction[] = useMemo(() =>
    campaigns.slice(0, 25).map((c: any) => ({
      id: `camp-${c.id}`,
      label: c.name || "Campaign",
      description: c.description?.slice(0, 80) || c.status || "Marketing campaign",
      icon: <LayoutList className="w-4 h-4" />,
      category: "Campaigns",
      action: () => nav(`/app/marketing/campaigns/${c.id}`, `camp-${c.id}`),
      keywords: [c.name?.toLowerCase(), c.description?.toLowerCase()].filter(Boolean),
    })),
  [campaigns, nav]);

  // -- Report search --
  const reportActions: CommandAction[] = useMemo(() =>
    reports.slice(0, 15).map((r: any) => ({
      id: `report-${r.id}`,
      label: r.title || r.name || "Report",
      description: r.type || "PDF report",
      icon: <FileText className="w-4 h-4" />,
      category: "Reports",
      action: () => nav("/app/reports", `report-${r.id}`),
      keywords: [r.title?.toLowerCase(), r.name?.toLowerCase()].filter(Boolean),
    })),
  [reports, nav]);

  // -- Quick actions --
  const quickActions: CommandAction[] = useMemo(() => [
    {
      id: "action-add-competitor",
      label: "Add Competitor",
      description: "Add a new competitor to track",
      icon: <Plus className="w-4 h-4" />,
      category: "Quick Actions",
      action: () => nav("/app/competitors", "action-add-competitor"),
      keywords: ["new", "competitor", "add"],
    },
    {
      id: "action-run-analysis",
      label: "Run Analysis",
      description: "Generate competitive analysis",
      icon: <Play className="w-4 h-4" />,
      category: "Quick Actions",
      action: () => nav("/app/analysis", "action-run-analysis"),
      keywords: ["analyze", "generate"],
    },
    {
      id: "action-generate-briefing",
      label: "Generate Briefing",
      description: "Create an intelligence briefing",
      icon: <Sparkles className="w-4 h-4" />,
      category: "Quick Actions",
      action: () => nav("/app/intelligence", "action-generate-briefing"),
      keywords: ["intelligence", "ai"],
    },
    {
      id: "action-download-report",
      label: "Download Report",
      description: "Generate and download a PDF report",
      icon: <Download className="w-4 h-4" />,
      category: "Quick Actions",
      action: () => nav("/app/reports", "action-download-report"),
      keywords: ["pdf", "export"],
    },
  ], [nav]);

  // -- Refresh actions with staleness --
  const refreshActions: CommandAction[] = useMemo(() => {
    const actions: CommandAction[] = [];

    if (companyProfile) {
      const staleness = getFullStalenessInfo(companyProfile.lastCrawl);
      actions.push({
        id: "refresh-baseline",
        label: `Refresh ${companyProfile.name} Website`,
        description: `Last updated: ${staleness.timeAgo}`,
        icon: <Globe className="w-4 h-4" />,
        category: "Refresh",
        action: () => {
          fetch(`/api/company-profile/${companyProfile.id}/refresh`, { method: "POST", credentials: "include" });
          trackAction("refresh-baseline");
          onOpenChange(false);
        },
      });
    }

    competitors.forEach((c: any) => {
      const staleness = getFullStalenessInfo(c.lastCrawl);
      actions.push({
        id: `refresh-${c.id}`,
        label: `Refresh ${c.name}`,
        description: `Last updated: ${staleness.timeAgo}`,
        icon: <RefreshCw className="w-4 h-4" />,
        category: "Refresh",
        action: () => {
          fetch(`/api/competitors/${c.id}/crawl`, { method: "POST", credentials: "include" });
          trackAction(`refresh-${c.id}`);
          onOpenChange(false);
        },
        keywords: [c.name?.toLowerCase()],
      });
    });

    return actions;
  }, [companyProfile, competitors, trackAction, onOpenChange]);

  // -- Recent activity entries --
  const recentActivityActions: CommandAction[] = useMemo(() =>
    activityData.slice(0, 5).map((a: any, i: number) => ({
      id: `activity-${i}`,
      label: a.title || a.description?.slice(0, 60) || "Activity",
      description: a.competitorName ? `${a.competitorName} — ${a.type || "update"}` : (a.type || "update"),
      icon: <Zap className="w-4 h-4" />,
      category: "Recent Activity",
      action: () => nav("/app/activity", `activity-${i}`),
    })),
  [activityData, nav]);

  // Combine all actions for recent lookup
  const allActions = useMemo(() => [
    ...quickActions,
    ...navigationActions,
    ...competitorActions,
    ...productActions,
    ...documentActions,
    ...battleCardActions,
    ...campaignActions,
    ...reportActions,
    ...refreshActions,
    ...recentActivityActions,
  ], [quickActions, navigationActions, competitorActions, productActions, documentActions, battleCardActions, campaignActions, reportActions, refreshActions, recentActivityActions]);

  const recentActionObjects = useMemo(() =>
    recentActions.map(id => allActions.find(a => a.id === id)).filter(Boolean) as CommandAction[],
  [recentActions, allActions]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search pages, competitors, products, documents, campaigns..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {recentActionObjects.length > 0 && (
          <>
            <CommandGroup heading="Recent">
              {recentActionObjects.slice(0, 5).map((action) => (
                <CommandItem key={action.id} onSelect={action.action} className="flex items-center gap-3">
                  <Clock className="w-4 h-4 text-muted-foreground" />
                  <div className="flex-1">
                    <div className="font-medium">{action.label}</div>
                    {action.description && <div className="text-xs text-muted-foreground">{action.description}</div>}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        <CommandGroup heading="Quick Actions">
          {quickActions.map((action) => (
            <CommandItem key={action.id} onSelect={action.action} className="flex items-center gap-3" keywords={action.keywords}>
              {action.icon}
              <div className="flex-1">
                <div className="font-medium">{action.label}</div>
                {action.description && <div className="text-xs text-muted-foreground">{action.description}</div>}
              </div>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        {competitorActions.length > 0 && (
          <>
            <CommandGroup heading="Competitors">
              {competitorActions.map((action) => (
                <CommandItem key={action.id} onSelect={action.action} className="flex items-center gap-3" keywords={action.keywords}>
                  {action.icon}
                  <div className="flex-1">
                    <div className="font-medium">{action.label}</div>
                    {action.description && <div className="text-xs text-muted-foreground">{action.description}</div>}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {productActions.length > 0 && (
          <>
            <CommandGroup heading="Products">
              {productActions.map((action) => (
                <CommandItem key={action.id} onSelect={action.action} className="flex items-center gap-3" keywords={action.keywords}>
                  {action.icon}
                  <div className="flex-1">
                    <div className="font-medium">{action.label}</div>
                    {action.description && <div className="text-xs text-muted-foreground">{action.description}</div>}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {documentActions.length > 0 && (
          <>
            <CommandGroup heading="Documents">
              {documentActions.map((action) => (
                <CommandItem key={action.id} onSelect={action.action} className="flex items-center gap-3" keywords={action.keywords}>
                  {action.icon}
                  <div className="flex-1">
                    <div className="font-medium">{action.label}</div>
                    {action.description && <div className="text-xs text-muted-foreground">{action.description}</div>}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {battleCardActions.length > 0 && (
          <>
            <CommandGroup heading="Battle Cards">
              {battleCardActions.map((action) => (
                <CommandItem key={action.id} onSelect={action.action} className="flex items-center gap-3" keywords={action.keywords}>
                  {action.icon}
                  <div className="flex-1">
                    <div className="font-medium">{action.label}</div>
                    {action.description && <div className="text-xs text-muted-foreground">{action.description}</div>}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {campaignActions.length > 0 && (
          <>
            <CommandGroup heading="Campaigns">
              {campaignActions.map((action) => (
                <CommandItem key={action.id} onSelect={action.action} className="flex items-center gap-3" keywords={action.keywords}>
                  {action.icon}
                  <div className="flex-1">
                    <div className="font-medium">{action.label}</div>
                    {action.description && <div className="text-xs text-muted-foreground">{action.description}</div>}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {reportActions.length > 0 && (
          <>
            <CommandGroup heading="Reports">
              {reportActions.map((action) => (
                <CommandItem key={action.id} onSelect={action.action} className="flex items-center gap-3" keywords={action.keywords}>
                  {action.icon}
                  <div className="flex-1">
                    <div className="font-medium">{action.label}</div>
                    {action.description && <div className="text-xs text-muted-foreground">{action.description}</div>}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {recentActivityActions.length > 0 && (
          <>
            <CommandGroup heading="Recent Activity">
              {recentActivityActions.map((action) => (
                <CommandItem key={action.id} onSelect={action.action} className="flex items-center gap-3">
                  {action.icon}
                  <div className="flex-1">
                    <div className="font-medium">{action.label}</div>
                    {action.description && <div className="text-xs text-muted-foreground">{action.description}</div>}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {refreshActions.length > 0 && (
          <>
            <CommandGroup heading="Refresh Data">
              {refreshActions.map((action) => (
                <CommandItem key={action.id} onSelect={action.action} className="flex items-center gap-3" keywords={action.keywords}>
                  {action.icon}
                  <div className="flex-1">
                    <div className="font-medium">{action.label}</div>
                    {action.description && <div className="text-xs text-muted-foreground">{action.description}</div>}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        <CommandGroup heading="Navigation">
          {navigationActions.map((action) => (
            <CommandItem key={action.id} onSelect={action.action} className="flex items-center gap-3" keywords={action.keywords}>
              {action.icon}
              <div className="flex-1">
                <div className="font-medium">{action.label}</div>
                {action.description && <div className="text-xs text-muted-foreground">{action.description}</div>}
              </div>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
