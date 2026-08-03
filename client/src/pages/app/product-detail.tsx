import React, { useState } from "react";
import AppLayout from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, Plus, Loader2, Package, Building, Sparkles, Trash2, Star, ExternalLink, Pencil, Wand2, Swords, RefreshCw, Check, X, MessageSquare, FileText, Download, Rocket, MessageCircle, Clock, Copy, List, Map, FileBarChart, Linkedin, Instagram, Twitter, Users, AlertTriangle, Ban } from "lucide-react";
import {
  LongFormContentSkeleton,
  ProductCardGridSkeleton,
  BattlecardListSkeleton,
} from "@/components/ui/skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import FeaturesTab from "@/components/product/FeaturesTab";
import RoadmapTab from "@/components/product/RoadmapTab";
import FeedbackTab from "@/components/product/FeedbackTab";
import { MarkdownContent } from "@/components/MarkdownViewer";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useLocation } from "wouter";
import RecentUpdatesCard from "@/components/RecentUpdatesCard";
import { useUser } from "@/lib/userContext";
import { AnnotationRail, CommentPopoverButton } from "@/components/collaboration/CollabComponents";

interface Product {
  id: string;
  name: string;
  description: string | null;
  url: string | null;
  companyName: string | null;
  competitorId: string | null;
  linkedInUrl: string | null;
  instagramUrl: string | null;
  twitterUrl: string | null;
  socialCheckFrequency: string | null;
  lastSocialCrawl: string | null;
  tenantDomain: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  excludeFromCrawl: boolean;
  consecutiveCrawlFailures: number;
  crawlFlaggedAt: string | null;
}

interface ProjectProduct {
  id: string;
  projectId: string;
  productId: string;
  role: "baseline" | "competitor" | "optional";
  source: "manual" | "suggested";
  createdAt: string;
  product: Product;
}

interface ClientProject {
  id: string;
  name: string;
  clientName: string;
  clientDomain: string | null;
  description: string | null;
  analysisType: "company" | "product";
  status: string;
  tenantDomain: string;
  createdAt: string;
}

interface SuggestedProduct {
  name: string;
  companyName: string;
  description: string;
  url: string;
  rationale: string;
}

interface ProductBattlecard {
  id: string;
  baselineProductId: string;
  competitorProductId: string;
  projectId: string;
  tenantDomain: string;
  strengths: string[] | null;
  weaknesses: string[] | null;
  ourAdvantages: string[] | null;
  keyDifferentiators: { feature: string; ours: string; theirs: string }[] | null;
  objections: { objection: string; response: string }[] | null;
  talkTracks: { scenario: string; script: string }[] | null;
  featureComparison: Record<string, { ours: string; theirs: string }> | null;
  customNotes: string | null;
  status: string;
  lastGeneratedAt: string | null;
  createdAt: string;
}

