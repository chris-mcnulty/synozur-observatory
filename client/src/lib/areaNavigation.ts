import type { ComponentType } from "react";
import {
  Home,
  Inbox,
  Rocket,
  LayoutDashboard,
  Building2,
  Target,
  BarChart2,
  Lightbulb,
  Sparkles,
  Activity,
  Brain,
  Map,
  Database,
  RefreshCw,
  BookOpen,
  Package,
  FolderOpen,
  Telescope,
  Megaphone,
  ListChecks,
  CalendarRange,
  Share2,
  MessageCircle,
  UserCircle,
  Layers,
  Gem,
  LayoutList,
  PencilLine,
  ClipboardList,
  Mail,
  TicketIcon,
  Library,
  Image,
  LineChart,
  Swords,
  FileText,
  Send,
  Zap,
  Gauge,
  Code,
  Handshake,
  Settings,
  Plug,
  AtSign,
  KeyRound,
  Puzzle,
  Users,
  HardDrive,
  Crown,
  Radar,
  AppWindow,
  GitBranch,
  ShieldCheck,
  AlertTriangle,
  Archive,
  BookMarked,
  Eye,
  Crosshair,
  Network,
  Lock,
} from "lucide-react";

export interface AreaNavItem {
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  href: string;
  enterprise?: boolean;
  comingSoon?: boolean;
  /** Renders as a subordinate/nested item beneath the preceding primary entry. */
  indent?: boolean;
  description?: string;
  /** Optional section heading rendered above this item when it differs from the previous item's section. */
  section?: string;
}

export type AreaId = "home" | "research" | "product" | "marketing" | "sales" | "observatory" | "settings";

export interface AppArea {
  id: AreaId;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  /** Landing page for the area — what the header tab links to. */
  hubHref: string;
  /** Areas shown as labeled tabs in the header. Settings is reached via the gear instead. */
  inHeader: boolean;
  items: AreaNavItem[];
}

export interface BuildAreasOptions {
  isEnterprise: boolean;
  isAdminUser: boolean;
  isGlobalAdmin: boolean;
}

/**
 * The app's top-level information architecture: the value chain
 * Home → Research → Product → Marketing → Sales, plus Admin & Settings
 * behind the header gear. Each area owns a short contextual sidebar;
 * the header switches between areas.
 */