interface LongFormRecommendation {
  id?: string;
  type: string;
  projectId: string;
  companyProfileId?: string | null;
  tenantDomain?: string;
  content: string | null;
  savedPrompts: {
    targetRoles?: string;
    distributionChannels?: string;
    customGuidance?: string;
    budget?: string;
    timeline?: string;
    targetAudience?: string;
    toneOfVoice?: string;
    keyMessages?: string;
  } | null;
  status: string;
  lastGeneratedAt: string | null;
  generatedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export default function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user: currentUser } = useUser();
  const isAdmin = currentUser?.role === "Domain Admin" || currentUser?.role === "Global Admin";
  const isReadOnlyRole = currentUser?.role === "Consultant";
  const { data: tenantInfo } = useQuery<{ features?: Record<string, boolean> }>({
    queryKey: ["/api/tenant/info"],
    queryFn: async () => {
      const r = await fetch("/api/tenant/info", { credentials: "include" });
      return r.ok ? r.json() : {};
    },
  });
  const collabAllowed = tenantInfo?.features?.collaboration !== false;
  const [isAddProductOpen, setIsAddProductOpen] = useState(false);
  const [isEditProductOpen, setIsEditProductOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [isAutoFetching, setIsAutoFetching] = useState(false);
  const [isAddAutoFetching, setIsAddAutoFetching] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestedProduct[]>([]);
  const [productFormData, setProductFormData] = useState({
    name: "",
    description: "",
    url: "",
    companyName: "",
    isBaseline: false,
    createAsCompetitor: false, // Option to also create as full competitor company
  });
  const [editFormData, setEditFormData] = useState({
    name: "",
    description: "",
    url: "",
    companyName: "",
    linkedInUrl: "",
    instagramUrl: "",
    twitterUrl: "",
    blogUrl: "",
    socialCheckFrequency: "daily",
    isBaseline: false,
  });

  const { data: project, isLoading: projectLoading } = useQuery<ClientProject>({
    queryKey: ["/api/projects", id],
    queryFn: async () => {
      const response = await fetch(`/api/projects/${id}`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch project");
      return response.json();
    },
    enabled: !!id,
  });

  const { data: projectProducts = [], isLoading: productsLoading } = useQuery<ProjectProduct[]>({
    queryKey: ["/api/projects", id, "products"],
    queryFn: async () => {
      const response = await fetch(`/api/projects/${id}/products`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch products");
      return response.json();
    },
    enabled: !!id,
  });

  const { data: allProducts = [] } = useQuery<Product[]>({
    queryKey: ["/api/products"],
    queryFn: async () => {
      const response = await fetch("/api/products", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch products");
      return response.json();
    },
  });

  const { data: battlecards = [], isLoading: battlecardsLoading } = useQuery<ProductBattlecard[]>({
    queryKey: ["/api/projects", id, "battlecards"],
    queryFn: async () => {
      const response = await fetch(`/api/projects/${id}/battlecards`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch battlecards");
      return response.json();
    },
    enabled: !!id,
  });

  const [generatingBattlecardFor, setGeneratingBattlecardFor] = useState<string | null>(null);
  const [selectedBattlecard, setSelectedBattlecard] = useState<ProductBattlecard | null>(null);
  
  const [location, setLocation] = useLocation();
  
  const validTabs = ["overview", "gaps", "recommendations", "summary", "gtm_plan", "messaging", "features", "roadmap", "feedback"];
  const urlParams = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const tabFromUrl = urlParams.get("tab");
  const initialTab = tabFromUrl && validTabs.includes(tabFromUrl) ? tabFromUrl : "overview";
  
  const [activeTab, setActiveTabState] = useState(initialTab);
  
  const setActiveTab = (newTab: string) => {
    setActiveTabState(newTab);
    const newUrl = newTab === "overview" ? `/app/products/${id}` : `/app/products/${id}?tab=${newTab}`;
    window.history.replaceState(null, "", newUrl);
  };
  const [gtmPrompts, setGtmPrompts] = useState({
    targetRoles: "",
    distributionChannels: "",
    customGuidance: "",
    budget: "",
    timeline: "",
  });
  const [messagingPrompts, setMessagingPrompts] = useState({
    targetAudience: "",
    toneOfVoice: "",
    keyMessages: "",
    customGuidance: "",
  });
  const [oneSheetPrompts, setOneSheetPrompts] = useState({
    targetAudience: "",
    keyBenefits: "",
    toneOfVoice: "",
    customGuidance: "",
  });
  const [isExporting, setIsExporting] = useState(false);
  const [isGeneratingFullReport, setIsGeneratingFullReport] = useState(false);
  const [generationResults, setGenerationResults] = useState<{ section: string; status: string; error?: string }[] | null>(null);
  const [downloadingBattlecard, setDownloadingBattlecard] = useState<"pdf" | "txt" | null>(null);

  const formatProductBattlecardForClipboard = (card: ProductBattlecard, baselineProduct: Product | undefined, competitorProduct: Product | undefined): string => {
    let text = `🎯 ${competitorProduct?.name || "Competitor"} Battle Card\nvs ${baselineProduct?.name || "Your Product"}\n\n`;
    
    if (card.strengths?.length) {
      text += `✅ THEIR STRENGTHS\n${card.strengths.map(s => `• ${s}`).join('\n')}\n\n`;
    }
    if (card.weaknesses?.length) {
      text += `❌ THEIR WEAKNESSES\n${card.weaknesses.map(w => `• ${w}`).join('\n')}\n\n`;
    }
    if (card.ourAdvantages?.length) {
      text += `⭐ OUR ADVANTAGES\n${card.ourAdvantages.map(a => `• ${a}`).join('\n')}\n\n`;
    }
    if (card.keyDifferentiators?.length) {
      text += `📊 KEY DIFFERENTIATORS\n`;
      card.keyDifferentiators.forEach(d => {
        text += `• ${d.feature}: Us (${d.ours}) vs Them (${d.theirs})\n`;
      });
      text += '\n';
    }
    if (card.objections?.length) {
      text += `💬 OBJECTION HANDLING\n`;
      card.objections.forEach(o => {
        text += `Q: "${o.objection}"\nA: ${o.response}\n\n`;
      });
    }
    if (card.talkTracks?.length) {
      text += `🎤 TALK TRACKS\n`;
      card.talkTracks.forEach(t => {
        text += `Scenario: ${t.scenario}\nScript: "${t.script}"\n\n`;
      });
    }
    return text;
  };

  const handleCopyBattlecard = async (card: ProductBattlecard) => {
    const baselineProduct = projectProducts.find(pp => pp.role === "baseline")?.product;
    const competitorProduct = projectProducts.find(pp => pp.productId === card.competitorProductId)?.product;
    try {
      const text = formatProductBattlecardForClipboard(card, baselineProduct, competitorProduct);
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied!", description: "Battle card copied to clipboard" });
    } catch (error) {
      toast({ title: "Error", description: "Failed to copy to clipboard", variant: "destructive" });
    }
  };

  const handleDownloadBattlecardPdf = async (card: ProductBattlecard) => {
    setDownloadingBattlecard("pdf");
    try {
      const response = await fetch(`/api/product-battlecards/${card.id}/pdf`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to download PDF");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const competitorProduct = projectProducts.find(pp => pp.productId === card.competitorProductId)?.product;
      a.href = url;
      a.download = `Battlecard_${competitorProduct?.name || "Product"}_${new Date().toISOString().split('T')[0]}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: "Downloaded!", description: "PDF saved successfully" });
    } catch (error) {
      toast({ title: "Error", description: "Failed to download PDF", variant: "destructive" });
    } finally {
      setDownloadingBattlecard(null);
    }
  };

  const handleDownloadBattlecardText = async (card: ProductBattlecard) => {
    setDownloadingBattlecard("txt");
    try {
      const response = await fetch(`/api/product-battlecards/${card.id}/txt`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to download text file");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const competitorProduct = projectProducts.find(pp => pp.productId === card.competitorProductId)?.product;
      a.href = url;
      a.download = `Battlecard_${competitorProduct?.name || "Product"}_${new Date().toISOString().split('T')[0]}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: "Downloaded!", description: "Text file saved successfully" });
    } catch (error) {
      toast({ title: "Error", description: "Failed to download text file", variant: "destructive" });
    } finally {
      setDownloadingBattlecard(null);
    }
  };

  const generateFullReport = async () => {
    if (!project) return;
    setIsGeneratingFullReport(true);
    setGenerationResults(null);
    try {
      const response = await fetch(`/api/projects/${id}/generate-full-report`, { 
        method: "POST",
        credentials: "include" 
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to generate report");
      }
      const data = await response.json();
      setGenerationResults(data.results);
      
      // Invalidate all project-related queries to refresh the data
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "recommendations", "gap_analysis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "recommendations", "strategic_recommendations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "recommendations", "competitive_summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "recommendations", "gtm_plan"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "recommendations", "messaging_framework"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "battlecards"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "messaging-comparison"] });
      queryClient.invalidateQueries({ queryKey: ["executive-summary", id] });
      
      toast({
        title: data.allSuccess ? "Report Generated" : "Report Partially Generated",
        description: data.message,
        variant: data.allSuccess ? "default" : "destructive",
      });

      // Auto-download the export if all succeeded
      if (data.allSuccess) {
        setTimeout(() => exportProject(), 1000);
      }
    } catch (error: any) {
      toast({
        title: "Generation Failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsGeneratingFullReport(false);
    }
  };

  const exportProject = async () => {
    if (!project) return;
    setIsExporting(true);
    try {
      const response = await fetch(`/api/projects/${id}/export`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to export project");
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project.name.replace(/[^a-z0-9]/gi, "_")}_report.md`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast({
        title: "Export Complete",
        description: "Product report has been downloaded.",
      });
    } catch (error: any) {
      toast({
        title: "Export Failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const [isMonitoringAll, setIsMonitoringAll] = useState(false);

  const monitorAllProducts = async () => {
    if (!project) return;
    setIsMonitoringAll(true);
    try {
      const response = await fetch(`/api/projects/${project.id}/monitor-all`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to monitor websites");
      }
      const data = await response.json();
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
      toast({
        title: "Change Check Complete",
        description: data.message || `Checked ${data.successCount} of ${data.successCount + data.failCount} products for changes.`,
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsMonitoringAll(false);
    }
  };

  // Fetch GTM Plan recommendation
  const { data: gtmPlan, isLoading: gtmLoading } = useQuery<LongFormRecommendation>({
    queryKey: ["/api/projects", id, "recommendations", "gtm_plan"],
    queryFn: async () => {
      const response = await fetch(`/api/projects/${id}/recommendations/gtm_plan`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch GTM plan");
      return response.json();
    },
    enabled: !!id,
  });

  // Fetch Messaging Framework recommendation
  const { data: messagingFramework, isLoading: messagingLoading } = useQuery<LongFormRecommendation>({
    queryKey: ["/api/projects", id, "recommendations", "messaging_framework"],
    queryFn: async () => {
      const response = await fetch(`/api/projects/${id}/recommendations/messaging_framework`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch messaging framework");
      return response.json();
    },
    enabled: !!id,
  });

  // Fetch Product One Sheet
  const { data: productOneSheet, isLoading: oneSheetLoading } = useQuery<LongFormRecommendation>({
    queryKey: ["/api/projects", id, "recommendations", "product_one_sheet"],
    queryFn: async () => {
      const response = await fetch(`/api/projects/${id}/recommendations/product_one_sheet`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch product one sheet");
      return response.json();
    },
    enabled: !!id,
  });

  // Fetch Gap Analysis
  const { data: gapAnalysis, isLoading: gapLoading } = useQuery<LongFormRecommendation>({
    queryKey: ["/api/projects", id, "recommendations", "gap_analysis"],
    queryFn: async () => {
      const response = await fetch(`/api/projects/${id}/recommendations/gap_analysis`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch gap analysis");
      return response.json();
    },
    enabled: !!id,
  });

  // Fetch Strategic Recommendations
  const { data: strategicRecs, isLoading: recsLoading } = useQuery<LongFormRecommendation>({
    queryKey: ["/api/projects", id, "recommendations", "strategic_recommendations"],
    queryFn: async () => {
      const response = await fetch(`/api/projects/${id}/recommendations/strategic_recommendations`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch recommendations");
      return response.json();
    },
    enabled: !!id,
  });

  // Fetch Competitive Summary
  const { data: competitiveSummary, isLoading: summaryLoading } = useQuery<LongFormRecommendation>({
    queryKey: ["/api/projects", id, "recommendations", "competitive_summary"],
    queryFn: async () => {
      const response = await fetch(`/api/projects/${id}/recommendations/competitive_summary`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch competitive summary");
      return response.json();
    },
    enabled: !!id,
  });

  // Fetch Messaging Comparison data
  interface MessagingData {
    summary: string | null;
    valueProposition: string | null;
    targetAudience: string | null;
    keyMessages: string[];
    differentiators: string[];
    toneAndStyle: string | null;
  }
  interface MessagingComparison {
    baseline: {
      id: string;
      name: string;
      companyName: string;
      messaging: MessagingData;
    } | null;
    competitors: Array<{
      id: string;
      name: string;
      companyName: string;
      messaging: MessagingData;
      hasAnalysis: boolean;
    }>;
    totalCompetitors: number;
    analyzedCompetitors: number;
  }
  const { data: messagingComparison, isLoading: comparisonLoading } = useQuery<MessagingComparison>({
    queryKey: ["/api/projects", id, "messaging-comparison"],
    queryFn: async () => {
      const response = await fetch(`/api/projects/${id}/messaging-comparison`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch messaging comparison");
      return response.json();
    },
    enabled: !!id,
  });

  // Initialize prompts from saved data when loaded
  React.useEffect(() => {
    if (gtmPlan?.savedPrompts) {
      setGtmPrompts({
        targetRoles: gtmPlan.savedPrompts.targetRoles || "",
        distributionChannels: gtmPlan.savedPrompts.distributionChannels || "",
        customGuidance: gtmPlan.savedPrompts.customGuidance || "",
        budget: gtmPlan.savedPrompts.budget || "",
        timeline: gtmPlan.savedPrompts.timeline || "",
      });
    }
  }, [gtmPlan]);

  React.useEffect(() => {
    if (messagingFramework?.savedPrompts) {
      setMessagingPrompts({
        targetAudience: messagingFramework.savedPrompts.targetAudience || "",
        toneOfVoice: messagingFramework.savedPrompts.toneOfVoice || "",
        keyMessages: messagingFramework.savedPrompts.keyMessages || "",
        customGuidance: messagingFramework.savedPrompts.customGuidance || "",
      });
    }
  }, [messagingFramework]);

  React.useEffect(() => {
    if (productOneSheet?.savedPrompts) {
      setOneSheetPrompts({
        targetAudience: (productOneSheet.savedPrompts as any).targetAudience || "",
        keyBenefits: (productOneSheet.savedPrompts as any).keyBenefits || "",
        toneOfVoice: (productOneSheet.savedPrompts as any).toneOfVoice || "",
        customGuidance: (productOneSheet.savedPrompts as any).customGuidance || "",
      });
    }
  }, [productOneSheet]);

  const generateGtmPlan = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/projects/${id}/recommendations/gtm_plan/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(gtmPrompts),
        credentials: "include",
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to generate GTM plan");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "recommendations", "gtm_plan"] });
      toast({
        title: "GTM Plan Generated",
        description: "Your Go-To-Market plan has been created.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Generation Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const generateMessagingFramework = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/projects/${id}/recommendations/messaging_framework/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(messagingPrompts),
        credentials: "include",
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to generate messaging framework");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "recommendations", "messaging_framework"] });
      toast({
        title: "Messaging Framework Generated",
        description: "Your messaging and positioning framework has been created.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Generation Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const generateProductOneSheet = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/projects/${id}/recommendations/product_one_sheet/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(oneSheetPrompts),
        credentials: "include",
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to generate product one sheet");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "recommendations", "product_one_sheet"] });
      toast({
        title: "Product One Sheet Generated",
        description: "Your marketing copy draft has been created.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Generation Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const generateGapAnalysis = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/projects/${id}/recommendations/gap_analysis/generate`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to generate gap analysis");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "recommendations", "gap_analysis"] });
      toast({
        title: "Gap Analysis Generated",
        description: "Competitive positioning gaps have been identified.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Generation Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const generateStrategicRecs = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/projects/${id}/recommendations/strategic_recommendations/generate`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to generate recommendations");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "recommendations", "strategic_recommendations"] });
      toast({
        title: "Recommendations Generated",
        description: "Strategic recommendations have been created.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Generation Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const generateCompetitiveSummary = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/projects/${id}/recommendations/competitive_summary/generate`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to generate competitive summary");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "recommendations", "competitive_summary"] });
      toast({
        title: "Competitive Summary Generated",
        description: "Consolidated competitive insights report has been created.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Generation Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const generateBattlecard = useMutation({
    mutationFn: async (competitorProductId: string) => {
      setGeneratingBattlecardFor(competitorProductId);
      const response = await fetch(`/api/projects/${id}/battlecards/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ competitorProductId }),
        credentials: "include",
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to generate battlecard");
      }
      return response.json();
    },
    onSuccess: () => {
      setGeneratingBattlecardFor(null);
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "battlecards"] });
      toast({
        title: "Battlecard Generated",
        description: "AI-powered product battlecard has been created.",
      });
    },
    onError: (error: Error) => {
      setGeneratingBattlecardFor(null);
      toast({
        title: "Generation Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const createProduct = useMutation({
    mutationFn: async (data: typeof productFormData) => {
      const response = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to create product");
      }
      return response.json();
    },
    onSuccess: async (product) => {
      await addProductToProject.mutateAsync({
        productId: product.id,
        role: product.isBaseline ? "baseline" : "competitor",
        source: "manual",
      });
      setIsAddProductOpen(false);
      setProductFormData({ name: "", description: "", url: "", companyName: "", isBaseline: false, createAsCompetitor: false });
      toast({
        title: "Product Added",
        description: "Product has been created and added to the project.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const addProductToProject = useMutation({
    mutationFn: async (data: { productId: string; role: string; source: string }) => {
      const response = await fetch(`/api/projects/${id}/products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to add product");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "products"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const removeProductFromProject = useMutation({
    mutationFn: async (productId: string) => {
      const response = await fetch(`/api/projects/${id}/products/${productId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to remove product");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "products"] });
      toast({
        title: "Product Removed",
        description: "Product has been removed from the project.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const setAsBaseline = useMutation({
    mutationFn: async (productId: string) => {
      // Server-side enforcement handles clearing existing baselines
      const response = await fetch(`/api/projects/${id}/products/${productId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "baseline" }),
        credentials: "include",
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to set baseline");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "products"] });
      toast({
        title: "Baseline Set",
        description: "Product has been set as the baseline.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateProduct = useMutation({
    mutationFn: async ({ productId, data }: { productId: string; data: typeof editFormData }) => {
      const response = await fetch(`/api/products/${productId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to update product");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      setIsEditProductOpen(false);
      setEditingProduct(null);
      toast({
        title: "Product Updated",
        description: "Product details have been saved.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });


  const openEditDialog = (product: Product) => {
    setEditingProduct(product);
    setEditFormData({
      name: product.name,
      description: product.description || "",
      url: product.url || "",
      companyName: product.companyName || "",
      linkedInUrl: product.linkedInUrl || "",
      instagramUrl: product.instagramUrl || "",
      twitterUrl: product.twitterUrl || "",
      blogUrl: product.blogUrl || "",
      socialCheckFrequency: product.socialCheckFrequency || "daily",
      isBaseline: product.isBaseline ?? false,
    });
    setIsEditProductOpen(true);
  };

  const autoFetchDescriptionForAdd = async () => {
    if (!productFormData.url) {
      toast({
        title: "URL Required",
        description: "Please enter a product URL first.",
        variant: "destructive",
      });
      return;
    }

    setIsAddAutoFetching(true);
    try {
      const response = await fetch("/api/products/auto-describe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: productFormData.url, name: productFormData.name }),
        credentials: "include",
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to fetch description");
      }
      const data = await response.json();
      setProductFormData(prev => ({ ...prev, description: data.description }));
      toast({
        title: "Description Generated",
        description: "AI has generated a description based on the product website.",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsAddAutoFetching(false);
    }
  };

  const autoFetchDescription = async () => {
    if (!editFormData.url) {
      toast({
        title: "URL Required",
        description: "Please enter a product URL first.",
        variant: "destructive",
      });
      return;
    }

    setIsAutoFetching(true);
    try {
      const response = await fetch("/api/products/auto-describe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: editFormData.url, name: editFormData.name }),
        credentials: "include",
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to fetch description");
      }
      const data = await response.json();
      setEditFormData(prev => ({ ...prev, description: data.description }));
      toast({
        title: "Description Generated",
        description: "AI has generated a description based on the product website.",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsAutoFetching(false);
    }
  };

  const getSuggestions = async () => {
    const baselineProduct = projectProducts.find(pp => pp.role === "baseline");
    if (!baselineProduct) {
      toast({
        title: "No Baseline",
        description: "Please set a baseline product first to get competitor suggestions.",
        variant: "destructive",
      });
      return;
    }

    setIsLoadingSuggestions(true);
    try {
      const response = await fetch(`/api/products/${baselineProduct.productId}/suggest-competitors`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to get suggestions");
      const data = await response.json();
      setSuggestions(data);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoadingSuggestions(false);
    }
  };

  const addSuggestedProduct = async (suggestion: SuggestedProduct) => {
    try {
      const response = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: suggestion.name,
          description: suggestion.description,
          url: suggestion.url,
          companyName: suggestion.companyName,
        }),
        credentials: "include",
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to create product");
      }
      const product = await response.json();
      
      await addProductToProject.mutateAsync({
        productId: product.id,
        role: "competitor",
        source: "suggested",
      });
      
      setSuggestions(suggestions.filter(s => s.name !== suggestion.name));
      toast({
        title: "Competitor Added",
        description: `${suggestion.name} has been added as a competitor.`,
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createProduct.mutate(productFormData);
  };

  const baselineProduct = projectProducts.find(pp => pp.role === "baseline");
  const competitorProducts = projectProducts.filter(pp => pp.role === "competitor");

  const productBreadcrumbs = [
    { label: "Products", href: "/app/products" },
    { label: project?.name || "Loading..." },
  ];

  if (projectLoading) {
    return (
      <AppLayout breadcrumbs={productBreadcrumbs}>
        <div className="flex-1 p-4 md:p-8 overflow-y-auto" data-testid="skeleton-product-detail">
          <div className="max-w-6xl mx-auto space-y-6">
            <div className="flex items-center gap-4">
              <Skeleton className="h-9 w-9 rounded-md" />
              <div className="space-y-2">
                <Skeleton className="h-7 w-64" />
                <div className="flex items-center gap-2">
                  <Skeleton className="h-5 w-32 rounded-full" />
                  <Skeleton className="h-4 w-40" />
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-28 rounded-md" />
              ))}
            </div>
            <ProductCardGridSkeleton count={6} />
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!project) {
    return (
      <AppLayout breadcrumbs={[{ label: "Products", href: "/app/products" }, { label: "Not Found" }]}>
        <div className="flex-1 p-4 md:p-8">
          <div className="max-w-6xl mx-auto">
            <Card>
              <CardContent className="py-16 text-center">
                <p>Product not found</p>
                <Link href="/app/products">
                  <Button variant="outline" className="mt-4">Back to Products</Button>
                </Link>
              </CardContent>
            </Card>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout breadcrumbs={productBreadcrumbs}>
      <div className="flex-1 p-4 md:p-8 overflow-y-auto">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-4">
              <Link href="/app/products">
                <Button variant="ghost" size="icon" data-testid="button-back">
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              </Link>
              <div>
                <h1 className="text-2xl font-bold" data-testid="text-product-name">{project.name}</h1>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="outline" className="text-xs">
                    {project.analysisType === "product" ? (
                      <><Package className="h-3 w-3 mr-1" /> Product Analysis</>
                    ) : (
                      <><Building className="h-3 w-3 mr-1" /> Company Analysis</>
                    )}
                  </Badge>
                  <span className="text-muted-foreground text-sm">{project.clientName}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button 
                variant="default" 
                className="gap-2" 
                onClick={generateFullReport}
                disabled={isGeneratingFullReport || !projectProducts.some(pp => pp.role === "baseline")}
                data-testid="button-generate-full-report"
              >
                {isGeneratingFullReport ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Generating...</>
                ) : (
                  <><Sparkles className="h-4 w-4" /> Generate Full Report</>
                )}
              </Button>
              <Button 
                variant="outline" 
                className="gap-2" 
                onClick={exportProject}
                disabled={isExporting}
                data-testid="button-export-project"
              >
                {isExporting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                Export
              </Button>
              <Button 
                variant="outline" 
                className="gap-2" 
                onClick={monitorAllProducts}
                disabled={isMonitoringAll}
                data-testid="button-check-all-changes"
              >
                {isMonitoringAll ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Check All for Changes
              </Button>
              <Link href={`/app/products/${project.id}/executive-summary`}>
                <Button variant="outline" className="gap-2" data-testid="button-executive-summary">
                  <FileText className="h-4 w-4" />
                  Executive Summary
                </Button>
              </Link>
            </div>
          </div>

          {/* Generation Progress Indicator */}
          {isGeneratingFullReport && (
            <Card className="mb-6 border-primary/50 bg-primary/5">
              <CardContent className="py-4">
                <div className="flex items-center gap-4">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  <div>
                    <p className="font-medium">Generating Full Report...</p>
                    <p className="text-sm text-muted-foreground">
                      Creating Gap Analysis, Recommendations, Summary, GTM Plan, Messaging Framework, and calculating scores. This may take a minute.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Generation Results */}
          {generationResults && !isGeneratingFullReport && (
            <Card className="mb-6">
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <Check className="h-6 w-6 text-green-500" />
                    <div>
                      <p className="font-medium">Report Generation Complete</p>
                      <p className="text-sm text-muted-foreground">
                        {generationResults.filter(r => r.status === "success").length} of {generationResults.length} sections generated successfully
                      </p>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setGenerationResults(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                {generationResults.some(r => r.status === "error") && (
                  <div className="mt-3 text-sm text-destructive">
                    Failed sections: {generationResults.filter(r => r.status === "error").map(r => r.section).join(", ")}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Main Tabs for Project Sections */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="mb-6">
            <TabsList className="flex flex-wrap gap-1">
              <TabsTrigger value="overview" className="flex items-center gap-1">
                <Package className="h-4 w-4" />
                Overview
              </TabsTrigger>
              <TabsTrigger value="gaps" className="flex items-center gap-1">
                <Sparkles className="h-4 w-4" />
                Gaps
                {gapAnalysis?.status === "generated" && (
                  <Badge variant="secondary" className="ml-1 h-5 w-5 p-0 flex items-center justify-center">
                    <Check className="h-3 w-3" />
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="recommendations" className="flex items-center gap-1">
                <Star className="h-4 w-4" />
                Recommendations
                {strategicRecs?.status === "generated" && (
                  <Badge variant="secondary" className="ml-1 h-5 w-5 p-0 flex items-center justify-center">
                    <Check className="h-3 w-3" />
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="summary" className="flex items-center gap-1">
                <FileText className="h-4 w-4" />
                Summary
                {competitiveSummary?.status === "generated" && (
                  <Badge variant="secondary" className="ml-1 h-5 w-5 p-0 flex items-center justify-center">
                    <Check className="h-3 w-3" />
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="gtm_plan" className="flex items-center gap-1">
                <Rocket className="h-4 w-4" />
                GTM Plan
                {gtmPlan?.status === "generated" && (
                  <Badge variant="secondary" className="ml-1 h-5 w-5 p-0 flex items-center justify-center">
                    <Check className="h-3 w-3" />
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="messaging" className="flex items-center gap-1">
                <MessageCircle className="h-4 w-4" />
                Messaging
                {messagingFramework?.status === "generated" && (
                  <Badge variant="secondary" className="ml-1 h-5 w-5 p-0 flex items-center justify-center">
                    <Check className="h-3 w-3" />
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="one_sheet" className="flex items-center gap-1">
                <FileBarChart className="h-4 w-4" />
                One Sheet
                {productOneSheet?.status === "generated" && (
                  <Badge variant="secondary" className="ml-1 h-5 w-5 p-0 flex items-center justify-center">
                    <Check className="h-3 w-3" />
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="features" className="flex items-center gap-1">
                <List className="h-4 w-4" />
                Features
              </TabsTrigger>
              <TabsTrigger value="roadmap" className="flex items-center gap-1">
                <Map className="h-4 w-4" />
                Roadmap
              </TabsTrigger>
              <TabsTrigger value="feedback" className="flex items-center gap-1" data-testid="tab-feedback">
                <MessageSquare className="h-4 w-4" />
                Customer Feedback
              </TabsTrigger>
            </TabsList>

            {/* Overview Tab Content */}
            <TabsContent value="overview" className="mt-6">

          {project.analysisType === "product" && (
            <>
              <div className="grid gap-6 lg:grid-cols-2 mb-6">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Star className="h-5 w-5 text-yellow-500" />
                      Baseline Product
                    </CardTitle>
                    <CardDescription>
                      Your product or client's product to analyze against competitors
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {baselineProduct ? (
                      <div className="flex items-start justify-between p-4 rounded-lg border bg-card">
                        <div>
                          <h3 className="font-semibold" data-testid="text-baseline-name">{baselineProduct.product.name}</h3>
                          {baselineProduct.product.companyName && (
                            <p className="text-sm text-muted-foreground">{baselineProduct.product.companyName}</p>
                          )}
                          {baselineProduct.product.description && (
                            <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{baselineProduct.product.description}</p>
                          )}
                          {!baselineProduct.product.description && (
                            <p className="text-sm text-muted-foreground/60 italic mt-1">No description - click edit to add one</p>
                          )}
                          {(baselineProduct.product as any).competitivePositionSummary && (
                            <div className="mt-2 p-2 rounded bg-primary/5 border border-primary/10">
                              <p className="text-xs text-muted-foreground italic" data-testid="text-baseline-position-summary">{(baselineProduct.product as any).competitivePositionSummary}</p>
                            </div>
                          )}
                          {baselineProduct.product.url && (
                            <a 
                              href={baselineProduct.product.url} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="text-sm text-primary hover:underline flex items-center gap-1 mt-2"
                            >
                              Visit Product Page <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                        <div className="flex gap-1">
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            onClick={async () => {
                              try {
                                const res = await fetch(`/api/products/${baselineProduct.productId}/generate-summary`, { method: "POST", credentials: "include" });
                                if (!res.ok) throw new Error("Failed");
                                queryClient.invalidateQueries({ queryKey: [`/api/projects/${id}/products`] });
                                toast({ title: "Summary Generated", description: "Competitive position summary has been updated." });
                              } catch { toast({ title: "Error", description: "Failed to generate summary", variant: "destructive" }); }
                            }}
                            data-testid="button-generate-baseline-summary"
                            title="Generate competitive position summary"
                          >
                            <Sparkles className="h-4 w-4" />
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            onClick={() => openEditDialog(baselineProduct.product)}
                            data-testid="button-edit-baseline"
                            title="Edit product"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            onClick={() => removeProductFromProject.mutate(baselineProduct.productId)}
                            data-testid="button-remove-baseline"
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-center py-8 border-2 border-dashed rounded-lg">
                        <Package className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                        <p className="text-muted-foreground mb-4">No baseline product set</p>
                        <Dialog open={isAddProductOpen} onOpenChange={(open) => {
                          setIsAddProductOpen(open);
                          if (open) {
                            setProductFormData({ name: "", description: "", url: "", companyName: "", isBaseline: true, createAsCompetitor: false });
                          }
                        }}>
                          <DialogTrigger asChild>
                            <Button data-testid="button-add-baseline">
                              <Plus className="mr-2 h-4 w-4" />
                              Add Baseline Product
                            </Button>
                          </DialogTrigger>
                          <DialogContent>
                            <form onSubmit={handleSubmit}>
                              <DialogHeader>
                                <DialogTitle>Add Product</DialogTitle>
                                <DialogDescription>
                                  Add your product or client's product as the baseline for comparison.
                                </DialogDescription>
                              </DialogHeader>
                              <div className="grid gap-4 py-4">
                                <div className="grid gap-2">
                                  <Label htmlFor="name">Product Name</Label>
                                  <Input
                                    id="name"
                                    data-testid="input-product-name"
                                    placeholder="e.g., Slack"
                                    value={productFormData.name}
                                    onChange={(e) => setProductFormData({ ...productFormData, name: e.target.value })}
                                    required
                                  />
                                </div>
                                <div className="grid gap-2">
                                  <Label htmlFor="companyName">Company Name</Label>
                                  <Input
                                    id="companyName"
                                    data-testid="input-company-name"
                                    placeholder="e.g., Salesforce"
                                    value={productFormData.companyName}
                                    onChange={(e) => setProductFormData({ ...productFormData, companyName: e.target.value })}
                                  />
                                </div>
                                <div className="grid gap-2">
                                  <Label htmlFor="url">Product URL (optional)</Label>
                                  <Input
                                    id="url"
                                    data-testid="input-product-url"
                                    placeholder="https://..."
                                    value={productFormData.url}
                                    onChange={(e) => setProductFormData({ ...productFormData, url: e.target.value })}
                                  />
                                </div>
                                <div className="grid gap-2">
                                  <div className="flex items-center justify-between">
                                    <Label htmlFor="description">Description</Label>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={autoFetchDescriptionForAdd}
                                      disabled={isAddAutoFetching || !productFormData.url}
                                      data-testid="button-auto-fetch-add"
                                    >
                                      {isAddAutoFetching ? (
                                        <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                                      ) : (
                                        <Wand2 className="mr-2 h-3 w-3" />
                                      )}
                                      Auto-fetch from URL
                                    </Button>
                                  </div>
                                  <Textarea
                                    id="description"
                                    data-testid="input-product-description"
                                    placeholder="Brief description of the product..."
                                    value={productFormData.description}
                                    onChange={(e) => setProductFormData({ ...productFormData, description: e.target.value })}
                                    rows={3}
                                  />
                                </div>
                                <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                                  <Switch
                                    id="isBaseline"
                                    checked={productFormData.isBaseline}
                                    onCheckedChange={(checked) => setProductFormData({ ...productFormData, isBaseline: checked })}
                                    data-testid="switch-is-baseline"
                                  />
                                  <div className="flex flex-col">
                                    <Label htmlFor="isBaseline" className="font-medium">
                                      {productFormData.isBaseline ? "This is our product" : "This is a competitor product"}
                                    </Label>
                                    <span className="text-xs text-muted-foreground">
                                      {productFormData.isBaseline 
                                        ? "Mark as baseline for this market" 
                                        : "Competitor product for analysis"}
                                    </span>
                                  </div>
                                </div>
                              </div>
                              <DialogFooter>
                                <Button type="submit" data-testid="button-create-product" disabled={createProduct.isPending || isAddAutoFetching}>
                                  {createProduct.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                  Add Product
                                </Button>
                              </DialogFooter>
                            </form>
                          </DialogContent>
                        </Dialog>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="flex items-center gap-2">
                          <Sparkles className="h-5 w-5 text-primary" />
                          AI Competitor Suggestions
                        </CardTitle>
                        <CardDescription>
                          Get AI-powered suggestions for competitor products
                        </CardDescription>
                      </div>
                      <Button 
                        onClick={getSuggestions} 
                        disabled={!baselineProduct || isLoadingSuggestions}
                        data-testid="button-get-suggestions"
                      >
                        {isLoadingSuggestions && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        <Sparkles className="mr-2 h-4 w-4" />
                        Get Suggestions
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {suggestions.length > 0 ? (
                      <div className="space-y-3">
                        {suggestions.map((suggestion, index) => (
                          <div key={index} className="flex items-start justify-between p-3 rounded-lg border bg-muted/50">
                            <div className="flex-1">
                              <h4 className="font-medium">{suggestion.name}</h4>
                              <p className="text-sm text-muted-foreground">{suggestion.companyName}</p>
                              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{suggestion.rationale}</p>
                            </div>
                            <Button 
                              size="sm" 
                              onClick={() => addSuggestedProduct(suggestion)}
                              data-testid={`button-add-suggestion-${index}`}
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-center py-8 border-2 border-dashed rounded-lg">
                        <Sparkles className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                        <p className="text-muted-foreground">
                          {baselineProduct 
                            ? "Click 'Get Suggestions' to find competitor products"
                            : "Set a baseline product first to get suggestions"}
                        </p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>Competitor Products</CardTitle>
                      <CardDescription>
                        Products to compare against the baseline
                      </CardDescription>
                    </div>
                    <Dialog onOpenChange={(open) => {
                      if (open) {
                        setProductFormData({ name: "", description: "", url: "", companyName: "", isBaseline: false, createAsCompetitor: false });
                      }
                    }}>
                      <DialogTrigger asChild>
                        <Button data-testid="button-add-competitor">
                          <Plus className="mr-2 h-4 w-4" />
                          Add Competitor
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <form onSubmit={(e) => {
                          e.preventDefault();
                          createProduct.mutate(productFormData);
                        }}>
                          <DialogHeader>
                            <DialogTitle>Add Competitor Product</DialogTitle>
                            <DialogDescription>
                              Add a competitor product to analyze against your baseline.
                            </DialogDescription>
                          </DialogHeader>
                          <div className="grid gap-4 py-4">
                            <div className="grid gap-2">
                              <Label htmlFor="comp-name">Product Name</Label>
                              <Input
                                id="comp-name"
                                data-testid="input-competitor-product-name"
                                placeholder="e.g., Microsoft Teams"
                                value={productFormData.name}
                                onChange={(e) => setProductFormData({ ...productFormData, name: e.target.value })}
                                required
                              />
                            </div>
                            <div className="grid gap-2">
                              <Label htmlFor="comp-companyName">Company Name</Label>
                              <Input
                                id="comp-companyName"
                                data-testid="input-competitor-company-name"
                                placeholder="e.g., Microsoft"
                                value={productFormData.companyName}
                                onChange={(e) => setProductFormData({ ...productFormData, companyName: e.target.value })}
                              />
                            </div>
                            <div className="grid gap-2">
                              <Label htmlFor="comp-url">Product URL (optional)</Label>
                              <Input
                                id="comp-url"
                                data-testid="input-competitor-product-url"
                                placeholder="https://..."
                                value={productFormData.url}
                                onChange={(e) => setProductFormData({ ...productFormData, url: e.target.value })}
                              />
                            </div>
                            <div className="grid gap-2">
                              <div className="flex items-center justify-between">
                                <Label htmlFor="comp-description">Description</Label>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={autoFetchDescriptionForAdd}
                                  disabled={isAddAutoFetching || !productFormData.url}
                                  data-testid="button-auto-fetch-competitor"
                                >
                                  {isAddAutoFetching ? (
                                    <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                                  ) : (
                                    <Wand2 className="mr-2 h-3 w-3" />
                                  )}
                                  Auto-fetch from URL
                                </Button>
                              </div>
                              <Textarea
                                id="comp-description"
                                data-testid="input-competitor-product-description"
                                placeholder="Brief description of the product..."
                                value={productFormData.description}
                                onChange={(e) => setProductFormData({ ...productFormData, description: e.target.value })}
                                rows={3}
                              />
                            </div>
                            <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                              <Switch
                                id="comp-isBaseline"
                                checked={productFormData.isBaseline}
                                onCheckedChange={(checked) => setProductFormData({ ...productFormData, isBaseline: checked, createAsCompetitor: false })}
                                data-testid="switch-competitor-is-baseline"
                              />
                              <div className="flex flex-col">
                                <Label htmlFor="comp-isBaseline" className="font-medium">
                                  {productFormData.isBaseline ? "This is our product" : "This is a competitor product"}
                                </Label>
                                <span className="text-xs text-muted-foreground">
                                  {productFormData.isBaseline 
                                    ? "Mark as baseline for this market" 
                                    : "Competitor product for analysis"}
                                </span>
                              </div>
                            </div>
                            {!productFormData.isBaseline && (
                              <div className="flex items-center gap-3 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                                <Switch
                                  id="comp-createAsCompetitor"
                                  checked={productFormData.createAsCompetitor}
                                  onCheckedChange={(checked) => setProductFormData({ ...productFormData, createAsCompetitor: checked })}
                                  data-testid="switch-create-as-competitor"
                                />
                                <div className="flex flex-col">
                                  <Label htmlFor="comp-createAsCompetitor" className="font-medium">
                                    Also create as full competitor company
                                  </Label>
                                  <span className="text-xs text-muted-foreground">
                                    Track this company's website, social media, and blog activity
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>
                          <DialogFooter>
                            <Button type="submit" data-testid="button-create-competitor-product" disabled={createProduct.isPending || isAddAutoFetching}>
                              {createProduct.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                              Add Competitor
                            </Button>
                          </DialogFooter>
                        </form>
                      </DialogContent>
                    </Dialog>
                  </div>
                </CardHeader>
                <CardContent>
                  {productsLoading ? (
                    <ProductCardGridSkeleton count={6} />
                  ) : competitorProducts.length > 0 ? (
                    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                      {competitorProducts.map((pp) => (
                        <div key={pp.id} className="flex items-start justify-between p-4 rounded-lg border bg-card" data-testid={`card-competitor-${pp.productId}`}>
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <h3 className="font-medium">{pp.product.name}</h3>
                              {pp.source === "suggested" && (
                                <Badge variant="secondary" className="text-xs">
                                  <Sparkles className="h-3 w-3 mr-1" />
                                  AI
                                </Badge>
                              )}
                            </div>
                            {pp.product.companyName && (
                              <p className="text-sm text-muted-foreground">{pp.product.companyName}</p>
                            )}
                            {pp.product.url && (
                              <a 
                                href={pp.product.url} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="text-xs text-primary hover:underline flex items-center gap-1 mt-1"
                              >
                                View <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                            {pp.product.crawlFlaggedAt && !pp.product.excludeFromCrawl && (
                              <div className="mt-2 p-2 rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-700" data-testid={`badge-crawl-flagged-${pp.productId}`}>
                                <div className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                                  <AlertTriangle className="h-3 w-3" />
                                  <span>Crawl failures detected ({pp.product.consecutiveCrawlFailures} failures)</span>
                                </div>
                                {isAdmin && (
                                  <div className="flex gap-1 mt-1">
                                    <Button
                                      size="sm"
                                      variant="destructive"
                                      className="h-6 text-xs px-2"
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        try {
                                          const res = await fetch(`/api/admin/flagged-crawls/product/${pp.productId}/exclude`, { method: "POST", credentials: "include" });
                                          if (res.ok) {
                                            queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "products"] });
                                            toast({ title: "Excluded from Crawl", description: "This product will no longer be crawled." });
                                          } else {
                                            toast({ title: "Error", description: "Failed to exclude product from crawl.", variant: "destructive" });
                                          }
                                        } catch {
                                          toast({ title: "Error", description: "Network error. Please try again.", variant: "destructive" });
                                        }
                                      }}
                                      data-testid={`button-exclude-crawl-${pp.productId}`}
                                    >
                                      <Ban className="h-3 w-3 mr-1" /> Exclude
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-6 text-xs px-2"
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        try {
                                          const res = await fetch(`/api/admin/flagged-crawls/product/${pp.productId}/dismiss`, { method: "POST", credentials: "include" });
                                          if (res.ok) {
                                            queryClient.invalidateQueries({ queryKey: ["/api/projects", id, "products"] });
                                            toast({ title: "Flag Dismissed", description: "Crawl failure counter has been reset." });
                                          } else {
                                            toast({ title: "Error", description: "Failed to dismiss flag.", variant: "destructive" });
                                          }
                                        } catch {
                                          toast({ title: "Error", description: "Network error. Please try again.", variant: "destructive" });
                                        }
                                      }}
                                      data-testid={`button-dismiss-flag-${pp.productId}`}
                                    >
                                      Dismiss
                                    </Button>
                                  </div>
                                )}
                              </div>
                            )}
                            {pp.product.excludeFromCrawl && (
                              <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground" data-testid={`badge-excluded-crawl-${pp.productId}`}>
                                <Ban className="h-3 w-3" />
                                <span>Excluded from crawl</span>
                              </div>
                            )}
                            {(pp.product as any).competitivePositionSummary && (
                              <p className="text-xs text-muted-foreground italic mt-1 line-clamp-2" data-testid={`text-position-summary-${pp.productId}`}>{(pp.product as any).competitivePositionSummary}</p>
                            )}
                          </div>
                          <div className="flex gap-1">
                            <Button 
                              variant="ghost" 
                              size="icon"
                              onClick={() => openEditDialog(pp.product)}
                              title="Edit product"
                              data-testid={`button-edit-${pp.productId}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button 
                              variant="ghost" 
                              size="icon"
                              onClick={() => setAsBaseline.mutate(pp.productId)}
                              title="Set as baseline"
                              data-testid={`button-set-baseline-${pp.productId}`}
                            >
                              <Star className="h-4 w-4" />
                            </Button>
                            <Button 
                              variant="ghost" 
                              size="icon"
                              onClick={() => removeProductFromProject.mutate(pp.productId)}
                              data-testid={`button-remove-${pp.productId}`}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-12 border-2 border-dashed rounded-lg">
                      <Package className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                      <h3 className="text-lg font-medium mb-2">No Competitor Products</h3>
                      <p className="text-muted-foreground mb-4">
                        Add competitor products manually or use AI suggestions
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Product Battlecards Section */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <Swords className="h-5 w-5 text-primary" />
                        Product Battlecards
                      </CardTitle>
                      <CardDescription>
                        AI-generated competitive intelligence for each competitor product
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {battlecardsLoading ? (
                    <BattlecardListSkeleton count={3} />
                  ) : !baselineProduct ? (
                    <div className="text-center py-8 border-2 border-dashed rounded-lg">
                      <Swords className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                      <p className="text-muted-foreground">Set a baseline product first to generate battlecards</p>
                    </div>
                  ) : competitorProducts.length === 0 ? (
                    <div className="text-center py-8 border-2 border-dashed rounded-lg">
                      <Swords className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                      <p className="text-muted-foreground">Add competitor products to generate battlecards</p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {competitorProducts.map((pp) => {
                        const existingBattlecard = battlecards.find(
                          bc => bc.competitorProductId === pp.productId
                        );
                        const isGenerating = generatingBattlecardFor === pp.productId;
                        
                        return (
                          <div key={pp.id} className="border rounded-lg overflow-hidden">
                            <div className="flex items-center justify-between p-4 bg-muted/30">
                              <div>
                                <h4 className="font-medium">{pp.product.name}</h4>
                                {pp.product.companyName && (
                                  <p className="text-sm text-muted-foreground">{pp.product.companyName}</p>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                {existingBattlecard ? (
                                  <>
                                    <Badge variant="secondary">
                                      <Check className="h-3 w-3 mr-1" />
                                      Generated
                                    </Badge>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setSelectedBattlecard(
                                        selectedBattlecard?.id === existingBattlecard.id ? null : existingBattlecard
                                      )}
                                      data-testid={`button-view-battlecard-${pp.productId}`}
                                    >
                                      {selectedBattlecard?.id === existingBattlecard.id ? "Hide" : "View"}
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => generateBattlecard.mutate(pp.productId)}
                                      disabled={isGenerating}
                                      data-testid={`button-regenerate-battlecard-${pp.productId}`}
                                    >
                                      {isGenerating ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                      ) : (
                                        <RefreshCw className="h-4 w-4" />
                                      )}
                                    </Button>
                                  </>
                                ) : (
                                  <Button
                                    onClick={() => generateBattlecard.mutate(pp.productId)}
                                    disabled={isGenerating}
                                    data-testid={`button-generate-battlecard-${pp.productId}`}
                                  >
                                    {isGenerating ? (
                                      <>
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        Generating...
                                      </>
                                    ) : (
                                      <>
                                        <Swords className="mr-2 h-4 w-4" />
                                        Generate Battlecard
                                      </>
                                    )}
                                  </Button>
                                )}
                              </div>
                            </div>
                            
                            {selectedBattlecard?.id === existingBattlecard?.id && existingBattlecard && (
                              <div className="p-4 border-t space-y-4">
                                {collabAllowed && (
                                  <div className="flex items-center justify-between">
                                    <CommentPopoverButton
                                      targetKind="product_battlecard"
                                      targetId={existingBattlecard.id}
                                      readOnly={isReadOnlyRole}
                                    />
                                  </div>
                                )}
                                <div className="grid gap-4 md:grid-cols-3">
                                  {/* Strengths */}
                                  <div className="space-y-2">
                                    <h5 className="font-medium text-sm flex items-center gap-1">
                                      <Check className="h-4 w-4 text-green-500" />
                                      Their Strengths
                                    </h5>
                                    <ul className="space-y-1">
                                      {existingBattlecard.strengths?.map((s, i) => (
                                        <li key={i} className="text-sm text-muted-foreground">• {s}</li>
                                      ))}
                                    </ul>
                                  </div>
                                  
                                  {/* Weaknesses */}
                                  <div className="space-y-2">
                                    <h5 className="font-medium text-sm flex items-center gap-1">
                                      <X className="h-4 w-4 text-red-500" />
                                      Their Weaknesses
                                    </h5>
                                    <ul className="space-y-1">
                                      {existingBattlecard.weaknesses?.map((w, i) => (
                                        <li key={i} className="text-sm text-muted-foreground">• {w}</li>
                                      ))}
                                    </ul>
                                  </div>
                                  
                                  {/* Our Advantages */}
                                  <div className="space-y-2">
                                    <h5 className="font-medium text-sm flex items-center gap-1">
                                      <Star className="h-4 w-4 text-yellow-500" />
                                      Our Advantages
                                    </h5>
                                    <ul className="space-y-1">
                                      {existingBattlecard.ourAdvantages?.map((a, i) => (
                                        <li key={i} className="text-sm text-muted-foreground">• {a}</li>
                                      ))}
                                    </ul>
                                  </div>
                                </div>
                                
                                {/* Key Differentiators */}
                                {existingBattlecard.keyDifferentiators && existingBattlecard.keyDifferentiators.length > 0 && (
                                  <div className="space-y-2">
                                    <h5 className="font-medium text-sm">Key Differentiators</h5>
                                    <div className="border rounded-lg overflow-hidden">
                                      <table className="w-full text-sm">
                                        <thead className="bg-muted/50">
                                          <tr>
                                            <th className="px-3 py-2 text-left font-medium">Feature</th>
                                            <th className="px-3 py-2 text-left font-medium">Us</th>
                                            <th className="px-3 py-2 text-left font-medium">Them</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {existingBattlecard.keyDifferentiators.map((d, i) => (
                                            <tr key={i} className="border-t">
                                              <td className="px-3 py-2 font-medium">{d.feature}</td>
                                              <td className="px-3 py-2 text-muted-foreground">{d.ours}</td>
                                              <td className="px-3 py-2 text-muted-foreground">{d.theirs}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                )}
                                
                                {/* Objection Handling */}
                                {existingBattlecard.objections && existingBattlecard.objections.length > 0 && (
                                  <div className="space-y-2">
                                    <h5 className="font-medium text-sm flex items-center gap-1">
                                      <MessageSquare className="h-4 w-4" />
                                      Objection Handling
                                    </h5>
                                    <div className="space-y-2">
                                      {existingBattlecard.objections.map((o, i) => (
                                        <div key={i} className="bg-muted/30 rounded-lg p-3">
                                          <p className="text-sm font-medium text-red-600 dark:text-red-400">"{o.objection}"</p>
                                          <p className="text-sm text-muted-foreground mt-1">→ {o.response}</p>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                
                                {/* Talk Tracks */}
                                {existingBattlecard.talkTracks && existingBattlecard.talkTracks.length > 0 && (
                                  <div className="space-y-2">
                                    <h5 className="font-medium text-sm">Sales Talk Tracks</h5>
                                    <div className="space-y-2">
                                      {existingBattlecard.talkTracks.map((t, i) => (
                                        <div key={i} className="bg-primary/5 rounded-lg p-3 border border-primary/20">
                                          <p className="text-sm font-medium">{t.scenario}</p>
                                          <p className="text-sm text-muted-foreground mt-1 italic">"{t.script}"</p>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                
                                {/* Export Actions */}
                                <div className="flex items-center gap-2 pt-4 border-t">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleCopyBattlecard(existingBattlecard)}
                                    data-testid={`button-copy-battlecard-${existingBattlecard.id}`}
                                  >
                                    <Copy className="h-4 w-4 mr-1" />
                                    Copy
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleDownloadBattlecardPdf(existingBattlecard)}
                                    disabled={downloadingBattlecard === "pdf"}
                                    data-testid={`button-pdf-battlecard-${existingBattlecard.id}`}
                                  >
                                    {downloadingBattlecard === "pdf" ? (
                                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                    ) : (
                                      <Download className="h-4 w-4 mr-1" />
                                    )}
                                    PDF
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleDownloadBattlecardText(existingBattlecard)}
                                    disabled={downloadingBattlecard === "txt"}
                                    data-testid={`button-txt-battlecard-${existingBattlecard.id}`}
                                  >
                                    {downloadingBattlecard === "txt" ? (
                                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                    ) : (
                                      <FileText className="h-4 w-4 mr-1" />
                                    )}
                                    Text
                                  </Button>
                                </div>
                                {collabAllowed && (
                                  <AnnotationRail
                                    targetKind="product_battlecard"
                                    targetId={existingBattlecard.id}
                                    readOnly={isReadOnlyRole}
                                    className="mt-4 border-t pt-4"
                                  />
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}

          {project.analysisType === "product" && baselineProduct && (
            <div className="mt-6">
              <RecentUpdatesCard
                entityType="product"
                entityId={baselineProduct.productId}
                entityName={baselineProduct.product.name}
              />
            </div>
          )}

          {project.analysisType === "company" && (
            <Card>
              <CardContent className="py-12 text-center">
                <Building className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">Company vs Company Analysis</h3>
                <p className="text-muted-foreground mb-4">
                  This is a company-level analysis project. Manage competitors from the Competitors page.
                </p>
                <Link href="/app/competitors">
                  <Button variant="outline">
                    <Building className="mr-2 h-4 w-4" />
                    Go to Competitors
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}
            </TabsContent>

            {/* Gap Analysis Tab Content */}
            <TabsContent value="gaps" className="mt-6">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <Sparkles className="h-5 w-5 text-primary" />
                        Competitive Gap Analysis
                      </CardTitle>
                      <CardDescription>
                        AI-identified positioning gaps against project competitors
                      </CardDescription>
                    </div>
                    {gapAnalysis?.lastGeneratedAt && (
                      <div className="flex items-center text-sm text-muted-foreground">
                        <Clock className="h-4 w-4 mr-1" />
                        Last updated: {new Date(gapAnalysis.lastGeneratedAt).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {competitorProducts.length === 0 ? (
                    <div className="text-center py-12 border-2 border-dashed rounded-lg" data-testid="gaps-no-competitors">
                      <Sparkles className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                      <h3 className="text-lg font-medium mb-2">No Competitors Added</h3>
                      <p className="text-muted-foreground max-w-md mx-auto">
                        Gap analysis requires competitor products for comparison. Add competitors from the Overview tab to enable this feature.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="flex gap-2">
                        <Button 
                          onClick={() => generateGapAnalysis.mutate()} 
                          disabled={generateGapAnalysis.isPending || !projectProducts.some(pp => pp.role === "baseline")}
                          data-testid="button-generate-gaps"
                        >
                          {generateGapAnalysis.isPending ? (
                            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Analyzing...</>
                          ) : (
                            <><Sparkles className="mr-2 h-4 w-4" /> {gapAnalysis?.status === "generated" ? "Regenerate" : "Generate"} Gap Analysis</>
                          )}
                        </Button>
                      </div>
                      
                      {gapLoading ? (
                        <LongFormContentSkeleton />
                      ) : gapAnalysis?.status === "generated" && gapAnalysis.content ? (
                        <div className="border rounded-lg p-6 bg-muted/30">
                          <MarkdownContent content={gapAnalysis.content} />
                        </div>
                      ) : (
                        <div className="text-center py-12 border-2 border-dashed rounded-lg">
                          <Sparkles className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                          <h3 className="text-lg font-medium mb-2">No Gap Analysis Yet</h3>
                          <p className="text-muted-foreground">
                            {projectProducts.some(pp => pp.role === "baseline") 
                              ? "Click 'Generate Gap Analysis' to identify positioning gaps"
                              : "Set a baseline product first to analyze gaps"}
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Strategic Recommendations Tab Content */}
            <TabsContent value="recommendations" className="mt-6">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <Star className="h-5 w-5 text-primary" />
                        Strategic Recommendations
                      </CardTitle>
                      <CardDescription>
                        Actionable suggestions based on competitive landscape
                      </CardDescription>
                    </div>
                    {strategicRecs?.lastGeneratedAt && (
                      <div className="flex items-center text-sm text-muted-foreground">
                        <Clock className="h-4 w-4 mr-1" />
                        Last updated: {new Date(strategicRecs.lastGeneratedAt).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {competitorProducts.length === 0 ? (
                    <div className="text-center py-12 border-2 border-dashed rounded-lg" data-testid="recs-no-competitors">
                      <Star className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                      <h3 className="text-lg font-medium mb-2">No Competitors Added</h3>
                      <p className="text-muted-foreground max-w-md mx-auto">
                        Strategic recommendations require competitor products for comparison. Add competitors from the Overview tab to enable this feature.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="flex gap-2">
                        <Button 
                          onClick={() => generateStrategicRecs.mutate()} 
                          disabled={generateStrategicRecs.isPending || !projectProducts.some(pp => pp.role === "baseline")}
                          data-testid="button-generate-recs"
                        >
                          {generateStrategicRecs.isPending ? (
                            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating...</>
                          ) : (
                            <><Star className="mr-2 h-4 w-4" /> {strategicRecs?.status === "generated" ? "Regenerate" : "Generate"} Recommendations</>
                          )}
                        </Button>
                      </div>
                      
                      {recsLoading ? (
                        <LongFormContentSkeleton />
                      ) : strategicRecs?.status === "generated" && strategicRecs.content ? (
                        <div className="border rounded-lg p-6 bg-muted/30">
                          <MarkdownContent content={strategicRecs.content} />
                        </div>
                      ) : (
                        <div className="text-center py-12 border-2 border-dashed rounded-lg">
                          <Star className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                          <h3 className="text-lg font-medium mb-2">No Recommendations Yet</h3>
                          <p className="text-muted-foreground">
                            {projectProducts.some(pp => pp.role === "baseline") 
                              ? "Click 'Generate Recommendations' to get strategic advice"
                              : "Set a baseline product first to get recommendations"}
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Competitive Summary Tab Content */}
            <TabsContent value="summary" className="mt-6">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <FileText className="h-5 w-5 text-primary" />
                        Competitive Summary Report
                      </CardTitle>
                      <CardDescription>
                        Consolidated view of all competitor insights
                      </CardDescription>
                    </div>
                    {competitiveSummary?.lastGeneratedAt && (
                      <div className="flex items-center text-sm text-muted-foreground">
                        <Clock className="h-4 w-4 mr-1" />
                        Last updated: {new Date(competitiveSummary.lastGeneratedAt).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {competitorProducts.length === 0 ? (
                    <div className="text-center py-12 border-2 border-dashed rounded-lg" data-testid="summary-no-competitors">
                      <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                      <h3 className="text-lg font-medium mb-2">No Competitors Added</h3>
                      <p className="text-muted-foreground max-w-md mx-auto">
                        The competitive summary requires competitor products for comparison. Add competitors from the Overview tab to enable this feature.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="flex gap-2">
                        <Button 
                          onClick={() => generateCompetitiveSummary.mutate()} 
                          disabled={generateCompetitiveSummary.isPending || !projectProducts.some(pp => pp.role === "baseline")}
                          data-testid="button-generate-summary"
                        >
                          {generateCompetitiveSummary.isPending ? (
                            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating...</>
                          ) : (
                            <><FileText className="mr-2 h-4 w-4" /> {competitiveSummary?.status === "generated" ? "Regenerate" : "Generate"} Summary</>
                          )}
                        </Button>
                      </div>
                      
                      {summaryLoading ? (
                        <LongFormContentSkeleton />
                      ) : competitiveSummary?.status === "generated" && competitiveSummary.content ? (
                        <div className="border rounded-lg p-6 bg-muted/30">
                          <MarkdownContent content={competitiveSummary.content} />
                        </div>
                      ) : (
                        <div className="text-center py-12 border-2 border-dashed rounded-lg">
                          <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                          <h3 className="text-lg font-medium mb-2">No Summary Yet</h3>
                          <p className="text-muted-foreground">
                            {projectProducts.some(pp => pp.role === "baseline") 
                              ? "Click 'Generate Summary' to create a competitive overview"
                              : "Set a baseline product first to create a summary"}
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* GTM Plan Tab Content */}
            <TabsContent value="gtm_plan" className="mt-6">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <Rocket className="h-5 w-5 text-primary" />
                        Go-To-Market Plan
                      </CardTitle>
                      <CardDescription>
                        AI-generated strategic plan for market entry and growth
                      </CardDescription>
                    </div>
                    {gtmPlan?.lastGeneratedAt && (
                      <div className="flex items-center text-sm text-muted-foreground">
                        <Clock className="h-4 w-4 mr-1" />
                        Last updated: {new Date(gtmPlan.lastGeneratedAt).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* GTM Prompts Form */}
                  <div className="border rounded-lg p-4 bg-muted/30">
                    <h4 className="font-medium mb-4">Guidance for AI Generation</h4>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="gtm-target-roles">Target Roles/Personas</Label>
                        <Input
                          id="gtm-target-roles"
                          placeholder="e.g., CTO, VP Engineering, DevOps Lead"
                          value={gtmPrompts.targetRoles}
                          onChange={(e) => setGtmPrompts({ ...gtmPrompts, targetRoles: e.target.value })}
                          data-testid="input-gtm-target-roles"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="gtm-distribution">Distribution Channels</Label>
                        <Input
                          id="gtm-distribution"
                          placeholder="e.g., Direct sales, Channel partners, Digital"
                          value={gtmPrompts.distributionChannels}
                          onChange={(e) => setGtmPrompts({ ...gtmPrompts, distributionChannels: e.target.value })}
                          data-testid="input-gtm-distribution"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="gtm-budget">Budget Considerations</Label>
                        <Input
                          id="gtm-budget"
                          placeholder="e.g., $50K-100K, Bootstrapped, Series A"
                          value={gtmPrompts.budget}
                          onChange={(e) => setGtmPrompts({ ...gtmPrompts, budget: e.target.value })}
                          data-testid="input-gtm-budget"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="gtm-timeline">Timeline</Label>
                        <Input
                          id="gtm-timeline"
                          placeholder="e.g., Q1 2026, 6 months, Immediate"
                          value={gtmPrompts.timeline}
                          onChange={(e) => setGtmPrompts({ ...gtmPrompts, timeline: e.target.value })}
                          data-testid="input-gtm-timeline"
                        />
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <Label htmlFor="gtm-guidance">Additional Guidance</Label>
                        <Textarea
                          id="gtm-guidance"
                          placeholder="Any specific requirements, constraints, or focus areas..."
                          value={gtmPrompts.customGuidance}
                          onChange={(e) => setGtmPrompts({ ...gtmPrompts, customGuidance: e.target.value })}
                          data-testid="input-gtm-guidance"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2 mt-4">
                      <Button 
                        onClick={() => generateGtmPlan.mutate()} 
                        disabled={generateGtmPlan.isPending}
                        data-testid="button-generate-gtm"
                      >
                        {generateGtmPlan.isPending ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Generating...
                          </>
                        ) : gtmPlan?.status === "generated" ? (
                          <>
                            <RefreshCw className="mr-2 h-4 w-4" />
                            Regenerate GTM Plan
                          </>
                        ) : (
                          <>
                            <Sparkles className="mr-2 h-4 w-4" />
                            Generate GTM Plan
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* GTM Content Display */}
                  {gtmLoading ? (
                    <LongFormContentSkeleton />
                  ) : gtmPlan?.status === "generated" && gtmPlan.content ? (
                    <div className="space-y-4">
                      <div className="flex gap-2 justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const blob = new Blob([gtmPlan.content || ""], { type: "text/markdown" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `gtm_plan_${new Date().toISOString().split('T')[0]}.md`;
                            a.click();
                            URL.revokeObjectURL(url);
                          }}
                          data-testid="button-download-gtm-md"
                        >
                          <Download className="mr-2 h-4 w-4" />
                          Download Markdown
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => window.open(`/api/recommendations/${gtmPlan.id}/download/docx`, "_blank")}
                          data-testid="button-download-gtm-docx"
                        >
                          <FileText className="mr-2 h-4 w-4" />
                          Download Word
                        </Button>
                      </div>
                      <div className="prose prose-sm dark:prose-invert max-w-none border rounded-lg p-6 bg-card">
                        <MarkdownContent content={gtmPlan.content} />
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-12 border-2 border-dashed rounded-lg">
                      <Rocket className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                      <h3 className="text-lg font-medium mb-2">No GTM Plan Generated Yet</h3>
                      <p className="text-muted-foreground mb-4">
                        Fill in the guidance above and click generate to create your Go-To-Market plan.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Messaging Framework Tab Content */}
            <TabsContent value="messaging" className="mt-6">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <MessageCircle className="h-5 w-5 text-primary" />
                        Messaging & Positioning Framework
                      </CardTitle>
                      <CardDescription>
                        AI-generated brand messaging and positioning strategy
                      </CardDescription>
                    </div>
                    {messagingFramework?.lastGeneratedAt && (
                      <div className="flex items-center text-sm text-muted-foreground">
                        <Clock className="h-4 w-4 mr-1" />
                        Last updated: {new Date(messagingFramework.lastGeneratedAt).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Messaging Prompts Form */}
                  <div className="border rounded-lg p-4 bg-muted/30">
                    <h4 className="font-medium mb-4">Guidance for AI Generation</h4>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="msg-audience">Target Audience</Label>
                        <Input
                          id="msg-audience"
                          placeholder="e.g., Enterprise IT teams, SMB owners"
                          value={messagingPrompts.targetAudience}
                          onChange={(e) => setMessagingPrompts({ ...messagingPrompts, targetAudience: e.target.value })}
                          data-testid="input-msg-audience"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="msg-tone">Tone of Voice</Label>
                        <Input
                          id="msg-tone"
                          placeholder="e.g., Professional, Friendly, Bold"
                          value={messagingPrompts.toneOfVoice}
                          onChange={(e) => setMessagingPrompts({ ...messagingPrompts, toneOfVoice: e.target.value })}
                          data-testid="input-msg-tone"
                        />
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <Label htmlFor="msg-key-messages">Key Messages to Emphasize</Label>
                        <Input
                          id="msg-key-messages"
                          placeholder="e.g., Security-first, Cost savings, Ease of use"
                          value={messagingPrompts.keyMessages}
                          onChange={(e) => setMessagingPrompts({ ...messagingPrompts, keyMessages: e.target.value })}
                          data-testid="input-msg-key-messages"
                        />
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <Label htmlFor="msg-guidance">Additional Guidance</Label>
                        <Textarea
                          id="msg-guidance"
                          placeholder="Any specific requirements, brand guidelines, or focus areas..."
                          value={messagingPrompts.customGuidance}
                          onChange={(e) => setMessagingPrompts({ ...messagingPrompts, customGuidance: e.target.value })}
                          data-testid="input-msg-guidance"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2 mt-4">
                      <Button 
                        onClick={() => generateMessagingFramework.mutate()} 
                        disabled={generateMessagingFramework.isPending}
                        data-testid="button-generate-messaging"
                      >
                        {generateMessagingFramework.isPending ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Generating...
                          </>
                        ) : messagingFramework?.status === "generated" ? (
                          <>
                            <RefreshCw className="mr-2 h-4 w-4" />
                            Regenerate Framework
                          </>
                        ) : (
                          <>
                            <Sparkles className="mr-2 h-4 w-4" />
                            Generate Framework
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* Messaging Content Display */}
                  {messagingLoading ? (
                    <LongFormContentSkeleton />
                  ) : messagingFramework?.status === "generated" && messagingFramework.content ? (
                    <div className="space-y-4">
                      <div className="flex gap-2 justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const blob = new Blob([messagingFramework.content || ""], { type: "text/markdown" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `messaging_framework_${new Date().toISOString().split('T')[0]}.md`;
                            a.click();
                            URL.revokeObjectURL(url);
                          }}
                          data-testid="button-download-msg-md"
                        >
                          <Download className="mr-2 h-4 w-4" />
                          Download Markdown
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => window.open(`/api/recommendations/${messagingFramework.id}/download/docx`, "_blank")}
                          data-testid="button-download-msg-docx"
                        >
                          <FileText className="mr-2 h-4 w-4" />
                          Download Word
                        </Button>
                      </div>
                      <div className="prose prose-sm dark:prose-invert max-w-none border rounded-lg p-6 bg-card">
                        <MarkdownContent content={messagingFramework.content} />
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-12 border-2 border-dashed rounded-lg">
                      <MessageCircle className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                      <h3 className="text-lg font-medium mb-2">No Messaging Framework Generated Yet</h3>
                      <p className="text-muted-foreground mb-4">
                        Fill in the guidance above and click generate to create your messaging framework.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Side-by-Side Messaging Comparison */}
              <Card className="mt-6">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Swords className="h-5 w-5 text-primary" />
                    Side-by-Side Messaging Comparison
                  </CardTitle>
                  <CardDescription>
                    Compare your messaging against each competitor
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {comparisonLoading ? (
                    <LongFormContentSkeleton />
                  ) : !messagingComparison?.baseline ? (
                    <div className="text-center py-12 border-2 border-dashed rounded-lg">
                      <Package className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                      <h3 className="text-lg font-medium mb-2">No Baseline Product</h3>
                      <p className="text-muted-foreground">
                        Add a baseline product to compare messaging against competitors.
                      </p>
                    </div>
                  ) : messagingComparison.competitors.length === 0 ? (
                    <div className="text-center py-12 border-2 border-dashed rounded-lg">
                      <Building className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                      <h3 className="text-lg font-medium mb-2">No Competitors Added</h3>
                      <p className="text-muted-foreground">
                        Add competitor products to see side-by-side messaging comparison.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      <div className="text-sm text-muted-foreground mb-4">
                        {messagingComparison.analyzedCompetitors} of {messagingComparison.totalCompetitors} competitors analyzed
                      </div>
                      
                      {messagingComparison.competitors.map((competitor) => (
                        <div key={competitor.id} className="border rounded-lg overflow-hidden" data-testid={`comparison-${competitor.id}`}>
                          <div className="bg-muted/30 px-4 py-3 border-b">
                            <h4 className="font-semibold flex items-center gap-2">
                              {messagingComparison.baseline?.name} vs {competitor.name}
                              {!competitor.hasAnalysis && (
                                <Badge variant="outline" className="text-xs">Not analyzed</Badge>
                              )}
                            </h4>
                          </div>
                          
                          <div className="grid md:grid-cols-2 divide-x divide-border">
                            {/* Your Product Column */}
                            <div className="p-4 space-y-4">
                              <div className="flex items-center gap-2 text-primary font-medium mb-3">
                                <Star className="h-4 w-4" />
                                {messagingComparison.baseline?.name}
                              </div>
                              
                              {messagingComparison.baseline?.messaging.valueProposition && (
                                <div>
                                  <h5 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Value Proposition</h5>
                                  <p className="text-sm">{messagingComparison.baseline.messaging.valueProposition}</p>
                                </div>
                              )}
                              
                              {messagingComparison.baseline?.messaging.targetAudience && (
                                <div>
                                  <h5 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Target Audience</h5>
                                  <p className="text-sm">{messagingComparison.baseline.messaging.targetAudience}</p>
                                </div>
                              )}
                              
                              {messagingComparison.baseline?.messaging.keyMessages && messagingComparison.baseline.messaging.keyMessages.length > 0 && (
                                <div>
                                  <h5 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Key Messages</h5>
                                  <ul className="text-sm space-y-1">
                                    {messagingComparison.baseline.messaging.keyMessages.map((msg, i) => (
                                      <li key={i} className="flex items-start gap-2">
                                        <Check className="h-3 w-3 mt-1 text-primary flex-shrink-0" />
                                        {msg}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              
                              {(!messagingComparison.baseline?.messaging.valueProposition && 
                                !messagingComparison.baseline?.messaging.targetAudience &&
                                (!messagingComparison.baseline?.messaging.keyMessages || messagingComparison.baseline.messaging.keyMessages.length === 0)) && (
                                <p className="text-sm text-muted-foreground italic">No analysis data available. Run analysis to populate.</p>
                              )}
                            </div>
                            
                            {/* Competitor Column */}
                            <div className="p-4 space-y-4 bg-muted/10">
                              <div className="flex items-center gap-2 font-medium mb-3">
                                <Building className="h-4 w-4" />
                                {competitor.name}
                              </div>
                              
                              {competitor.hasAnalysis ? (
                                <>
                                  {competitor.messaging.valueProposition && (
                                    <div>
                                      <h5 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Value Proposition</h5>
                                      <p className="text-sm">{competitor.messaging.valueProposition}</p>
                                    </div>
                                  )}
                                  
                                  {competitor.messaging.targetAudience && (
                                    <div>
                                      <h5 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Target Audience</h5>
                                      <p className="text-sm">{competitor.messaging.targetAudience}</p>
                                    </div>
                                  )}
                                  
                                  {competitor.messaging.keyMessages && competitor.messaging.keyMessages.length > 0 && (
                                    <div>
                                      <h5 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Key Messages</h5>
                                      <ul className="text-sm space-y-1">
                                        {competitor.messaging.keyMessages.map((msg, i) => (
                                          <li key={i} className="flex items-start gap-2">
                                            <X className="h-3 w-3 mt-1 text-muted-foreground flex-shrink-0" />
                                            {msg}
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                  
                                  {(!competitor.messaging.valueProposition && 
                                    !competitor.messaging.targetAudience &&
                                    (!competitor.messaging.keyMessages || competitor.messaging.keyMessages.length === 0)) && (
                                    <p className="text-sm text-muted-foreground italic">Analysis exists but no messaging data extracted.</p>
                                  )}
                                </>
                              ) : (
                                <p className="text-sm text-muted-foreground italic">
                                  Not analyzed yet. Generate a battlecard or run analysis to see messaging.
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Product One Sheet Tab Content */}
            <TabsContent value="one_sheet" className="mt-6">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <FileBarChart className="h-5 w-5 text-primary" />
                        Product One Sheet
                      </CardTitle>
                      <CardDescription>
                        AI-generated marketing copy draft for a single-page product overview
                      </CardDescription>
                    </div>
                    {productOneSheet?.lastGeneratedAt && (
                      <div className="flex items-center text-sm text-muted-foreground">
                        <Clock className="h-4 w-4 mr-1" />
                        Last updated: {new Date(productOneSheet.lastGeneratedAt).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* One Sheet Prompts Form */}
                  <div className="border rounded-lg p-4 bg-muted/30">
                    <h4 className="font-medium mb-4">Guidance for AI Generation</h4>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="os-audience">Target Audience</Label>
                        <Input
                          id="os-audience"
                          placeholder="e.g., Enterprise IT leaders, SMB owners"
                          value={oneSheetPrompts.targetAudience}
                          onChange={(e) => setOneSheetPrompts({ ...oneSheetPrompts, targetAudience: e.target.value })}
                          data-testid="input-os-audience"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="os-tone">Tone of Voice</Label>
                        <Input
                          id="os-tone"
                          placeholder="e.g., Professional, Friendly, Bold"
                          value={oneSheetPrompts.toneOfVoice}
                          onChange={(e) => setOneSheetPrompts({ ...oneSheetPrompts, toneOfVoice: e.target.value })}
                          data-testid="input-os-tone"
                        />
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <Label htmlFor="os-benefits">Key Benefits to Highlight</Label>
                        <Input
                          id="os-benefits"
                          placeholder="e.g., Cost savings, Ease of use, Security"
                          value={oneSheetPrompts.keyBenefits}
                          onChange={(e) => setOneSheetPrompts({ ...oneSheetPrompts, keyBenefits: e.target.value })}
                          data-testid="input-os-benefits"
                        />
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <Label htmlFor="os-guidance">Additional Guidance</Label>
                        <Textarea
                          id="os-guidance"
                          placeholder="Any specific requirements, brand guidelines, or focus areas..."
                          value={oneSheetPrompts.customGuidance}
                          onChange={(e) => setOneSheetPrompts({ ...oneSheetPrompts, customGuidance: e.target.value })}
                          data-testid="input-os-guidance"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2 mt-4">
                      <Button 
                        onClick={() => generateProductOneSheet.mutate()} 
                        disabled={generateProductOneSheet.isPending}
                        data-testid="button-generate-one-sheet"
                      >
                        {generateProductOneSheet.isPending ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Generating...
                          </>
                        ) : productOneSheet?.status === "generated" ? (
                          <>
                            <RefreshCw className="mr-2 h-4 w-4" />
                            Regenerate One Sheet
                          </>
                        ) : (
                          <>
                            <Sparkles className="mr-2 h-4 w-4" />
                            Generate One Sheet
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* One Sheet Content Display */}
                  {oneSheetLoading ? (
                    <LongFormContentSkeleton />
                  ) : productOneSheet?.status === "generated" && productOneSheet.content ? (
                    <div className="space-y-4">
                      <div className="flex gap-2 justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const blob = new Blob([productOneSheet.content || ""], { type: "text/markdown" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `product_one_sheet_${new Date().toISOString().split('T')[0]}.md`;
                            a.click();
                            URL.revokeObjectURL(url);
                          }}
                          data-testid="button-download-os-md"
                        >
                          <Download className="mr-2 h-4 w-4" />
                          Download Markdown
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => window.open(`/api/recommendations/${productOneSheet.id}/download/docx`, "_blank")}
                          data-testid="button-download-os-docx"
                        >
                          <FileText className="mr-2 h-4 w-4" />
                          Download Word
                        </Button>
                      </div>
                      <div className="prose prose-sm dark:prose-invert max-w-none border rounded-lg p-6 bg-card">
                        <MarkdownContent content={productOneSheet.content} />
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-12 border-2 border-dashed rounded-lg">
                      <FileBarChart className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                      <h3 className="text-lg font-medium mb-2">No Product One Sheet Generated Yet</h3>
                      <p className="text-muted-foreground mb-4">
                        Fill in the guidance above and click generate to create your product marketing copy.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Features Tab Content */}
            <TabsContent value="features" className="mt-6">
              {baselineProduct && (
                <FeaturesTab 
                  productId={baselineProduct.productId} 
                  product={baselineProduct.product}
                />
              )}
            </TabsContent>

            {/* Roadmap Tab Content */}
            <TabsContent value="roadmap" className="mt-6">
              {baselineProduct && (
                <RoadmapTab 
                  productId={baselineProduct.productId} 
                  product={baselineProduct.product}
                />
              )}
            </TabsContent>

            {/* Customer Feedback Tab Content */}
            <TabsContent value="feedback" className="mt-6">
              {baselineProduct && (
                <FeedbackTab
                  productId={baselineProduct.productId}
                  productName={baselineProduct.product?.name || "this product"}
                />
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <Dialog open={isEditProductOpen} onOpenChange={(open) => {
        setIsEditProductOpen(open);
        if (!open) setEditingProduct(null);
      }}>
        <DialogContent className="max-h-[90vh] flex flex-col">
          <form onSubmit={(e) => {
            e.preventDefault();
            if (editingProduct) {
              updateProduct.mutate({ productId: editingProduct.id, data: editFormData });
            }
          }} className="flex flex-col flex-1 overflow-hidden">
            <DialogHeader>
              <DialogTitle>Edit Product</DialogTitle>
              <DialogDescription>
                Update product details. Use the auto-fetch button to generate a description from the website.
              </DialogDescription>
            </DialogHeader>
            <ScrollArea className="flex-1 pr-4 -mr-4">
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="edit-name">Product Name</Label>
                <Input
                  id="edit-name"
                  data-testid="input-edit-product-name"
                  value={editFormData.name}
                  onChange={(e) => setEditFormData({ ...editFormData, name: e.target.value })}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit-companyName">Company Name</Label>
                <Input
                  id="edit-companyName"
                  data-testid="input-edit-company-name"
                  value={editFormData.companyName}
                  onChange={(e) => setEditFormData({ ...editFormData, companyName: e.target.value })}
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div className="space-y-0.5">
                  <Label htmlFor="edit-isBaseline" className="font-medium">
                    {editFormData.isBaseline ? "Our product" : "Competitor product"}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {editFormData.isBaseline
                      ? "This product belongs to your company"
                      : "This product belongs to a competitor"}
                  </p>
                </div>
                <Switch
                  id="edit-isBaseline"
                  data-testid="switch-edit-is-baseline"
                  checked={editFormData.isBaseline}
                  onCheckedChange={(checked) => setEditFormData({ ...editFormData, isBaseline: !!checked })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit-url">Product URL</Label>
                <Input
                  id="edit-url"
                  data-testid="input-edit-product-url"
                  placeholder="https://..."
                  value={editFormData.url}
                  onChange={(e) => setEditFormData({ ...editFormData, url: e.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="edit-description">Description</Label>
                  <Button 
                    type="button"
                    variant="outline" 
                    size="sm"
                    onClick={autoFetchDescription}
                    disabled={isAutoFetching || !editFormData.url}
                    data-testid="button-auto-fetch-description"
                  >
                    {isAutoFetching ? (
                      <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                    ) : (
                      <Wand2 className="mr-2 h-3 w-3" />
                    )}
                    Auto-fetch from URL
                  </Button>
                </div>
                <Textarea
                  id="edit-description"
                  data-testid="input-edit-product-description"
                  placeholder="Brief description of the product..."
                  value={editFormData.description}
                  onChange={(e) => setEditFormData({ ...editFormData, description: e.target.value })}
                  rows={4}
                />
              </div>
              <div className="pt-4 border-t">
                <Label className="text-sm font-medium mb-3 block">Social Media (Product-Specific)</Label>
                <div className="grid gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="edit-linkedin" className="flex items-center gap-2 text-sm">
                      <Linkedin className="h-4 w-4 text-[#0077B5]" /> LinkedIn URL
                    </Label>
                    <Input
                      id="edit-linkedin"
                      data-testid="input-edit-product-linkedin"
                      placeholder="https://linkedin.com/company/..."
                      value={editFormData.linkedInUrl}
                      onChange={(e) => setEditFormData({ ...editFormData, linkedInUrl: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="edit-instagram" className="flex items-center gap-2 text-sm">
                      <Instagram className="h-4 w-4 text-[#E4405F]" /> Instagram URL
                    </Label>
                    <Input
                      id="edit-instagram"
                      data-testid="input-edit-product-instagram"
                      placeholder="https://instagram.com/..."
                      value={editFormData.instagramUrl}
                      onChange={(e) => setEditFormData({ ...editFormData, instagramUrl: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="edit-twitter" className="flex items-center gap-2 text-sm">
                      <Twitter className="h-4 w-4 text-[#1DA1F2]" /> Twitter/X URL
                    </Label>
                    <Input
                      id="edit-twitter"
                      data-testid="input-edit-product-twitter"
                      placeholder="https://x.com/..."
                      value={editFormData.twitterUrl}
                      onChange={(e) => setEditFormData({ ...editFormData, twitterUrl: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="edit-blogUrl" className="flex items-center gap-2 text-sm">
                      <FileText className="h-4 w-4 text-orange-500" /> Blog URL
                    </Label>
                    <Input
                      id="edit-blogUrl"
                      placeholder="https://company.com/blog"
                      value={editFormData.blogUrl}
                      onChange={(e) => setEditFormData({ ...editFormData, blogUrl: e.target.value })}
                      data-testid="input-edit-blog-url"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="edit-frequency" className="flex items-center gap-2 text-sm">
                      <RefreshCw className="h-4 w-4 text-purple-500" /> Auto-check Frequency
                    </Label>
                    <select
                      id="edit-frequency"
                      value={editFormData.socialCheckFrequency}
                      onChange={(e) => setEditFormData({ ...editFormData, socialCheckFrequency: e.target.value })}
                      className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                      data-testid="select-edit-social-frequency"
                    >
                      <option value="hourly">Hourly</option>
                      <option value="daily">Daily (default)</option>
                      <option value="weekly">Weekly</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
            </ScrollArea>
            <DialogFooter className="pt-4 border-t mt-4">
              <Button type="submit" data-testid="button-save-product" disabled={updateProduct.isPending}>
                {updateProduct.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