export function buildAreas({ isEnterprise, isAdminUser, isGlobalAdmin }: BuildAreasOptions): AppArea[] {
  return [
    {
      id: "home",
      label: "Home",
      icon: Home,
      hubHref: "/app",
      inHeader: false,
      items: [
        { label: "Home", icon: Home, href: "/app", description: "Your company at a glance: signals, summary, and what needs attention." },
        { label: "Needs Attention", icon: Inbox, href: "/app/inbox", description: "Approvals and alerts that need you, across Marketing, Sales, and Research." },
        { label: "Getting Started", icon: Rocket, href: "/app/getting-started" },
      ],
    },
    {
      id: "observatory",
      label: "Observatory",
      icon: Radar,
      hubHref: "/app/observatory",
      inHeader: true,
      items: [
        { label: "Dashboard", icon: LayoutDashboard, href: "/app/observatory", description: "Assurance posture at a glance: open findings, assessments in flight, and recent activity." },
        { label: "Applications", icon: AppWindow, href: "/app/observatory/applications", section: "Portfolio", description: "The application portfolio under assurance — owners, hosting, classification, certification targets." },
        { label: "Versions", icon: GitBranch, href: "/app/observatory/versions", section: "Portfolio", indent: true, description: "Release versions tracked per application with assessment readiness status." },
        { label: "Assessments", icon: ShieldCheck, href: "/app/observatory/assessments", section: "Assurance", description: "Accessibility, security, privacy, AI, and compliance assessments per application version." },
        { label: "Findings", icon: AlertTriangle, href: "/app/observatory/findings", section: "Assurance", description: "Every finding across assessments, filterable by severity, domain, and status." },
        { label: "Evidence Vault", icon: Archive, href: "/app/observatory/evidence", section: "Assurance", description: "Screenshots, scan reports, attestations, and documents linked to findings and assessments." },
        { label: "Accessibility Review", icon: Eye, href: "/app/observatory/review/accessibility", section: "Workbenches", description: "WCAG-aligned checklist workbench across 12 review categories." },
        { label: "Source Code Review", icon: Code, href: "/app/observatory/review/source-code", section: "Workbenches", description: "Secure code review checklist with repository, branch, and commit metadata." },
        { label: "Pen Tests", icon: Crosshair, href: "/app/observatory/pen-tests", section: "Workbenches", description: "Penetration test engagements with CVSS-scored findings and remediation validation." },
        { label: "Architecture Review", icon: Network, href: "/app/observatory/review/architecture", section: "Workbenches", description: "Security architecture areas plus an Azure capability checklist." },
        { label: "Privacy & Compliance", icon: Lock, href: "/app/observatory/review/privacy", section: "Workbenches", description: "Privacy review areas mapped to GDPR, SOC 2, and ISO 27001." },
        { label: "AI Governance", icon: Sparkles, href: "/app/observatory/review/ai-governance", section: "Workbenches", description: "Responsible-AI review workbench for AI-enabled applications." },
        { label: "Standards", icon: BookMarked, href: "/app/observatory/standards", section: "Reference", description: "The standards library: WCAG 2.2, Section 508, EN 301 549, OWASP, SOC 2, ISO 27001, GDPR, Responsible AI." },
        { label: "Reports", icon: FileText, href: "/app/observatory/reports", section: "Reference", comingSoon: true, description: "Certification and readiness reporting." },
        { label: "Settings", icon: Settings, href: "/app/settings", section: "Reference" },
      ],
    },
    {
      id: "research",
      label: "Research",
      icon: Telescope,
      hubHref: "/app/dashboard",
      inHeader: false,
      // Grouped into scannable sections (Workspace / Analysis / Signals /
      // Insights / Sources) so the long Research surface reads as a handful
      // of clusters rather than a flat 16-item list.
      items: [
        { label: "Overview", icon: LayoutDashboard, href: "/app/dashboard", section: "Workspace" },
        { label: "Company Profile", icon: Building2, href: "/app/company-profile", section: "Workspace" },
        { label: "Competitors", icon: Target, href: "/app/competitors", section: "Workspace" },
        { label: "Analysis", icon: BarChart2, href: "/app/analysis", section: "Analysis" },
        { label: "Action Items", icon: Lightbulb, href: "/app/action-items", section: "Analysis" },
        { label: "AI Recommendations", icon: Sparkles, href: "/app/recommendations", section: "Analysis" },
        { label: "Activity", icon: Activity, href: "/app/activity", section: "Signals" },
        { label: "Intelligence Feed", icon: Brain, href: "/app/intelligence", section: "Signals" },
        { label: "SEO & Share of Voice", icon: LineChart, href: "/app/seo-dashboard", section: "Signals", description: "Keyword rankings (SERP) and competitive share-of-voice tracking." },
        { label: "Positioning Map", icon: Map, href: "/app/positioning-map", section: "Insights" },
        { label: "Executive Summary", icon: FileText, href: "/app/executive-summary", section: "Insights", description: "Baseline executive summary: company snapshot, market position, landscape, opportunities." },
        { label: "Visualizations", icon: BarChart2, href: "/app/insights/visualizations", section: "Insights" },
        { label: "Outcomes & Orbit Score", icon: Gauge, href: "/app/insights/outcomes", section: "Insights", description: "ROI dashboard: Orbit Score, GA4 analytics, and outcome trends." },
        { label: "Data Sources", icon: Database, href: "/app/data-sources", section: "Sources" },
        { label: "Intelligence Health", icon: RefreshCw, href: "/app/refresh-center", section: "Sources" },
        { label: "Documents", icon: BookOpen, href: "/app/documents", section: "Sources" },
      ],
    },
    {
      id: "product",
      label: "Product",
      icon: Package,
      hubHref: "/app/products",
      inHeader: false,
      items: [
        {
          label: "Products",
          icon: Package,
          href: "/app/products",
          description: "Portfolio of products — each generates battlecards, one-sheets, GTM plans, roadmaps, and exec summaries.",
        },
        {
          label: "Collateral",
          icon: FolderOpen,
          href: "/app/products/collateral",
          description: "Every product's generated strategy and go-to-market artifacts in one view.",
        },
      ],
    },
    {
      id: "marketing",
      label: "Marketing",
      icon: Megaphone,
      hubHref: "/app/marketing",
      inHeader: false,
      items: [
        { label: "Marketing Home", icon: Megaphone, href: "/app/marketing" },
        // Calendar: one cluster for the ways to see scheduled work — the
        // cross-channel Calendar (default), the drag-and-drop Board, the
        // social-only view, and the Orbit Posting Queue. Each page also shows
        // a shared view switcher.
        { label: "Content Calendar", icon: CalendarRange, href: "/app/marketing/marketing-calendar", enterprise: true, section: "Calendar", description: "Cross-channel overview of every scheduled social post, email, and content piece." },
        { label: "Pipeline Board", icon: ListChecks, href: "/app/marketing/pipeline", enterprise: true, section: "Calendar", indent: true, description: "Every in-flight post, email, and brief on one board, draggable between stages." },
        { label: "Social Calendar", icon: Share2, href: "/app/marketing/calendar", enterprise: true, section: "Calendar", indent: true, description: "Social-only view to schedule, reschedule, and add graphics to posts." },
        { label: "Posting Queue", icon: Zap, href: "/app/marketing/queue", enterprise: true, section: "Calendar", indent: true, description: "Everything Orbit is publishing across campaigns, sorted by send time, failures first." },
        { label: "Messaging Framework", icon: MessageCircle, href: "/app/marketing/messaging-framework", section: "Plan", description: "AI-generated messaging and positioning built from your competitive gaps." },
        { label: "GTM Plan", icon: Rocket, href: "/app/marketing/gtm-plan", section: "Plan", description: "A strategic go-to-market plan derived from your competitive analysis." },
        { label: "Personas", icon: UserCircle, href: "/app/marketing/personas", section: "Plan", description: "Define buyer personas and ICPs to ground content in your audience." },
        { label: "Solution Areas", icon: Layers, href: "/app/marketing/solution-areas", enterprise: true, section: "Plan", description: "Organize messaging and content around your core solution themes." },
        ...(isEnterprise
          ? [{ label: "Marketing Projects", icon: Gem, href: "/app/marketing/projects", enterprise: true, section: "Plan", description: "Strategic, multi-activity marketing plans across 14 categories." }]
          : []),
        { label: "Campaigns", icon: LayoutList, href: "/app/marketing/campaigns", enterprise: true, section: "Create", description: "Coordinate multi-channel campaigns and generate their content." },
        { label: "Content Briefs", icon: FileText, href: "/app/marketing/editorial-calendar", enterprise: true, section: "Create", indent: true, description: "Browse and manage all content briefs across calendars, including LinkedIn Digest briefs." },
        { label: "Composer", icon: PencilLine, href: "/app/marketing/composer", enterprise: true, section: "Create", description: "Draft and refine individual social posts with AI assistance." },
        { label: "Email Newsletters", icon: Mail, href: "/app/marketing/email-newsletters", enterprise: true, section: "Create", description: "AI-generated newsletter content grounded in your intelligence." },
        { label: "Email Sends", icon: Send, href: "/app/marketing/sends", enterprise: true, section: "Create", indent: true, description: "Delivery tracking: recipient lists, send status, and suppressions." },
        { label: "Event Promotion", icon: TicketIcon, href: "/app/marketing/conferences", enterprise: true, section: "Create", description: "Coordinated social promotion for an event: anchor posts plus a post and graphic per session." },
        { label: "Themes Hub", icon: Target, href: "/app/marketing/planning-hub", enterprise: true, section: "Create", description: "Plan every piece of marketing for a solution-area theme or campaign in one view." },
        { label: "Digital/Web Assets", icon: Library, href: "/app/marketing/content-library", enterprise: true, section: "Libraries", description: "Central repository for URLs, articles, and web-based content." },
        { label: "Visual/Brand Assets", icon: Image, href: "/app/marketing/brand-library", enterprise: true, section: "Libraries", description: "Manage approved images, logos, and visual brand identity." },
        { label: "Performance", icon: LineChart, href: "/app/marketing/performance", enterprise: true, section: "Measure", description: "Track link clicks and content performance across channels." },
      ],
    },
    {
      id: "sales",
      label: "Sales",
      icon: Handshake,
      hubHref: "/app/sales",
      inHeader: false,
      items: [
        { label: "Sales Home", icon: Handshake, href: "/app/sales" },
        { label: "Outreach", icon: Send, href: "/app/sales/outreach", description: "Goal-driven outbound campaigns: prospect, score, draft in your voice, and sequence follow-ups — you approve every send." },
        { label: "Battle Cards", icon: Swords, href: "/app/battlecards", description: "Competitive one-pagers for sellers — generated per product in the Product area." },
        { label: "Reports", icon: FileText, href: "/app/reports" },
        { label: "Relationship Plans", icon: Handshake, href: "/app/relationship-reports" },
        { label: "Assessments", icon: ClipboardList, href: "/app/assessments" },
      ],
    },
    {
      id: "settings",
      label: "Admin & Settings",
      icon: Settings,
      hubHref: "/app/settings",
      inHeader: false,
      items: [
        { label: "Settings", icon: Settings, href: "/app/settings" },
        { label: "Integrations", icon: Plug, href: "/app/settings/integrations" },
        { label: "Developer Portal", icon: Code, href: "/app/developer", description: "OAuth 2.0 Partner API for third-party integrations." },
        // One-time setup surfaces moved out of the daily-work Marketing menu.
        { label: "Social Accounts", icon: AtSign, href: "/app/marketing/social-accounts", section: "Connections" },
        { label: "Browser Extension", icon: Puzzle, href: "/app/marketing/browser-extension", section: "Connections" },
        ...(isAdminUser
          ? [
              { label: "User Management", icon: Users, href: "/app/users", section: "Administration" },
              { label: "Usage & Traffic", icon: LineChart, href: "/app/usage", section: "Administration" },
              { label: "Company Roster", icon: Building2, href: "/app/company-roster", section: "Administration" },
              { label: "Document Storage", icon: HardDrive, href: "/app/admin/spe-storage", section: "Administration" },
            ]
          : []),
        ...(isGlobalAdmin
          ? [
              { label: "Admin Dashboard", icon: Crown, href: "/app/admin", section: "Administration" },
              { label: "Organizations", icon: Building2, href: "/app/admin/organizations", section: "Administration" },
              { label: "OAuth Clients", icon: KeyRound, href: "/app/admin/oauth-clients", section: "Administration" },
              { label: "Platform Credentials", icon: KeyRound, href: "/app/admin/platform-credentials", section: "Administration", description: "Synozur-owned social OAuth apps (X, Meta) used by all tenants." },
              { label: "AI Settings", icon: Brain, href: "/app/admin/ai-settings", section: "Administration" },
            ]
          : []),
      ],
    },
  ];
}

// Route → area classification. Order matters: more specific prefixes are
// checked before broader ones (the Connections pages live under
// /app/marketing/* but belong to Settings).
const SETTINGS_PREFIXES = [
  "/app/settings",
  "/app/users",
  "/app/usage",
  "/app/company-roster",
  "/app/admin",
  "/app/developer",
  "/app/marketing/social-accounts",
  "/app/marketing/browser-extension",
];

const SALES_PREFIXES = ["/app/sales", "/app/sales/outreach", "/app/battlecards", "/app/reports", "/app/relationship-reports", "/app/assessments"];

const PRODUCT_PREFIXES = ["/app/products"];

// "/app/marketing-planner" is the legacy path for Marketing Projects (now
// "/app/marketing/projects"); kept here so the redirect still classifies as
// Marketing.
const MARKETING_PREFIXES = ["/app/marketing", "/app/marketing-planner"];

const RESEARCH_PREFIXES = [
  "/app/dashboard",
  "/app/overview",
  "/app/company-profile",
  "/app/competitors",
  "/app/analysis",
  "/app/recommendations",
  "/app/action-items",
  "/app/activity",
  "/app/intelligence",
  "/app/positioning-map",
  "/app/data-sources",
  "/app/refresh-center",
  "/app/insights",
  "/app/seo-dashboard",
  "/app/executive-summary",
  "/app/documents",
];

function matchesPrefix(path: string, prefixes: string[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(p + "/") || path.startsWith(p + "?"));
}

const OBSERVATORY_PREFIXES = ["/app/observatory"];

export function getActiveAreaId(path: string): AreaId {
  if (matchesPrefix(path, OBSERVATORY_PREFIXES)) return "observatory";
  if (matchesPrefix(path, SETTINGS_PREFIXES)) return "settings";
  if (matchesPrefix(path, SALES_PREFIXES)) return "sales";
  if (matchesPrefix(path, PRODUCT_PREFIXES)) return "product";
  if (matchesPrefix(path, MARKETING_PREFIXES)) return "marketing";
  if (matchesPrefix(path, RESEARCH_PREFIXES)) return "research";
  return "home";
}

export function getActiveArea(areas: AppArea[], path: string): AppArea {
  const id = getActiveAreaId(path);
  return areas.find((a) => a.id === id) ?? areas[0];
}
