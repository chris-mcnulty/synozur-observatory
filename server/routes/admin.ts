import type { Express } from "express";
import { randomUUID } from "crypto";
import { UploadedFile } from "express-fileupload";
import { storage, type ContextFilter } from "../storage";
import { getRequestContext, ContextError, getActiveTenantId, getActiveMarketId } from "../context";
import { toContextFilter, validateResourceContext, hasAdminAccess, hasContentAccess, hasCrossTenantReadAccess, logAiUsage, parseManualResearch, switchTenantSchema, switchMarketSchema, createMarketSchema, updateMarketSchema, guardManualAction, guardFeature } from "./helpers";
import { checkFeatureAccessAsync, getPlanFeaturesAsync, invalidatePlanCache, FEATURE_REGISTRY, FEATURE_CATEGORIES, MANUAL_ACTION_KEYS, MANUAL_ACTION_LABELS, type ManualActionKey } from "../services/plan-policy";
import { getManualActionUsageSummary, grantManualActionBonus, listManualActionBonuses } from "../services/manual-action-quota";
import { insertGroundingDocumentSchema, insertCompanyProfileSchema, insertAssessmentSchema, analyticsConnections, markets } from "@shared/schema";
import { db } from "../db";
import { eq, isNull } from "drizzle-orm";
import { fromError } from "zod-validation-error";
import Anthropic from "@anthropic-ai/sdk";
import { objectStorageClient } from "../replit_integrations/object_storage/objectStorage";
import { documentExtractionService } from "../services/document-extraction";
import { analyzeCompetitorWebsite, aiCompanyResearch, type LinkedInContext } from "../ai-service";
import { invalidateMarketStatusCache } from "../services/scheduled-jobs";
import { validateCompetitorUrl, validateBlogUrl } from "../utils/url-validator";
import { calculateBaselineScore, getCurrentWeeklyPeriod } from "../services/scoring-service";
import { PUBLIC_TENANT_RATE_LIMIT_MAX } from "./product-feedback";

export function registerAdminRoutes(app: Express) {
  // ==================== GLOBAL SOCIAL OAUTH CREDENTIALS ====================
  // Synozur owns one OAuth app per social platform (Buffer/Hootsuite model).
  // Only a Global Admin manages these; tenants connect one-click and never see
  // or enter them. Secrets are encrypted at rest and never returned over the wire.
  async function requireGlobalAdmin(
    req: import("express").Request,
    res: import("express").Response,
  ): Promise<boolean> {
    if (!req.session.userId) {
      res.status(401).json({ error: "Not authenticated" });
      return false;
    }
    const user = await storage.getUser(req.session.userId);
    // The shared OAuth apps are platform-wide — every tenant publishes through
    // them — so this is restricted to Synozur platform super-admins: a Global
    // Admin whose account lives on the synozur.com tenant. This mirrors the
    // cross-tenant guard on /api/users so a tenant-scoped "Global Admin" can't
    // modify credentials that affect all tenants.
    const isSynozurGlobalAdmin = !!user
      && user.role === "Global Admin"
      && user.email.split("@")[1] === "synozur.com";
    if (!isSynozurGlobalAdmin) {
      res.status(403).json({ error: "Only Synozur Global Admins can manage platform credentials" });
      return false;
    }
    return true;
  }

  app.get("/api/admin/platform-credentials", async (req, res) => {
    if (!await requireGlobalAdmin(req, res)) return;
    const { listGlobalPlatformCredentialMetadata } = await import("../services/platform-credentials-service");
    const { GLOBAL_CREDENTIAL_PLATFORMS } = await import("@shared/schema");
    const items = await listGlobalPlatformCredentialMetadata(GLOBAL_CREDENTIAL_PLATFORMS);
    res.json({ items });
  });

  app.put("/api/admin/platform-credentials/:platform", async (req, res) => {
    if (!await requireGlobalAdmin(req, res)) return;
    const { upsertGlobalPlatformCredentials } = await import("../services/platform-credentials-service");
    const { GLOBAL_CREDENTIAL_PLATFORMS } = await import("@shared/schema");
    const platform = req.params.platform;
    if (!(GLOBAL_CREDENTIAL_PLATFORMS as readonly string[]).includes(platform)) {
      return res.status(400).json({ error: `Unsupported platform: ${platform}` });
    }
    const { clientId, clientSecret, notes, directPublishEnabled } = req.body ?? {};
    if (typeof clientId !== "string" || !clientId.trim()) {
      return res.status(400).json({ error: "clientId is required" });
    }
    if (clientSecret !== undefined && clientSecret !== null && typeof clientSecret !== "string") {
      return res.status(400).json({ error: "clientSecret must be a string when provided" });
    }
    if (directPublishEnabled !== undefined && typeof directPublishEnabled !== "boolean") {
      return res.status(400).json({ error: "directPublishEnabled must be a boolean when provided" });
    }
    try {
      await upsertGlobalPlatformCredentials({
        platform: platform as any,
        clientId: clientId.trim(),
        clientSecret: clientSecret === undefined ? undefined : (clientSecret ? clientSecret.trim() : null),
        notes: notes === undefined ? undefined : (typeof notes === "string" ? notes.slice(0, 500) : null),
        directPublishEnabled,
        userId: req.session.userId!,
      });
      res.json({ success: true });
    } catch (err: any) {
      console.error("[Global Platform Credentials Save Error]", err.message);
      res.status(500).json({ error: err.message || "Failed to save credentials" });
    }
  });

  app.delete("/api/admin/platform-credentials/:platform", async (req, res) => {
    if (!await requireGlobalAdmin(req, res)) return;
    const { deleteGlobalPlatformCredentials } = await import("../services/platform-credentials-service");
    const { GLOBAL_CREDENTIAL_PLATFORMS } = await import("@shared/schema");
    const platform = req.params.platform;
    if (!(GLOBAL_CREDENTIAL_PLATFORMS as readonly string[]).includes(platform)) {
      return res.status(400).json({ error: `Unsupported platform: ${platform}` });
    }
    await deleteGlobalPlatformCredentials(platform as any);
    res.status(204).send();
  });

  // ==================== USER MANAGEMENT ROUTES ====================

  app.get("/api/users", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const currentUser = await storage.getUser(req.session.userId);
      // Allow Admins to manage users, Consultants to view users (read-only cross-tenant)
      if (!currentUser || (!hasAdminAccess(currentUser.role) && currentUser.role !== "Consultant")) {
        return res.status(403).json({ error: "Forbidden: Admin or Consultant access required" });
      }

      const tenantDomain = currentUser.email.split("@")[1];
      
      // Security: Domain Admins can only see users in their own tenant
      // Global Admins and Consultants from Synozur can see all users across all tenants (read-only for Consultants)
      let users;
      if ((currentUser.role === "Global Admin" || currentUser.role === "Consultant") && tenantDomain === "synozur.com") {
        // Platform super-admin or consultant: can see all users across all tenants
        users = await storage.getAllUsers();
      } else {
        // Domain Admin: only see users in their tenant
        users = await storage.getUsersByDomain(tenantDomain);
      }
      
      const usersWithoutPasswords = users.map(({ password, ...user }) => user);
      res.json(usersWithoutPasswords);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== GROUNDING DOCUMENTS ROUTES ====================

  app.get("/api/documents", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const productId = typeof req.query.productId === "string" ? req.query.productId : undefined;
      const competitorId = typeof req.query.competitorId === "string" ? req.query.competitorId : undefined;
      const forContext = typeof req.query.forContext === "string" ? req.query.forContext : undefined;
      const documents = await storage.getGroundingDocumentsByContext(
        toContextFilter(ctx),
        forContext,
        { productId, competitorId },
      );
      res.json(documents);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/documents/:id", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);

      const document = await storage.getGroundingDocument(req.params.id);
      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      // Validate document belongs to current context
      if (!validateResourceContext(document, ctx)) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json(document);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/documents", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);

      if (req.body.contexts && Array.isArray(req.body.contexts)) {
        const { GROUNDING_DOC_CONTEXTS } = await import("@shared/schema");
        const validContexts = GROUNDING_DOC_CONTEXTS as readonly string[];
        const invalid = req.body.contexts.filter((c: string) => !validContexts.includes(c));
        if (invalid.length > 0) {
          return res.status(400).json({ error: `Invalid context values: ${invalid.join(", ")}` });
        }
      }

      if (req.body.competitorId) {
        const competitor = await storage.getCompetitorByIdWithContext(req.body.competitorId, toContextFilter(ctx));
        if (!competitor) {
          return res.status(400).json({ error: "competitorId does not belong to the current tenant/market" });
        }
      }

      if (req.body.productId) {
        const product = await storage.getProduct(req.body.productId);
        if (!product || !validateResourceContext(product, ctx)) {
          return res.status(400).json({ error: "productId does not belong to the current tenant/market" });
        }
        if (req.body.competitorId && product.competitorId !== req.body.competitorId) {
          return res.status(400).json({ error: "productId does not belong to the specified competitor" });
        }
      }

      const parsed = insertGroundingDocumentSchema.safeParse({
        ...req.body,
        userId: ctx.userId,
        tenantDomain: ctx.tenantDomain,
        marketId: ctx.marketId,
      });

      if (!parsed.success) {
        return res.status(400).json({ error: fromError(parsed.error).toString() });
      }

      const document = await storage.createGroundingDocument(parsed.data);

      // Extract text asynchronously
      if (document.fileUrl && document.fileType) {
        documentExtractionService
          .extractTextFromDocument(document.fileUrl, document.fileType)
          .then(async (extractedText) => {
            await storage.updateGroundingDocumentText(document.id, extractedText);
          })
          .catch((err) => {
            console.error(`Failed to extract text from document ${document.id}:`, err);
          });
      }

      res.json(document);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/documents/:id", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);

      const document = await storage.getGroundingDocument(req.params.id);
      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      // Validate document belongs to current context
      if (!validateResourceContext(document, ctx)) {
        return res.status(403).json({ error: "Access denied" });
      }

      await storage.deleteGroundingDocument(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Get grounding context for AI prompts
  app.get("/api/documents/context/ai", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const documents = await storage.getGroundingDocumentsByContext(toContextFilter(ctx));

      const context = documentExtractionService.prepareGroundingContext(
        documents.map((d) => ({
          name: d.name,
          extractedText: d.extractedText,
          scope: d.scope,
        }))
      );

      res.json({ context });
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== GA4 HEALTH (Global Admin + Consultant) ====================

  app.get("/api/admin/ga-health", async (req, res) => {
    try {
      if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
      const me = await storage.getUser(req.session.userId);
      if (!me || !hasCrossTenantReadAccess(me.role)) {
        return res.status(403).json({ error: "Only Global Admins and Consultants can view GA4 health" });
      }
      const rows = await db
        .select({
          tenantDomain: analyticsConnections.tenantDomain,
          status: analyticsConnections.status,
          propertyId: analyticsConnections.propertyId,
          propertyName: analyticsConnections.propertyName,
          lastSyncAt: analyticsConnections.lastSyncAt,
          consecutiveErrors: analyticsConnections.consecutiveErrors,
        })
        .from(analyticsConnections)
        .where(isNull(analyticsConnections.marketId));
      const byDomain: Record<string, { status: string; propertyId: string | null; propertyName: string | null; lastSyncAt: string | null; consecutiveErrors: number }> = {};
      for (const r of rows) {
        byDomain[r.tenantDomain] = {
          status: r.status,
          propertyId: r.propertyId,
          propertyName: r.propertyName,
          lastSyncAt: r.lastSyncAt ? r.lastSyncAt.toISOString() : null,
          consecutiveErrors: r.consecutiveErrors,
        };
      }
      res.json(byDomain);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== MANUAL ACTION QUOTAS (Global Admin Only) ====================

  // List manual action usage and bonuses for a tenant
  app.get("/api/admin/tenants/:tenantId/manual-action-usage", async (req, res) => {
    try {
      if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
      const me = await storage.getUser(req.session.userId);
      if (!me || me.role !== "Global Admin") {
        return res.status(403).json({ error: "Only Global Admins can view manual action usage" });
      }
      const tenant = await storage.getTenant(req.params.tenantId);
      if (!tenant) return res.status(404).json({ error: "Tenant not found" });
      const summary = await getManualActionUsageSummary(tenant.domain, tenant.plan);
      const actions: Record<string, typeof summary[number]> = {};
      for (const row of summary) actions[row.action] = row;
      res.json({
        tenantId: tenant.id,
        tenantDomain: tenant.domain,
        plan: tenant.plan,
        actions,
        catalog: MANUAL_ACTION_KEYS.map(k => ({ key: k, label: MANUAL_ACTION_LABELS[k] })),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Grant a bonus quota to a tenant for the current month
  app.post("/api/admin/tenants/:tenantId/manual-action-bonuses", async (req, res) => {
    try {
      if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
      const me = await storage.getUser(req.session.userId);
      if (!me || me.role !== "Global Admin") {
        return res.status(403).json({ error: "Only Global Admins can grant manual action bonuses" });
      }
      const tenant = await storage.getTenant(req.params.tenantId);
      if (!tenant) return res.status(404).json({ error: "Tenant not found" });
      const { action, delta, reason } = req.body || {};
      if (!action || !MANUAL_ACTION_KEYS.includes(action as ManualActionKey)) {
        return res.status(400).json({ error: "Invalid action" });
      }
      const deltaNum = Number(delta);
      if (!Number.isFinite(deltaNum) || deltaNum === 0) {
        return res.status(400).json({ error: "Delta must be a non-zero number" });
      }
      await grantManualActionBonus(tenant.domain, action as ManualActionKey, Math.trunc(deltaNum), me.id, reason);
      const summary = await getManualActionUsageSummary(tenant.domain, tenant.plan);
      const actions: Record<string, typeof summary[number]> = {};
      for (const row of summary) actions[row.action] = row;
      const history = await listManualActionBonuses(tenant.domain, 50);
      res.json({ ok: true, actions, history });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Audit log of bonus grants for a tenant
  app.get("/api/admin/tenants/:tenantId/manual-action-bonuses", async (req, res) => {
    try {
      if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
      const me = await storage.getUser(req.session.userId);
      if (!me || me.role !== "Global Admin") {
        return res.status(403).json({ error: "Only Global Admins can view manual action bonuses" });
      }
      const tenant = await storage.getTenant(req.params.tenantId);
      if (!tenant) return res.status(404).json({ error: "Tenant not found" });
      const history = await listManualActionBonuses(tenant.domain, 100);
      res.json({ history });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== GLOBAL GROUNDING DOCUMENTS ROUTES (Global Admin Only) ====================

  // Get all global grounding documents (Global Admin only)
  app.get("/api/admin/global-documents", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user || user.role !== "Global Admin") {
        return res.status(403).json({ error: "Only Global Admins can manage global documents" });
      }

      const documents = await storage.getAllGlobalGroundingDocuments();
      res.json(documents);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Extract text from uploaded file (authenticated users only)
  app.post("/api/documents/extract-text", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { fileUrl, fileType } = req.body;
      if (!fileUrl || !fileType) {
        return res.status(400).json({ error: "Missing required fields: fileUrl, fileType" });
      }

      const text = await documentExtractionService.extractTextFromDocument(fileUrl, fileType);
      res.json({ text });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Create global grounding document (Global Admin only)
  app.post("/api/admin/global-documents", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user || user.role !== "Global Admin") {
        return res.status(403).json({ error: "Only Global Admins can manage global documents" });
      }

      const { name, description, category, fileType, originalFileName, content } = req.body;

      // Validate required fields - content is now required
      if (!name || !category || !content) {
        return res.status(400).json({ error: "Missing required fields: name, category, content" });
      }

      // Validate category
      const validCategories = ["brand_voice", "marketing_guidelines", "digital_assets", "methodology"];
      if (!validCategories.includes(category)) {
        return res.status(400).json({ error: `Invalid category. Must be one of: ${validCategories.join(", ")}` });
      }

      const wordCount = content.split(/\s+/).filter(Boolean).length;

      const document = await storage.createGlobalGroundingDocument({
        name,
        description: description || null,
        category,
        fileType: fileType || "txt",
        originalFileName: originalFileName || `${name}.txt`,
        extractedText: content,
        wordCount,
        uploadedBy: user.id,
        isActive: true,
      });

      res.status(201).json(document);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Update global grounding document (Global Admin only)
  app.patch("/api/admin/global-documents/:id", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user || user.role !== "Global Admin") {
        return res.status(403).json({ error: "Only Global Admins can manage global documents" });
      }

      const document = await storage.getGlobalGroundingDocument(req.params.id);
      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      const { name, description, category, isActive } = req.body;

      // Validate category if provided
      if (category) {
        const validCategories = ["brand_voice", "marketing_guidelines", "digital_assets", "methodology"];
        if (!validCategories.includes(category)) {
          return res.status(400).json({ error: `Invalid category. Must be one of: ${validCategories.join(", ")}` });
        }
      }

      const updatedDocument = await storage.updateGlobalGroundingDocument(req.params.id, {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(category !== undefined && { category }),
        ...(isActive !== undefined && { isActive }),
      });

      res.json(updatedDocument);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Delete global grounding document (Global Admin only)
  app.delete("/api/admin/global-documents/:id", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user || user.role !== "Global Admin") {
        return res.status(403).json({ error: "Only Global Admins can manage global documents" });
      }

      const document = await storage.getGlobalGroundingDocument(req.params.id);
      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      await storage.deleteGlobalGroundingDocument(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get active global documents for AI context (internal use, any authenticated user)
  app.get("/api/global-documents/context", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const documents = await storage.getActiveGlobalGroundingDocuments();
      
      // Group by category for organized context
      const contextByCategory: Record<string, string[]> = {};
      for (const doc of documents) {
        if (!contextByCategory[doc.category]) {
          contextByCategory[doc.category] = [];
        }
        contextByCategory[doc.category].push(`[${doc.name}]\n${doc.extractedText}`);
      }

      res.json({
        totalDocuments: documents.length,
        categories: Object.keys(contextByCategory),
        context: contextByCategory,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== COMPANY PROFILE ROUTES (Baseline Own Website) ====================

  // Fetch company info from a domain for onboarding pre-population
  app.get("/api/company-info/from-domain", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const tenantDomain = user.email.split("@")[1];
      const websiteUrl = `https://www.${tenantDomain}`;

      // Try to fetch homepage and extract company info
      try {
        const response = await fetch(websiteUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; OrbitBot/1.0)" },
          redirect: "follow",
        });

        if (!response.ok) {
          return res.json({
            domain: tenantDomain,
            websiteUrl,
            companyName: tenantDomain.split(".")[0].charAt(0).toUpperCase() + tenantDomain.split(".")[0].slice(1),
            description: "",
            fetchSuccess: false,
          });
        }

        const html = await response.text();

        // Extract title for company name
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        let companyName = titleMatch ? titleMatch[1].trim() : "";
        
        // Clean up title - remove common suffixes
        companyName = companyName
          .replace(/\s*[-|–—]\s*.*(home|homepage|welcome|official site|official website).*/i, "")
          .replace(/\s*[-|–—]\s*$/i, "")
          .trim();
        
        // If title is too long or empty, try OG title or default to domain
        if (!companyName || companyName.length > 50) {
          const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
                               html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
          if (ogTitleMatch) {
            companyName = ogTitleMatch[1].trim();
          } else {
            companyName = tenantDomain.split(".")[0].charAt(0).toUpperCase() + tenantDomain.split(".")[0].slice(1);
          }
        }

        // Extract meta description
        const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                          html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
        let description = descMatch ? descMatch[1].trim() : "";

        // Try OG description if meta description is empty
        if (!description) {
          const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ||
                              html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i);
          if (ogDescMatch) {
            description = ogDescMatch[1].trim();
          }
        }

        // Extract social links
        const linkedInMatch = html.match(/href=["'](https?:\/\/(www\.)?linkedin\.com\/company\/[^"']+)["']/i);
        const instagramMatch = html.match(/href=["'](https?:\/\/(www\.)?instagram\.com\/[^"']+)["']/i);

        res.json({
          domain: tenantDomain,
          websiteUrl: response.url || websiteUrl,
          companyName,
          description,
          linkedInUrl: linkedInMatch ? linkedInMatch[1] : null,
          instagramUrl: instagramMatch ? instagramMatch[1] : null,
          fetchSuccess: true,
        });
      } catch (fetchError) {
        // Website not reachable - return basic info
        res.json({
          domain: tenantDomain,
          websiteUrl,
          companyName: tenantDomain.split(".")[0].charAt(0).toUpperCase() + tenantDomain.split(".")[0].slice(1),
          description: "",
          fetchSuccess: false,
        });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get company profile for current tenant
  app.get("/api/company-profile", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const profile = await storage.getCompanyProfileByContext(toContextFilter(ctx));
      res.json(profile || null);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Get baseline Orbit Score (company profile score)
  app.get("/api/company-profile/score", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const profile = await storage.getCompanyProfileByContext(toContextFilter(ctx));
      
      if (!profile) {
        return res.json({ hasScore: false, score: null });
      }
      
      // Calculate baseline score
      const scoreBreakdown = calculateBaselineScore({
        description: profile.description,
        crawlData: profile.crawlData as any,
        blogSnapshot: profile.blogSnapshot as any,
        linkedInEngagement: profile.linkedInEngagement as any,
        instagramEngagement: profile.instagramEngagement as any,
        lastCrawl: profile.lastCrawl,
        analysisData: profile.analysisData as any,
      });
      
      // Get previous score for trend
      const previousScore = await storage.getLatestScoreForEntity("baseline", profile.id);
      const trend = previousScore 
        ? {
            previousScore: previousScore.overallScore,
            delta: Math.round((scoreBreakdown.overallScore - previousScore.overallScore) * 100) / 100,
            direction: scoreBreakdown.overallScore > previousScore.overallScore ? "up" : 
                       scoreBreakdown.overallScore < previousScore.overallScore ? "down" : "stable"
          }
        : null;
      
      res.json({
        hasScore: true,
        score: scoreBreakdown,
        trend,
        companyName: profile.companyName,
      });
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Record baseline score to history (called after analysis/crawl)
  app.post("/api/company-profile/score/record", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const profile = await storage.getCompanyProfileByContext(toContextFilter(ctx));
      
      if (!profile) {
        return res.status(404).json({ error: "Company profile not found" });
      }
      
      const scoreBreakdown = calculateBaselineScore({
        description: profile.description,
        crawlData: profile.crawlData as any,
        blogSnapshot: profile.blogSnapshot as any,
        linkedInEngagement: profile.linkedInEngagement as any,
        instagramEngagement: profile.instagramEngagement as any,
        lastCrawl: profile.lastCrawl,
        analysisData: profile.analysisData as any,
      });
      
      const period = getCurrentWeeklyPeriod();
      
      // Check if we already have a record for this period
      const existingHistory = await storage.getScoreHistory("baseline", profile.id, 1);
      if (existingHistory.length > 0 && existingHistory[0].period === period) {
        return res.json({ recorded: false, message: "Score already recorded for this period", score: scoreBreakdown });
      }
      
      // Record to history
      await storage.createScoreHistory({
        entityType: "baseline",
        entityId: profile.id,
        entityName: profile.companyName,
        tenantDomain: ctx.tenantDomain,
        marketId: ctx.marketId,
        overallScore: Math.round(scoreBreakdown.overallScore),
        innovationScore: Math.round(scoreBreakdown.innovationScore),
        marketPresenceScore: Math.round(scoreBreakdown.marketPresenceScore),
        contentActivityScore: Math.round(scoreBreakdown.contentActivityScore),
        socialEngagementScore: Math.round(scoreBreakdown.socialEngagementScore),
        scoreBreakdown: scoreBreakdown,
        period,
      });
      
      res.json({ recorded: true, score: scoreBreakdown, period });
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Get score history for an entity (baseline or competitor)
  app.get("/api/score-history/:entityType/:entityId", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const { entityType, entityId } = req.params;
      const limit = parseInt(req.query.limit as string) || 12;
      
      if (!["baseline", "competitor"].includes(entityType)) {
        return res.status(400).json({ error: "Invalid entity type. Must be 'baseline' or 'competitor'" });
      }
      
      const history = await storage.getScoreHistory(entityType, entityId, limit);
      res.json(history);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Get all score history for current market context
  app.get("/api/score-history", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const entityType = req.query.entityType as string | undefined;
      const limit = parseInt(req.query.limit as string) || 50;
      
      const history = await storage.getScoreHistoryByContext(toContextFilter(ctx), entityType, limit);
      res.json(history);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Baseline company tone & sentiment summary
  app.get("/api/company-profile/tone", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const profile = await storage.getCompanyProfileByContext(toContextFilter(ctx));
      if (!profile) return res.status(404).json({ error: "No company profile found" });
      if (!await guardFeature(req, res, "sentimentAnalysis")) return;

      const sinceParam = req.query.sinceDays ? parseInt(String(req.query.sinceDays), 10) : 90;
      const sinceDays = Number.isFinite(sinceParam) && sinceParam > 0 ? Math.min(sinceParam, 365) : 90;

      const { getBaselineToneSummary } = await import("../services/sentiment-context");
      const summary = await getBaselineToneSummary(profile.id, sinceDays);
      res.json({ companyProfileId: profile.id, sinceDays, ...summary });
    } catch (error: any) {
      if (error instanceof ContextError) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // Baseline company pricing snapshots
  app.get("/api/company-profile/pricing", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const profile = await storage.getCompanyProfileByContext(toContextFilter(ctx));
      if (!profile) return res.status(404).json({ error: "No company profile found" });
      if (!await guardFeature(req, res, "pricingIntelligence")) return;

      const limitRaw = req.query.limit;
      const limit = typeof limitRaw === "string" ? Math.min(Math.max(parseInt(limitRaw, 10) || 50, 1), 200) : 50;
      const snapshots = await storage.getPricingSnapshotsForCompanyProfile(profile.id, limit);
      const lite = snapshots.map(({ rawContent, ...rest }) => rest);

      return res.json({
        pricingPageUrl: profile.pricingPageUrl || null,
        latestSnapshotAt: lite[0]?.capturedAt || null,
        latest: lite[0] || null,
        snapshots: lite,
      });
    } catch (error: any) {
      if (error instanceof ContextError) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // Update baseline company pricing URL
  // POST /api/company-profile/reset-website-baseline — clears the stored
  // website snapshot so the next monitor run treats the current page as the
  // new baseline (no diff alert will fire until content changes again).
  app.post("/api/company-profile/reset-website-baseline", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      if (!hasAdminAccess(ctx.userRole)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const profile = await storage.getCompanyProfileByContext(toContextFilter(ctx));
      if (!profile) return res.status(404).json({ error: "No company profile found" });
      await storage.updateCompanyProfile(profile.id, {
        previousWebsiteContent: null as any,
        lastWebsiteMonitor: new Date(),
      });
      // Also clear any existing website-change alerts for this profile so a
      // false "content removal" card disappears from the feed immediately.
      // This covers BOTH the baseline site (by companyProfileId) AND the tenant's
      // own product/offering pages (sourceType='product', no companyProfileId) —
      // the latter are what wrongly drove the "abandoning AI" narrative.
      const clearedBaselineAlerts = await storage.deleteWebsiteChangeActivitiesByCompanyProfile(profile.id);
      const clearedProductAlerts = await storage.deleteOwnProductWebsiteChangeActivities(
        ctx.tenantDomain,
        ctx.marketId || undefined,
        ctx.isDefaultMarket,
      );
      const clearedAlerts = clearedBaselineAlerts + clearedProductAlerts;

      // Also clear the stored website snapshot on all own products so their
      // NEXT scheduled crawl sets a fresh baseline. Without this, a product like
      // "Zenith" that still has an old multi-page snapshot keeps producing
      // "99% change" false alerts on every crawl, even after the signals are purged.
      const resetProducts = await storage.resetProductWebsiteBaselines(profile.id).catch((err: any) => {
        console.warn("[reset-website-baseline] Product baseline reset failed:", err?.message);
        return 0;
      });

      // Regenerate the stored intelligence briefing now so the false narrative
      // disappears immediately instead of lingering until the next scheduled run.
      // The prior briefing was synthesized from the now-purged signals, so it
      // keeps showing the stale risk alert until a fresh one replaces it.
      let regeneratedBriefingId: string | null = null;
      try {
        const now = new Date();
        const periodDays = 7;
        const periodStart = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);
        const placeholder = await storage.createIntelligenceBriefing({
          tenantDomain: ctx.tenantDomain,
          marketId: ctx.marketId,
          periodStart,
          periodEnd: now,
          status: "generating",
          briefingData: null,
          signalCount: 0,
          competitorCount: 0,
        });
        regeneratedBriefingId = placeholder.id;

        const capturedCtx = { ...ctx };
        const capturedFilter = toContextFilter(ctx);
        (async () => {
          try {
            const { generateBriefingData } = await import("../services/intelligence-briefing-service");
            const result = await generateBriefingData(
              capturedCtx.tenantDomain,
              periodDays,
              capturedCtx.marketId,
              capturedFilter,
            );
            await storage.updateIntelligenceBriefing(placeholder.id, {
              status: "published",
              briefingData: result.briefingData,
              signalCount: result.signalCount,
              competitorCount: result.competitorCount,
            });
          } catch (genErr: any) {
            console.error("[reset-website-baseline] Briefing regeneration failed:", genErr?.message);
            await storage.updateIntelligenceBriefing(placeholder.id, {
              status: "failed",
              briefingData: { error: genErr?.message },
            }).catch(() => {});
          }
        })();
      } catch (regenErr: any) {
        console.warn("[reset-website-baseline] Could not start briefing regeneration:", regenErr?.message);
      }

      res.json({ success: true, clearedAlerts, clearedBaselineAlerts, clearedProductAlerts, resetProducts, regeneratedBriefingId });
    } catch (error: any) {
      if (error instanceof ContextError) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/company-profile/pricing-url", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const profile = await storage.getCompanyProfileByContext(toContextFilter(ctx));
      if (!profile) return res.status(404).json({ error: "No company profile found" });
      if (!await guardFeature(req, res, "pricingIntelligence")) return;

      const raw = req.body?.pricingPageUrl?.trim() || null;
      if (raw) {
        const validation = await validateCompetitorUrl(raw);
        if (!validation.isValid) {
          return res.status(400).json({ error: validation.error || "Invalid pricing page URL" });
        }
      }
      const updated = await storage.updateCompanyProfile(profile.id, { pricingPageUrl: raw });
      return res.json({ id: updated.id, pricingPageUrl: updated.pricingPageUrl });
    } catch (error: any) {
      if (error instanceof ContextError) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // Trigger a fresh baseline pricing snapshot
  app.post("/api/company-profile/pricing/refresh", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const profile = await storage.getCompanyProfileByContext(toContextFilter(ctx));
      if (!profile) return res.status(404).json({ error: "No company profile found" });
      if (!await guardFeature(req, res, "pricingIntelligence")) return;
      if (!await guardManualAction(req, res, "pricingRefresh")) return;
      if (!profile.pricingPageUrl) {
        return res.status(400).json({
          error: "No pricing page URL configured for your company",
          code: "no_pricing_url",
        });
      }

      const { monitorBaselinePricing } = await import("../services/pricing-intelligence");
      const result = await monitorBaselinePricing(profile.id, {
        userId: req.session.userId,
        tenantDomain: ctx.tenantDomain,
      });

      return res.json(result);
    } catch (error: any) {
      if (error instanceof ContextError) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // Get products owned by the baseline company profile
  app.get("/api/company-profile/products", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const profile = await storage.getCompanyProfileByContext(toContextFilter(ctx));
      if (!profile) {
        return res.json([]);
      }
      const companyProducts = await storage.getProductsByCompanyProfile(profile.id);
      res.json(companyProducts);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Create or update company profile
  app.post("/api/company-profile", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      
      // Validate input
      const parsed = insertCompanyProfileSchema.safeParse({
        ...req.body,
        userId: ctx.userId,
        tenantDomain: ctx.tenantDomain,
        marketId: ctx.marketId,
      });
      
      if (!parsed.success) {
        return res.status(400).json({ error: fromError(parsed.error).toString() });
      }

      const { companyName, websiteUrl, description, linkedInUrl, instagramUrl, twitterUrl, blogUrl, logoUrl,
              headquarters, founded, employeeCount, industry, revenue, fundingRaised } = parsed.data as any;
      
      // Validate websiteUrl for security (SSRF protection)
      const urlValidation = await validateCompetitorUrl(websiteUrl);
      if (!urlValidation.isValid) {
        return res.status(400).json({ error: urlValidation.error });
      }
      const validatedWebsiteUrl = urlValidation.normalizedUrl!;
      
      // Validate blogUrl for security (SSRF protection) if provided
      let validatedBlogUrl: string | null = null;
      if (blogUrl) {
        const blogUrlValidation = await validateBlogUrl(blogUrl);
        if (!blogUrlValidation.isValid) {
          return res.status(400).json({ error: `Blog URL: ${blogUrlValidation.error}` });
        }
        validatedBlogUrl = blogUrlValidation.normalizedUrl!;
      }
      
      // Plan-gating: Trial/Free plans can only baseline their own domain
      const tenant = await storage.getTenantByDomain(ctx.tenantDomain);
      if (tenant && (tenant.plan === "trial" || tenant.plan === "free")) {
        try {
          const websiteDomain = new URL(validatedWebsiteUrl).hostname.replace(/^www\./, "").toLowerCase();
          if (websiteDomain !== ctx.tenantDomain.toLowerCase()) {
            return res.status(403).json({ 
              error: `Your ${tenant.plan} plan only allows analyzing your own company website (${ctx.tenantDomain}). Upgrade to Pro or Enterprise to analyze other companies.`,
              upgradeRequired: true
            });
          }
        } catch {
          return res.status(400).json({ error: "Invalid website URL" });
        }
      }

      const org = await storage.findOrCreateOrganization(validatedWebsiteUrl, companyName, {
        linkedInUrl: linkedInUrl || undefined,
        instagramUrl: instagramUrl || undefined,
        twitterUrl: twitterUrl || undefined,
        blogUrl: validatedBlogUrl || undefined,
        headquarters: headquarters || undefined,
        founded: founded || undefined,
        employeeCount: employeeCount || undefined,
        industry: industry || undefined,
        revenue: revenue || undefined,
        fundingRaised: fundingRaised || undefined,
      });

      const existingProfile = await storage.getCompanyProfileByContext(toContextFilter(ctx));

      if (existingProfile) {
        const oldOrgId = existingProfile.organizationId;
        const updated = await storage.updateCompanyProfile(existingProfile.id, {
          companyName,
          websiteUrl: validatedWebsiteUrl,
          logoUrl: logoUrl || null,
          linkedInUrl: linkedInUrl || null,
          instagramUrl: instagramUrl || null,
          twitterUrl: twitterUrl || null,
          blogUrl: validatedBlogUrl,
          description,
          headquarters: headquarters || null,
          founded: founded || null,
          employeeCount: employeeCount || null,
          industry: industry || null,
          revenue: revenue || null,
          fundingRaised: fundingRaised || null,
          organizationId: org.id,
        });
        if (oldOrgId !== org.id) {
          if (oldOrgId) {
            await storage.decrementOrgRefCount(oldOrgId);
          }
          await storage.incrementOrgRefCount(org.id);
        }
        res.json(updated);
      } else {
        const profile = await storage.createCompanyProfile({
          userId: ctx.userId,
          tenantDomain: ctx.tenantDomain,
          marketId: ctx.marketId,
          organizationId: org.id,
          companyName,
          websiteUrl: validatedWebsiteUrl,
          logoUrl: logoUrl || null,
          linkedInUrl: linkedInUrl || null,
          instagramUrl: instagramUrl || null,
          twitterUrl: twitterUrl || null,
          blogUrl: validatedBlogUrl,
          description,
          headquarters: headquarters || null,
          founded: founded || null,
          employeeCount: employeeCount || null,
          industry: industry || null,
          revenue: revenue || null,
          fundingRaised: fundingRaised || null,
        });
        await storage.incrementOrgRefCount(org.id);
        res.json(profile);
      }
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Analyze company website (baseline) - uses robust web crawler like competitors
  app.post("/api/company-profile/analyze", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const profile = await storage.getCompanyProfileByContext(toContextFilter(ctx));

      if (!profile) {
        return res.status(404).json({ error: "Company profile not found. Please set up your company profile first." });
      }

      return res.status(503).json({ error: "Website crawl analysis is no longer available in Observatory." });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Delete company profile
  app.delete("/api/company-profile", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const profile = await storage.getCompanyProfileByContext(toContextFilter(ctx));

      if (!profile) {
        return res.status(404).json({ error: "Company profile not found" });
      }

      const orgId = profile.organizationId;
      await storage.deleteCompanyProfile(profile.id);
      if (orgId) {
        await storage.decrementOrgRefCount(orgId);
      }
      res.json({ success: true });
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Save manual AI research for company profile (when crawl fails)
  app.post("/api/company-profile/manual-research", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const profile = await storage.getCompanyProfileByContext(toContextFilter(ctx));
      
      if (!profile) {
        return res.status(404).json({ error: "Company profile not found" });
      }

      const { researchContent } = req.body;
      if (!researchContent || researchContent.trim().length < 100) {
        return res.status(400).json({ error: "Research content is required (minimum 100 characters)" });
      }

      // Parse the manual research content into structured data
      const analysisData = parseManualResearch(researchContent, profile.companyName);
      
      // Mark as manual source to protect from crawl overwrites
      analysisData.source = "manual";
      analysisData.manualResearchDate = new Date().toISOString();

      await storage.updateCompanyProfile(profile.id, {
        analysisData,
        lastAnalysis: new Date(),
      });
      
      // Create activity entry
      await storage.createActivity({
        type: "manual_research",
        sourceType: "baseline",
        companyProfileId: profile.id,
        competitorName: profile.companyName,
        description: `Manual AI research saved for baseline: ${analysisData.summary?.substring(0, 100) || "Company intelligence gathered"}...`,
        date: new Date().toLocaleString(),
        impact: "Medium",
        tenantDomain: ctx.tenantDomain,
        marketId: ctx.marketId,
      });

      res.json({ success: true, analysisData });
    } catch (error: any) {
      console.error("Manual research save error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/company-profile/ai-research", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const profile = await storage.getCompanyProfileByContext(toContextFilter(ctx));

      if (!profile) {
        return res.status(404).json({ error: "Company profile not found" });
      }

      const { preview } = req.query;
      // Preview-only flow doesn't persist anything; don't charge quota for it.
      if (preview !== "true") {
        if (!await guardManualAction(req, res, "aiResearch")) return;
      }
      const research = await aiCompanyResearch(profile.companyName, profile.websiteUrl);

      const fieldsToPopulate: Record<string, string | null> = {};
      if (!profile.headquarters && research.headquarters) fieldsToPopulate.headquarters = research.headquarters;
      if (!profile.founded && research.foundedYear) fieldsToPopulate.founded = research.foundedYear;
      if (!profile.employeeCount && research.employeeCount) fieldsToPopulate.employeeCount = research.employeeCount;
      if (!profile.revenue && research.revenueRange) fieldsToPopulate.revenue = research.revenueRange;
      if (!profile.fundingRaised && research.fundingRaised) fieldsToPopulate.fundingRaised = research.fundingRaised;
      if (!profile.industry && research.industry) fieldsToPopulate.industry = research.industry;
      if (!profile.linkedInUrl && research.linkedInUrl) fieldsToPopulate.linkedInUrl = research.linkedInUrl;
      if (!profile.blogUrl && research.blogUrl) fieldsToPopulate.blogUrl = research.blogUrl;
      if (!profile.description && research.description) fieldsToPopulate.description = research.description;

      if (preview === "true") {
        return res.json({ preview: true, research, fieldsToPopulate });
      }

      if (Object.keys(fieldsToPopulate).length > 0) {
        await storage.updateCompanyProfile(profile.id, fieldsToPopulate);
      }

      await storage.createActivity({
        type: "ai_research",
        sourceType: "baseline",
        companyProfileId: profile.id,
        competitorName: profile.companyName,
        description: `AI Company Research completed: ${Object.keys(fieldsToPopulate).length} fields enriched`,
        date: new Date().toLocaleString(),
        impact: "Medium",
        tenantDomain: ctx.tenantDomain,
        marketId: ctx.marketId,
      });

      res.json({ success: true, fieldsPopulated: Object.keys(fieldsToPopulate), research });
    } catch (error: any) {
      console.error("AI research error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Upload company logo
  app.post("/api/upload/logo", async (req, res) => {
    try {
      // Verify context to enforce tenant security
      const ctx = await getRequestContext(req);
      
      const files = req.files;
      if (!files || !files.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const file = files.file as UploadedFile;
      
      // Validate file using comprehensive security validator
      const { validateImageUpload } = await import("../utils/file-validator");
      const fileValidation = validateImageUpload(file);
      if (!fileValidation.isValid) {
        return res.status(400).json({ error: fileValidation.error });
      }

      const BUCKET_ID = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
      if (!BUCKET_ID) {
        return res.status(500).json({ error: "Object storage not configured" });
      }

      // Generate unique filename with tenant context for organization
      const ext = file.name.split('.').pop() || 'png';
      const tenantSlug = ctx.tenantDomain.replace(/[^a-z0-9]/gi, '-');
      const filename = `${tenantSlug}-logo-${randomUUID()}.${ext}`;
      
      // Upload to object storage
      const bucket = objectStorageClient.bucket(BUCKET_ID);
      const gcsFile = bucket.file(`public/logos/${filename}`);
      
      await gcsFile.save(file.data, {
        contentType: file.mimetype,
      });

      const url = `https://storage.googleapis.com/${BUCKET_ID}/public/logos/${filename}`;
      res.json({ url });
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error("Logo upload error:", error);
      res.status(500).json({ error: "Failed to upload logo" });
    }
  });

  // ==================== ASSESSMENT ROUTES (Snapshots & Proxy) ====================

  // Get all assessments for current tenant
  app.get("/api/assessments", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const assessments = await storage.getAssessmentsByContext(toContextFilter(ctx));
      res.json(assessments);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Get single assessment
  app.get("/api/assessments/:id", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);

      const assessment = await storage.getAssessment(req.params.id);
      if (!assessment) {
        return res.status(404).json({ error: "Assessment not found" });
      }

      // Validate assessment belongs to current context
      if (!validateResourceContext(assessment, ctx)) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json(assessment);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Create new assessment (snapshot current state)
  app.post("/api/assessments", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      
      // Gather current state for snapshot (context-scoped)
      const competitors = await storage.getCompetitorsByContext(toContextFilter(ctx));
      // Note: Analysis and recommendations tables are not yet tenant-scoped
      // Capturing empty objects/arrays until these are refactored for multi-tenancy
      // to prevent cross-tenant data leakage
      const latestAnalysis = { themes: [], messaging: [], gaps: [] };
      const recommendations: any[] = [];
      const companyProfile = await storage.getCompanyProfileByContext(toContextFilter(ctx));

      // Validate input with proxy fields
      const parsed = insertAssessmentSchema.safeParse({
        name: req.body.name,
        description: req.body.description,
        userId: ctx.userId,
        tenantDomain: ctx.tenantDomain,
        marketId: ctx.marketId,
        companyProfileSnapshot: companyProfile || null,
        competitorsSnapshot: competitors,
        analysisSnapshot: latestAnalysis || {},
        recommendationsSnapshot: recommendations,
        isProxy: req.body.isProxy || false,
        proxyName: req.body.proxyName,
        proxyCompany: req.body.proxyCompany,
        proxyJobTitle: req.body.proxyJobTitle,
        proxyIndustry: req.body.proxyIndustry,
        proxyCompanySize: req.body.proxyCompanySize,
        proxyCountry: req.body.proxyCountry,
      });

      if (!parsed.success) {
        return res.status(400).json({ error: fromError(parsed.error).toString() });
      }

      // Only admins can create proxy assessments
      const user = await storage.getUser(ctx.userId);
      if (parsed.data.isProxy && user?.role === "Standard User") {
        return res.status(403).json({ error: "Only admins can create proxy assessments" });
      }

      const assessment = await storage.createAssessment(parsed.data);
      res.json(assessment);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Update assessment
  app.put("/api/assessments/:id", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);

      const assessment = await storage.getAssessment(req.params.id);
      if (!assessment) {
        return res.status(404).json({ error: "Assessment not found" });
      }

      // Validate assessment belongs to current context
      if (!validateResourceContext(assessment, ctx)) {
        return res.status(403).json({ error: "Access denied" });
      }

      const updated = await storage.updateAssessment(req.params.id, {
        name: req.body.name,
        description: req.body.description,
      });
      res.json(updated);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Delete assessment
  app.delete("/api/assessments/:id", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);

      const assessment = await storage.getAssessment(req.params.id);
      if (!assessment) {
        return res.status(404).json({ error: "Assessment not found" });
      }

      // Validate assessment belongs to current context
      if (!validateResourceContext(assessment, ctx)) {
        return res.status(403).json({ error: "Access denied" });
      }

      await storage.deleteAssessment(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Compare two assessments
  app.get("/api/assessments/compare/:id1/:id2", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const tenantDomain = user.email.split("@")[1];

      const assessment1 = await storage.getAssessment(req.params.id1);
      const assessment2 = await storage.getAssessment(req.params.id2);

      if (!assessment1 || !assessment2) {
        return res.status(404).json({ error: "One or both assessments not found" });
      }

      if (assessment1.tenantDomain !== tenantDomain || assessment2.tenantDomain !== tenantDomain) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json({
        assessment1,
        assessment2,
        comparison: {
          timeDiff: new Date(assessment2.createdAt).getTime() - new Date(assessment1.createdAt).getTime(),
          competitorCountChange: (assessment2.competitorsSnapshot as any[]).length - (assessment1.competitorsSnapshot as any[]).length,
        }
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== TENANT MANAGEMENT ROUTES (Global Admin Only) ====================

  app.get("/api/tenants", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user || user.role !== "Global Admin") {
        return res.status(403).json({ error: "Access denied - Global Admin only" });
      }

      const tenantsWithCounts = await storage.getTenantsWithUserCounts();
      res.json(tenantsWithCounts);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Create a new tenant (Global Admin only)
  app.post("/api/tenants", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user || user.role !== "Global Admin") {
        return res.status(403).json({ error: "Access denied - Global Admin only" });
      }

      const { 
        domain, name, plan, status, 
        competitorLimit, analysisLimit, 
        adminUserLimit, readWriteUserLimit, readOnlyUserLimit,
        primaryColor, secondaryColor 
      } = req.body;

      if (!domain || typeof domain !== "string" || !domain.includes(".")) {
        return res.status(400).json({ error: "Valid domain is required (e.g., company.com)" });
      }
      
      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "Company name is required" });
      }

      const normalizedDomain = domain.toLowerCase().trim();
      
      // Check if tenant already exists
      const existingTenant = await storage.getTenantByDomain(normalizedDomain);
      if (existingTenant) {
        return res.status(400).json({ error: "Tenant with this domain already exists" });
      }

      const effectivePlan = plan || "trial";
      const trialDates = effectivePlan === "trial" ? {
        trialStartDate: new Date(),
        trialEndsAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      } : {};
      
      const newTenant = await storage.createTenant({
        domain: normalizedDomain,
        name: name.trim(),
        plan: effectivePlan,
        status: status || "active",
        ...trialDates,
        userCount: 0,
        competitorLimit: competitorLimit ?? 3,
        analysisLimit: analysisLimit ?? 5,
        adminUserLimit: adminUserLimit ?? 1,
        readWriteUserLimit: readWriteUserLimit ?? 2,
        readOnlyUserLimit: readOnlyUserLimit ?? 5,
        primaryColor: primaryColor || "#810FFB",
        secondaryColor: secondaryColor || "#E60CB3",
      });

      res.status(201).json(newTenant);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get accessible tenants for current user (for tenant switcher)
  // IMPORTANT: Must be defined BEFORE /api/tenants/:id to avoid matching "accessible" as an ID
  app.get("/api/tenants/accessible", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      const userDomain = user.email.split("@")[1];
      const userTenant = await storage.getTenantByDomain(userDomain);
      
      if (!userTenant) {
        return res.status(404).json({ error: "No tenant found for your organization. Please contact your administrator." });
      }
      
      const accessibleTenants = await storage.getAccessibleTenants(user.id, user.role, userDomain);

      // Only echo header-supplied tenant id if the user actually has access to
      // it; otherwise fall back to their own tenant so a forged header can't
      // confuse the client into showing an unauthorized active context.
      const headerTenantId = getActiveTenantId(req);
      const echoedTenantId = headerTenantId && accessibleTenants.find(t => t.id === headerTenantId)
        ? headerTenantId
        : userTenant.id;
      const headerMarketId = getActiveMarketId(req);
      const marketBelongs = headerMarketId
        ? await storage.validateMarketBelongsToTenant(headerMarketId, echoedTenantId)
        : false;

      res.json({
        tenants: accessibleTenants,
        activeTenantId: echoedTenantId,
        activeMarketId: marketBelongs ? headerMarketId : null,
        canSwitchTenants: user.role === "Global Admin" || user.role === "Consultant"
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/tenants/:id", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user || user.role !== "Global Admin") {
        return res.status(403).json({ error: "Access denied - Global Admin only" });
      }

      const tenant = await storage.getTenant(req.params.id);
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      const users = await storage.getUsersByDomain(tenant.domain);
      res.json({ ...tenant, users });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/tenants/:id", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user || user.role !== "Global Admin") {
        return res.status(403).json({ error: "Access denied - Global Admin only" });
      }

      const validStatuses = ["active", "suspended", "inactive"];
      const hexColorRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
      
      const { domain, plan, status, name, logoUrl, faviconUrl, primaryColor, secondaryColor, billingManagedManually, publicRateLimitPerMinute } = req.body;
      const updateData: { domain?: string; plan?: string; status?: string; competitorLimit?: number; analysisLimit?: number; adminUserLimit?: number; readWriteUserLimit?: number; readOnlyUserLimit?: number; multiMarketEnabled?: boolean; marketLimit?: number | null; name?: string; logoUrl?: string | null; faviconUrl?: string | null; primaryColor?: string; secondaryColor?: string; billingManagedManually?: boolean; publicRateLimitPerMinute?: number | null } = {};
      // Per-tenant override for public/anonymous endpoint rate limits (rpm).
      // null clears the override and reverts to platform default.
      if (publicRateLimitPerMinute === null) {
        updateData.publicRateLimitPerMinute = null;
      } else if (typeof publicRateLimitPerMinute === "number" && Number.isInteger(publicRateLimitPerMinute) && publicRateLimitPerMinute > 0 && publicRateLimitPerMinute <= PUBLIC_TENANT_RATE_LIMIT_MAX) {
        updateData.publicRateLimitPerMinute = publicRateLimitPerMinute;
      }
      // Global Admin manual billing override — when true, Stripe webhook plan sync is skipped.
      if (typeof billingManagedManually === "boolean") updateData.billingManagedManually = billingManagedManually;
      
      if (domain && typeof domain === "string" && domain.includes(".")) {
        // Check if domain is already taken by another tenant
        const existingTenant = await storage.getTenantByDomain(domain.toLowerCase());
        if (existingTenant && existingTenant.id !== req.params.id) {
          return res.status(400).json({ error: "Domain is already used by another tenant" });
        }
        updateData.domain = domain.toLowerCase();
      }
      
      // Just update the plan name - limits come from service plan at runtime
      if (plan && typeof plan === "string") {
        const servicePlan = await storage.getServicePlanByName(plan);
        if (servicePlan) {
          updateData.plan = plan;
        }
      }
      
      if (status && validStatuses.includes(status)) updateData.status = status;
      if (name && typeof name === "string" && name.trim()) updateData.name = name.trim();
      if (logoUrl !== undefined) updateData.logoUrl = logoUrl || null;
      if (faviconUrl !== undefined) updateData.faviconUrl = faviconUrl || null;
      if (primaryColor && hexColorRegex.test(primaryColor)) updateData.primaryColor = primaryColor;
      if (secondaryColor && hexColorRegex.test(secondaryColor)) updateData.secondaryColor = secondaryColor;

      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ error: "No valid fields to update" });
      }

      // Capture pre-update state to detect billing-related changes for audit log
      const before = await storage.getTenant(req.params.id);

      const updated = await storage.updateTenant(req.params.id, updateData);

      // Audit log: write a billing_events row whenever a Global Admin flips
      // the manual-billing flag or changes the pinned plan while the flag is on.
      // Emit a separate event for each change so combined updates are fully audited.
      try {
        const flagChanged =
          typeof updateData.billingManagedManually === "boolean" &&
          before?.billingManagedManually !== updateData.billingManagedManually;
        const planChanged =
          typeof updateData.plan === "string" && before?.plan !== updateData.plan;
        const wasOrIsManual =
          (before?.billingManagedManually ?? false) ||
          updateData.billingManagedManually === true;

        const auditEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
        const actor = { actorUserId: user.id, actorEmail: user.email };

        if (flagChanged) {
          auditEvents.push({
            type: "admin.billing_managed_manually_changed",
            payload: {
              ...actor,
              before: { billingManagedManually: before?.billingManagedManually ?? null },
              after: { billingManagedManually: updateData.billingManagedManually },
            },
          });
        }
        if (planChanged && wasOrIsManual) {
          auditEvents.push({
            type: "admin.pinned_plan_changed",
            payload: {
              ...actor,
              before: { plan: before?.plan ?? null },
              after: { plan: updateData.plan },
            },
          });
        }

        if (auditEvents.length > 0) {
          const { db } = await import("../db");
          const { billingEvents } = await import("@shared/schema");
          for (const evt of auditEvents) {
            await db
              .insert(billingEvents)
              .values({
                id: `admin_${randomUUID()}`,
                type: evt.type,
                tenantId: req.params.id,
                stripeCustomerId: null,
                stripeSubscriptionId: null,
                payload: evt.payload,
              })
              .onConflictDoNothing();
          }
        }
      } catch (auditErr) {
        console.error("[Admin] Failed to write billing audit event:", auditErr);
      }

      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Delete a tenant (Global Admin only)
  app.delete("/api/tenants/:id", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user || user.role !== "Global Admin") {
        return res.status(403).json({ error: "Access denied - Global Admin only" });
      }

      const tenant = await storage.getTenant(req.params.id);
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      // Prevent deleting the tenant the current user belongs to
      const userDomain = user.email.split("@")[1]?.toLowerCase();
      if (tenant.domain.toLowerCase() === userDomain) {
        return res.status(400).json({ error: "Cannot delete your own tenant" });
      }

      await storage.deleteTenant(req.params.id);
      res.json({ success: true, message: "Tenant deleted successfully" });
    } catch (error: any) {
      console.error("Error deleting tenant:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/tenants/:id/users", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user || user.role !== "Global Admin") {
        return res.status(403).json({ error: "Access denied - Global Admin only" });
      }

      const tenant = await storage.getTenant(req.params.id);
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      const users = await storage.getUsersByDomain(tenant.domain);
      res.json(users.map(u => {
        const { password: _, ...userWithoutPassword } = u;
        return userWithoutPassword;
      }));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== MARKET MANAGEMENT & CONTEXT SWITCHING ====================

  // Switch active tenant context (Global Admin and Consultant only)
  app.post("/api/context/tenant", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const parsed = switchTenantSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: fromError(parsed.error).toString() });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      if (!hasCrossTenantReadAccess(user.role)) {
        return res.status(403).json({ error: "Access denied - only Global Admin and Consultants can switch tenants" });
      }

      const { tenantId } = parsed.data;
      const tenant = await storage.getTenant(tenantId);
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      if (tenant.status !== "active") {
        return res.status(400).json({ error: "Cannot switch to a suspended or inactive tenant" });
      }

      const userDomain = user.email.split("@")[1];
      const accessibleTenants = await storage.getAccessibleTenants(user.id, user.role, userDomain);
      
      if (!accessibleTenants.find(t => t.id === tenantId)) {
        return res.status(403).json({ error: "Access denied - you don't have access to this tenant" });
      }

      const defaultMarket = await storage.getDefaultMarket(tenantId);
      
      req.session.activeTenantId = tenantId;
      req.session.activeMarketId = defaultMarket?.id || undefined;
      
      res.json({
        activeTenantId: tenantId,
        activeMarketId: defaultMarket?.id || null,
        message: "Tenant context switched successfully"
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get markets for a tenant
  app.get("/api/markets", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      const userDomain = user.email.split("@")[1];
      const userTenant = await storage.getTenantByDomain(userDomain);
      
      const targetTenantId = getActiveTenantId(req) || userTenant?.id;
      if (!targetTenantId) {
        return res.status(400).json({ error: "No tenant context available" });
      }

      const accessibleTenants = await storage.getAccessibleTenants(user.id, user.role, userDomain);
      if (!accessibleTenants.find(t => t.id === targetTenantId)) {
        return res.status(403).json({ error: "Access denied" });
      }

      const tenant = await storage.getTenant(targetTenantId);
      const marketsList = await storage.getMarketsByTenant(targetTenantId);
      
      // Fetch all company profiles for this tenant once (efficient single query)
      const allProfiles = await storage.getCompanyProfilesByTenantDomain(tenant?.domain || "");
      
      // Build a map of marketId -> baseline profile for O(1) lookups
      const profilesByMarketId = new Map<string | null, typeof allProfiles[0]>();
      for (const profile of allProfiles) {
        profilesByMarketId.set(profile.marketId, profile);
      }
      
      // Enrich markets with baseline company info
      const marketsWithBaseline = marketsList.map((market) => {
        // Find profile for this market (or null marketId for legacy default market)
        let baselineProfile = profilesByMarketId.get(market.id);
        if (!baselineProfile && market.isDefault) {
          baselineProfile = profilesByMarketId.get(null);
        }
        return {
          ...market,
          baselineCompanyName: baselineProfile?.companyName || null,
          baselineCompanyUrl: baselineProfile?.websiteUrl || null,
        };
      });
      
      // Get limits from service plan (single source of truth)
      const servicePlan = tenant?.plan ? await storage.getServicePlanByName(tenant.plan) : null;

      // Only echo a market id that actually belongs to the targetTenantId we
      // just authorized — never pass through a header-supplied id from a
      // different tenant.
      const headerMarketId = getActiveMarketId(req);
      const marketOk = headerMarketId
        ? await storage.validateMarketBelongsToTenant(headerMarketId, targetTenantId)
        : false;

      res.json({
        markets: marketsWithBaseline,
        activeMarketId: marketOk ? headerMarketId : null,
        multiMarketEnabled: servicePlan?.multiMarketEnabled || false,
        marketLimit: servicePlan?.marketLimit ?? null
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Create a new market (Enterprise tenants with multi-market enabled)
  app.post("/api/markets", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      if (!hasContentAccess(user.role)) {
        return res.status(403).json({ error: "Access denied - admin privileges required" });
      }

      const userDomain = user.email.split("@")[1];
      const userTenant = await storage.getTenantByDomain(userDomain);

      const targetTenantId = getActiveTenantId(req) || userTenant?.id;
      if (!targetTenantId) {
        return res.status(400).json({ error: "No tenant context available" });
      }

      // Header-spoof guard: forged X-Active-Tenant-Id must not let a Domain
      // Admin create markets in another tenant.
      const accessibleTenants = await storage.getAccessibleTenants(user.id, user.role, userDomain);
      if (!accessibleTenants.find(t => t.id === targetTenantId)) {
        return res.status(403).json({ error: "Access denied - you don't have access to this tenant" });
      }

      const tenant = await storage.getTenant(targetTenantId);
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      // Get limits from service plan (single source of truth)
      const servicePlan = tenant.plan ? await storage.getServicePlanByName(tenant.plan) : null;

      if (!servicePlan?.multiMarketEnabled) {
        return res.status(403).json({ error: "Multi-market feature is not enabled for this tenant. Please upgrade to Enterprise plan." });
      }

      const existingMarkets = await storage.getMarketsByTenant(targetTenantId);
      if (servicePlan.marketLimit !== null && existingMarkets.length >= servicePlan.marketLimit) {
        return res.status(400).json({ error: `Market limit reached (${servicePlan.marketLimit}). Contact support to increase your limit.` });
      }

      const { name, description, websiteUrl, businessType } = req.body;
      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "Market name is required" });
      }

      const validBusinessTypes = ["b2b", "b2c"];
      const resolvedBusinessType = validBusinessTypes.includes(businessType) ? businessType : "b2b";

      const newMarket = await storage.createMarket({
        tenantId: targetTenantId,
        name: name.trim(),
        description: description?.trim() || null,
        businessType: resolvedBusinessType,
        isDefault: false,
        status: "active",
        createdBy: user.id,
      });

      // If a website URL was provided, automatically create a company profile for this market
      if (websiteUrl) {
        try {
          await storage.createCompanyProfile({
            userId: user.id,
            tenantDomain: tenant.domain,
            marketId: newMarket.id,
            companyName: name.trim(),
            websiteUrl: websiteUrl.trim(),
            description: description?.trim() || null,
          });
          console.log(`[Market Creation] Auto-created baseline company profile for market: ${newMarket.name}`);
        } catch (profileError) {
          console.error(`[Market Creation] Failed to create baseline company profile:`, profileError);
          // Don't fail market creation if profile creation fails
        }
      }

      res.status(201).json(newMarket);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/markets/:id/auto-build", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(401).json({ error: "User not found" });
      if (!hasContentAccess(user.role)) {
        return res.status(403).json({ error: "Access denied - admin privileges required" });
      }

      const userDomain = user.email.split("@")[1];
      const userTenant = await storage.getTenantByDomain(userDomain);
      const targetTenantId = getActiveTenantId(req) || userTenant?.id;
      if (!targetTenantId) return res.status(400).json({ error: "No tenant context available" });

      // Header-spoof guard: forged X-Active-Tenant-Id must not let a Domain
      // Admin trigger auto-build in another tenant.
      const accessibleTenants = await storage.getAccessibleTenants(user.id, user.role, userDomain);
      if (!accessibleTenants.find(t => t.id === targetTenantId)) {
        return res.status(403).json({ error: "Access denied - you don't have access to this tenant" });
      }

      const tenant = await storage.getTenant(targetTenantId);
      if (!tenant) return res.status(404).json({ error: "Tenant not found" });

      const { checkFeatureAccess } = await import("../services/plan-policy");
      const featureCheck = checkFeatureAccess(tenant.plan, "autoBuild");
      if (!featureCheck.allowed) {
        return res.status(403).json({ error: featureCheck.reason, upgradeRequired: true });
      }

      const market = await storage.getMarket(req.params.id);
      if (!market || market.tenantId !== targetTenantId) {
        return res.status(404).json({ error: "Market not found" });
      }

      const { z } = await import("zod");
      const autoBuildSchema = z.object({
        generateBriefing: z.boolean().default(true),
        competitorCount: z.number().int().min(2).max(10).default(6),
      });
      const parsed = autoBuildSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid parameters", details: parsed.error.flatten() });
      }

      const { startAutoBuild } = await import("../services/auto-build-service");
      const jobId = await startAutoBuild(user.id, tenant.domain, market.id, {
        generateBriefing: parsed.data.generateBriefing,
        competitorCount: parsed.data.competitorCount,
      });

      res.json({ jobId, message: "Auto Build started" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/auto-build/status/:jobId", async (req, res) => {
    try {
      // Use getRequestContext so per-tab tenant headers are validated against
      // the user's accessible tenants — prevents header-spoof probing across
      // tenant auto-build job ids.
      const ctx = await getRequestContext(req);
      const { getAutoBuildStatus } = await import("../services/auto-build-service");
      const status = getAutoBuildStatus(req.params.jobId, ctx.tenantDomain);
      if (!status) {
        return res.status(404).json({ error: "Job not found" });
      }
      const { tenantDomain: _td, userId: _uid, ...safeStatus } = status;
      res.json(safeStatus);
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/markets/:id/auto-build/active", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);
      const { getActiveJobForMarket } = await import("../services/auto-build-service");
      const activeJob = getActiveJobForMarket(ctx.tenantDomain, req.params.id);
      if (!activeJob) {
        return res.json({ active: false });
      }
      const { tenantDomain: _td, userId: _uid, ...safeProgress } = activeJob.progress;
      res.json({ active: true, jobId: activeJob.jobId, progress: safeProgress });
    } catch (error: any) {
      if (error instanceof ContextError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Analyze a URL for market creation (get company name and description)
  app.post("/api/markets/analyze-url", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      if (!hasContentAccess(user.role)) {
        return res.status(403).json({ error: "Access denied - admin privileges required" });
      }

      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ error: "URL is required" });
      }

      // Validate URL format
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          return res.status(400).json({ error: "Only HTTP/HTTPS URLs are allowed" });
        }
      } catch {
        return res.status(400).json({ error: "Invalid URL format" });
      }

      return res.status(503).json({ error: "Website crawl analysis is no longer available in Observatory." });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Update a market
  app.patch("/api/markets/:id", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      if (!hasContentAccess(user.role)) {
        return res.status(403).json({ error: "Access denied - admin privileges required" });
      }

      const market = await storage.getMarket(req.params.id);
      if (!market) {
        return res.status(404).json({ error: "Market not found" });
      }

      const userDomain = user.email.split("@")[1];
      const accessibleTenants = await storage.getAccessibleTenants(user.id, user.role, userDomain);
      if (!accessibleTenants.find(t => t.id === market.tenantId)) {
        return res.status(403).json({ error: "Access denied" });
      }

      const { name, description, status, businessType, primaryColor, secondaryColor } = req.body;
      const updates: any = {};
      const wasArchived = market.status === "archived";
      
      if (name !== undefined) updates.name = name.trim();
      if (description !== undefined) updates.description = description?.trim() || null;
      if (status !== undefined && ["active", "archived"].includes(status)) {
        updates.status = status;
      }
      if (businessType !== undefined && ["b2b", "b2c"].includes(businessType)) {
        updates.businessType = businessType;
      }
      if (primaryColor !== undefined) updates.primaryColor = primaryColor || null;
      if (secondaryColor !== undefined) updates.secondaryColor = secondaryColor || null;

      const updatedMarket = await storage.updateMarket(req.params.id, updates);
      
      // Invalidate market status cache if status was updated
      if (status !== undefined) {
        invalidateMarketStatusCache(req.params.id);
      }
      
      // If unarchiving (was archived, now active), trigger immediate refreshes
      if (wasArchived && status === "active") {
        // Get tenant domain from the market's tenant
        const tenant = await storage.getTenant(market.tenantId);
        const tenantDomain = tenant?.domain || "";
        
        if (tenantDomain) {
          const contextFilter: ContextFilter = {
            tenantId: market.tenantId,
            marketId: market.id,
            tenantDomain,
          };
          
          // Get all competitors and company profile in this market
          const competitors = await storage.getCompetitorsByContext(contextFilter);
          const companyProfile = await storage.getCompanyProfileByContext(contextFilter);
          
          console.log(`[Unarchive] Triggering refresh for market ${market.name} - ${competitors.length} competitors`);
          
          console.log(`[Unarchive] Market ${market.name} unarchived — website/social monitoring removed from Observatory.`);
        }
      }
      
      res.json(updatedMarket);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Delete a market (non-default only)
  app.delete("/api/markets/:id", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      if (!hasAdminAccess(user.role)) {
        return res.status(403).json({ error: "Access denied - admin privileges required" });
      }

      const market = await storage.getMarket(req.params.id);
      if (!market) {
        return res.status(404).json({ error: "Market not found" });
      }

      // Cannot delete default market
      if (market.isDefault) {
        return res.status(400).json({ error: "Cannot delete the default market" });
      }

      // Verify user has access to this tenant
      const userDomain = user.email.split("@")[1];
      const accessibleTenants = await storage.getAccessibleTenants(user.id, user.role, userDomain);
      if (!accessibleTenants.find(t => t.id === market.tenantId)) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Delete market and associated data
      await storage.deleteMarket(req.params.id);

      // If the deleted market was the active market, switch to default
      if (req.session.activeMarketId === req.params.id) {
        const defaultMarket = await storage.getDefaultMarket(market.tenantId);
        req.session.activeMarketId = defaultMarket?.id || undefined;
      }

      res.json({ success: true, message: "Market deleted successfully" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Comprehensive market export - exports everything in a market to markdown
  app.get("/api/markets/:marketId/export", async (req, res) => {
    try {
      const ctx = await getRequestContext(req);

      const market = await storage.getMarket(req.params.marketId);
      if (!market) {
        return res.status(404).json({ error: "Market not found" });
      }

      // Validate market belongs to current tenant
      if (market.tenantId !== ctx.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Build context filter for the requested market
      const marketCtx = {
        tenantId: ctx.tenantId,
        marketId: req.params.marketId,
        tenantDomain: ctx.tenantDomain,
        isDefaultMarket: market.isDefault,
      };

      // Gather all market data
      // For default market, include profiles with null marketId (legacy data)
      const companyProfiles = await storage.getCompanyProfilesByTenantDomain(ctx.tenantDomain);
      const marketCompanyProfiles = market.isDefault 
        ? companyProfiles.filter(p => p.marketId === req.params.marketId || p.marketId === null)
        : companyProfiles.filter(p => p.marketId === req.params.marketId);
      const competitors = await storage.getCompetitorsByContext(marketCtx);
      const projects = await storage.getClientProjectsByContext(marketCtx);
      const products = await storage.getProductsByContext(marketCtx);

      // Build comprehensive markdown
      let md = `# ${market.name} - Complete Market Intelligence Export\n\n`;
      md += `**Tenant:** ${ctx.tenantDomain}\n`;
      md += `**Generated:** ${new Date().toISOString()}\n\n`;
      md += `---\n\n`;

      // Gather marketing plans
      const marketingPlansData = await storage.getMarketingPlans({ 
        tenantDomain: ctx.tenantDomain, 
        marketId: req.params.marketId 
      });

      // Gather additional data
      const activityData = await storage.getActivityByContext(marketCtx);
      const assessmentsData = await storage.getAssessmentsByContext(marketCtx);
      const companyBattlecardsData = await storage.getBattlecardsByContext(marketCtx);
      const competitorScoresData = await storage.getCompetitorScoresByContext(marketCtx);

      // Table of Contents
      md += `## Table of Contents\n\n`;
      md += `1. [Market Overview](#market-overview)\n`;
      md += `2. [Company Profiles](#company-profiles) (includes executive summaries)\n`;
      md += `3. [Competitors](#competitors) (includes scores, battlecards)\n`;
      md += `4. [Projects](#projects) (includes battlecards, gap analysis, GTM plans, messaging)\n`;
      md += `5. [Products](#products) (includes features, roadmaps, AI recommendations)\n`;
      md += `6. [Marketing Plans](#marketing-plans)\n`;
      md += `7. [Assessments](#assessments)\n`;
      md += `8. [Activity Log](#activity-log)\n\n`;
      md += `---\n\n`;

      // Market Overview
      md += `## Market Overview\n\n`;
      md += `**Name:** ${market.name}\n`;
      if (market.description) {
        md += `**Description:** ${market.description}\n`;
      }
      md += `**Status:** ${market.status || "active"}\n`;
      md += `**Created:** ${market.createdAt ? new Date(market.createdAt).toLocaleDateString() : "N/A"}\n\n`;
      md += `### Summary Statistics\n\n`;
      md += `- **Company Profiles:** ${marketCompanyProfiles.length}\n`;
      md += `- **Competitors Tracked:** ${competitors.length}\n`;
      md += `- **Active Projects:** ${projects.length}\n`;
      md += `- **Products:** ${products.length}\n\n`;
      md += `---\n\n`;

      // Company Profiles
      md += `## Company Profiles\n\n`;
      if (marketCompanyProfiles.length === 0) {
        md += `*No company profiles defined in this market.*\n\n`;
      } else {
        for (const profile of marketCompanyProfiles) {
          md += `### ${profile.companyName}\n\n`;
          if (profile.websiteUrl) md += `- **Website:** ${profile.websiteUrl}\n`;
          if (profile.description) md += `\n${profile.description}\n`;
          
          // Include analysis if available
          if (profile.analysisData) {
            const analysis = typeof profile.analysisData === "string" 
              ? JSON.parse(profile.analysisData) 
              : profile.analysisData;
            if (analysis.summary) {
              md += `\n#### Analysis Summary\n\n${analysis.summary}\n`;
            }
            if (analysis.strengths?.length > 0) {
              md += `\n**Strengths:**\n`;
              analysis.strengths.forEach((s: string) => md += `- ${s}\n`);
            }
            if (analysis.weaknesses?.length > 0) {
              md += `\n**Weaknesses:**\n`;
              analysis.weaknesses.forEach((w: string) => md += `- ${w}\n`);
            }
          }

          // Include executive summary if available
          const execSummary = await storage.getExecutiveSummary(undefined, profile.id);
          if (execSummary?.summaryData) {
            md += `\n#### Executive Summary\n\n`;
            md += `*Generated: ${execSummary.lastGeneratedAt ? new Date(execSummary.lastGeneratedAt).toLocaleDateString() : "N/A"}*\n\n`;
            const summaryData = typeof execSummary.summaryData === "string" 
              ? JSON.parse(execSummary.summaryData) 
              : execSummary.summaryData;
            if (summaryData.summary) md += summaryData.summary + `\n`;
            if (execSummary.keyInsights) {
              const insights = execSummary.keyInsights as string[];
              if (insights?.length > 0) {
                md += `\n**Key Insights:**\n`;
                insights.forEach(i => md += `- ${i}\n`);
              }
            }
          }

          md += `\n`;
        }
      }
      md += `---\n\n`;

      // Competitors
      md += `## Competitors\n\n`;
      if (competitors.length === 0) {
        md += `*No competitors tracked in this market.*\n\n`;
      } else {
        for (const comp of competitors) {
          md += `### ${comp.name}\n\n`;
          if (comp.url) md += `- **Website:** ${comp.url}\n`;
          md += `- **Status:** ${comp.status || "active"}\n`;
          
          // Include analysis if available
          if (comp.analysisData) {
            const analysis = typeof comp.analysisData === "string" 
              ? JSON.parse(comp.analysisData) 
              : comp.analysisData;
            if (analysis.summary) {
              md += `\n#### Analysis Summary\n\n${analysis.summary}\n`;
            }
            if (analysis.strengths?.length > 0) {
              md += `\n**Strengths:**\n`;
              analysis.strengths.forEach((s: string) => md += `- ${s}\n`);
            }
            if (analysis.weaknesses?.length > 0) {
              md += `\n**Weaknesses:**\n`;
              analysis.weaknesses.forEach((w: string) => md += `- ${w}\n`);
            }
            if (analysis.opportunities?.length > 0) {
              md += `\n**Opportunities:**\n`;
              analysis.opportunities.forEach((o: string) => md += `- ${o}\n`);
            }
            if (analysis.threats?.length > 0) {
              md += `\n**Threats:**\n`;
              analysis.threats.forEach((t: string) => md += `- ${t}\n`);
            }
          }

          // Include competitor score if available
          const compScore = competitorScoresData.find(s => s.competitorId === comp.id);
          if (compScore) {
            md += `\n#### Orbit Score\n\n`;
            md += `- **Overall Score:** ${compScore.overallScore || "N/A"}/100\n`;
            if (compScore.marketPresenceScore) md += `- **Market Presence:** ${compScore.marketPresenceScore}\n`;
            if (compScore.innovationScore) md += `- **Innovation:** ${compScore.innovationScore}\n`;
            if (compScore.pricingScore) md += `- **Pricing:** ${compScore.pricingScore}\n`;
            if (compScore.featureBreadthScore) md += `- **Feature Breadth:** ${compScore.featureBreadthScore}\n`;
            if (compScore.contentActivityScore) md += `- **Content Activity:** ${compScore.contentActivityScore}\n`;
            if (compScore.socialEngagementScore) md += `- **Social Engagement:** ${compScore.socialEngagementScore}\n`;
            if (compScore.trendDirection) md += `- **Trend:** ${compScore.trendDirection} (${(compScore.trendDelta || 0) >= 0 ? '+' : ''}${compScore.trendDelta || 0})\n`;
            md += `\n`;
          }

          // Include company battlecard if available
          const compBattlecard = companyBattlecardsData.find(b => b.competitorId === comp.id);
          if (compBattlecard) {
            md += `\n#### Battlecard\n\n`;
            const strengths = compBattlecard.strengths as string[] | null;
            const weaknesses = compBattlecard.weaknesses as string[] | null;
            const ourAdvantages = compBattlecard.ourAdvantages as string[] | null;
            const objections = compBattlecard.objections as { objection: string; response: string }[] | null;
            const talkTracks = compBattlecard.talkTracks as { scenario: string; script: string }[] | null;

            if (strengths?.length) {
              md += `**Their Strengths:**\n`;
              strengths.forEach(s => md += `- ${s}\n`);
              md += `\n`;
            }
            if (weaknesses?.length) {
              md += `**Their Weaknesses:**\n`;
              weaknesses.forEach(w => md += `- ${w}\n`);
              md += `\n`;
            }
            if (ourAdvantages?.length) {
              md += `**Our Advantages:**\n`;
              ourAdvantages.forEach(a => md += `- ${a}\n`);
              md += `\n`;
            }
            if (objections?.length) {
              md += `**Objection Handling:**\n`;
              objections.forEach(o => md += `- *"${o.objection}"* → ${o.response}\n`);
              md += `\n`;
            }
            if (talkTracks?.length) {
              md += `**Talk Tracks:**\n`;
              talkTracks.forEach(t => md += `- **${t.scenario}**: "${t.script}"\n`);
              md += `\n`;
            }
          }

          md += `\n`;
        }
      }
      md += `---\n\n`;

      // Projects with full details
      md += `## Projects\n\n`;
      if (projects.length === 0) {
        md += `*No projects in this market.*\n\n`;
      } else {
        for (const project of projects) {
          md += `### ${project.name}\n\n`;
          md += `- **Client:** ${project.clientName}\n`;
          md += `- **Type:** ${project.analysisType === "product" ? "Product Analysis" : "Company Analysis"}\n`;
          md += `- **Status:** ${project.status}\n`;
          if (project.description) md += `\n${project.description}\n`;
          md += `\n`;

          // Get project products
          const projectProducts = await storage.getProjectProducts(project.id);
          const baselineProduct = projectProducts.find(pp => pp.role === "baseline");
          const competitorProducts = projectProducts.filter(pp => pp.role === "competitor");

          if (baselineProduct) {
            md += `#### Baseline Product\n`;
            md += `- **${baselineProduct.product?.name || "Unnamed"}** (${baselineProduct.product?.companyName || "Unknown"})\n\n`;
          }

          if (competitorProducts.length > 0) {
            md += `#### Competitor Products (${competitorProducts.length})\n`;
            for (const cp of competitorProducts) {
              md += `- ${cp.product?.name || "Unnamed"} (${cp.product?.companyName || "Unknown"})\n`;
            }
            md += `\n`;
          }

          // Get long-form recommendations for project
          const recommendations = await storage.getLongFormRecommendationsByProject(project.id);
          
          const gapAnalysis = recommendations.find(r => r.type === "gap_analysis");
          const strategicRecs = recommendations.find(r => r.type === "strategic_recommendations");
          const competitiveSummary = recommendations.find(r => r.type === "competitive_summary");
          const gtmPlan = recommendations.find(r => r.type === "gtm_plan");
          const messagingFramework = recommendations.find(r => r.type === "messaging_framework");
          const productOneSheet = recommendations.find(r => r.type === "product_one_sheet");

          if (gapAnalysis?.status === "generated" && gapAnalysis.content) {
            md += `#### Gap Analysis\n\n`;
            md += `*Generated: ${gapAnalysis.lastGeneratedAt ? new Date(gapAnalysis.lastGeneratedAt).toLocaleDateString() : "N/A"}*\n\n`;
            md += gapAnalysis.content + `\n\n`;
          }

          if (strategicRecs?.status === "generated" && strategicRecs.content) {
            md += `#### Strategic Recommendations\n\n`;
            md += `*Generated: ${strategicRecs.lastGeneratedAt ? new Date(strategicRecs.lastGeneratedAt).toLocaleDateString() : "N/A"}*\n\n`;
            md += strategicRecs.content + `\n\n`;
          }

          if (competitiveSummary?.status === "generated" && competitiveSummary.content) {
            md += `#### Competitive Summary\n\n`;
            md += `*Generated: ${competitiveSummary.lastGeneratedAt ? new Date(competitiveSummary.lastGeneratedAt).toLocaleDateString() : "N/A"}*\n\n`;
            md += competitiveSummary.content + `\n\n`;
          }

          if (gtmPlan?.status === "generated" && gtmPlan.content) {
            md += `#### Go-to-Market Plan\n\n`;
            md += `*Generated: ${gtmPlan.lastGeneratedAt ? new Date(gtmPlan.lastGeneratedAt).toLocaleDateString() : "N/A"}*\n\n`;
            md += gtmPlan.content + `\n\n`;
          }

          if (messagingFramework?.status === "generated" && messagingFramework.content) {
            md += `#### Messaging Framework\n\n`;
            md += `*Generated: ${messagingFramework.lastGeneratedAt ? new Date(messagingFramework.lastGeneratedAt).toLocaleDateString() : "N/A"}*\n\n`;
            md += messagingFramework.content + `\n\n`;
          }

          if (productOneSheet?.status === "generated" && productOneSheet.content) {
            md += `#### Product One Sheet\n\n`;
            md += `*Generated: ${productOneSheet.lastGeneratedAt ? new Date(productOneSheet.lastGeneratedAt).toLocaleDateString() : "N/A"}*\n\n`;
            md += productOneSheet.content + `\n\n`;
          }

          // Get battlecards for this project
          const battlecards = await storage.getProductBattlecardsByProject(project.id);
          const publishedBattlecards = battlecards.filter(bc => 
            bc.status === "published" || (Array.isArray(bc.strengths) && (bc.strengths as string[]).length > 0)
          );

          if (publishedBattlecards.length > 0) {
            md += `#### Battlecards\n\n`;
            for (const bc of publishedBattlecards) {
              const competitor = competitorProducts.find(cp => cp.productId === bc.competitorProductId);
              md += `##### ${competitor?.product?.name || "Competitor"}\n\n`;

              const strengths = bc.strengths as string[] | null;
              const weaknesses = bc.weaknesses as string[] | null;
              const ourAdvantages = bc.ourAdvantages as string[] | null;
              const keyDifferentiators = bc.keyDifferentiators as { feature: string; ours: string; theirs: string }[] | null;
              const objections = bc.objections as { objection: string; response: string }[] | null;
              const talkTracks = bc.talkTracks as { scenario: string; script: string }[] | null;

              if (strengths?.length) {
                md += `**Their Strengths:**\n`;
                strengths.forEach(s => md += `- ${s}\n`);
                md += `\n`;
              }
              if (weaknesses?.length) {
                md += `**Their Weaknesses:**\n`;
                weaknesses.forEach(w => md += `- ${w}\n`);
                md += `\n`;
              }
              if (ourAdvantages?.length) {
                md += `**Our Advantages:**\n`;
                ourAdvantages.forEach(a => md += `- ${a}\n`);
                md += `\n`;
              }
              if (keyDifferentiators?.length) {
                md += `**Key Differentiators:**\n`;
                keyDifferentiators.forEach(d => md += `- **${d.feature}**: Ours: ${d.ours} | Theirs: ${d.theirs}\n`);
                md += `\n`;
              }
              if (objections?.length) {
                md += `**Objection Handling:**\n`;
                objections.forEach(o => md += `- *"${o.objection}"* → ${o.response}\n`);
                md += `\n`;
              }
              if (talkTracks?.length) {
                md += `**Talk Tracks:**\n`;
                talkTracks.forEach(t => md += `- **${t.scenario}**: "${t.script}"\n`);
                md += `\n`;
              }
            }
          }
        }
      }
      md += `---\n\n`;

      // Products with Features and Roadmap
      md += `## Products\n\n`;
      if (products.length === 0) {
        md += `*No products defined in this market.*\n\n`;
      } else {
        for (const product of products) {
          md += `### ${product.name}\n\n`;
          if (product.companyName) md += `- **Company:** ${product.companyName}\n`;
          if (product.url) md += `- **URL:** ${product.url}\n`;
          md += `- **Type:** ${product.isBaseline ? "Baseline" : (product.competitorId ? "Competitor" : "Product")}\n`;
          if (product.description) md += `\n${product.description}\n`;
          md += `\n`;

          // Get features
          const features = await storage.getProductFeaturesByProduct(product.id);
          if (features.length > 0) {
            md += `#### Features (${features.length})\n\n`;
            
            // Group by category
            const byCategory: Record<string, typeof features> = {};
            for (const f of features) {
              const cat = f.category || "Uncategorized";
              if (!byCategory[cat]) byCategory[cat] = [];
              byCategory[cat].push(f);
            }
            
            for (const [category, catFeatures] of Object.entries(byCategory)) {
              md += `**${category}**\n`;
              for (const f of catFeatures) {
                const statusIcon = f.status === "available" ? "✅" : f.status === "planned" ? "🔜" : f.status === "beta" ? "🧪" : "❌";
                md += `- ${statusIcon} **${f.name}**`;
                if (f.priority) md += ` [${f.priority}]`;
                if (f.description) md += `: ${f.description}`;
                md += `\n`;
              }
              md += `\n`;
            }
          }

          // Get roadmap items
          const roadmapItems = await storage.getRoadmapItemsByProduct(product.id);
          if (roadmapItems.length > 0) {
            md += `#### Roadmap (${roadmapItems.length} items)\n\n`;
            
            // Group by quarter
            const byQuarter: Record<string, typeof roadmapItems> = {};
            for (const item of roadmapItems) {
              const q = item.quarter ? `${item.quarter} ${item.year}` : "Unscheduled";
              if (!byQuarter[q]) byQuarter[q] = [];
              byQuarter[q].push(item);
            }
            
            for (const [quarter, items] of Object.entries(byQuarter)) {
              md += `**${quarter}**\n`;
              for (const item of items) {
                const statusIcon = item.status === "completed" ? "✅" : item.status === "in_progress" ? "🔄" : "📋";
                md += `- ${statusIcon} **${item.title}**`;
                if (item.effort) md += ` [${item.effort}]`;
                if (item.description) md += `: ${item.description}`;
                md += `\n`;
              }
              md += `\n`;
            }
          }

          // Get AI feature recommendations for baseline products
          if (product.isBaseline) {
            const featureRecs = await storage.getFeatureRecommendationsByProduct(product.id);
            const pendingRecs = featureRecs.filter(r => r.status === "pending");
            if (pendingRecs.length > 0) {
              md += `#### AI Roadmap Recommendations (${pendingRecs.length})\n\n`;
              for (const rec of pendingRecs) {
                const typeIcon = rec.type === "gap" ? "🎯" : rec.type === "opportunity" ? "💡" : rec.type === "risk" ? "⚠️" : "📊";
                md += `- ${typeIcon} **${rec.title}** [${rec.type}]`;
                if (rec.suggestedPriority) md += ` (${rec.suggestedPriority} priority)`;
                if (rec.suggestedQuarter) md += ` - ${rec.suggestedQuarter}`;
                md += `\n`;
                if (rec.explanation) md += `  ${rec.explanation}\n`;
                md += `\n`;
              }
            }
          }

          // Include product analysis if available
          if (product.analysisData) {
            const analysis = typeof product.analysisData === "string" 
              ? JSON.parse(product.analysisData) 
              : product.analysisData;
            if (analysis.summary) {
              md += `#### Analysis\n\n${analysis.summary}\n\n`;
            }
          }
        }
      }

      md += `---\n\n`;

      // Marketing Plans section
      md += `## Marketing Plans\n\n`;
      if (marketingPlansData.length === 0) {
        md += `*No marketing plans in this market.*\n\n`;
      } else {
        for (const plan of marketingPlansData) {
          md += `### ${plan.name}\n\n`;
          if (plan.description) md += `${plan.description}\n\n`;
          md += `- **Fiscal Year:** ${plan.fiscalYear || "Not specified"}\n`;
          md += `- **Status:** ${plan.status || "draft"}\n`;
          md += `- **Created:** ${plan.createdAt ? new Date(plan.createdAt).toLocaleDateString() : "N/A"}\n\n`;

          // Get tasks for this plan
          const tasks = await storage.getMarketingTasks(plan.id, { 
            tenantDomain: ctx.tenantDomain, 
            marketId: req.params.marketId 
          });

          if (tasks.length > 0) {
            md += `#### Activities (${tasks.length})\n\n`;
            
            // Group by timeframe/quarter
            const byTimeframe: Record<string, typeof tasks> = {};
            for (const task of tasks) {
              const tf = task.timeframe || "Unscheduled";
              if (!byTimeframe[tf]) byTimeframe[tf] = [];
              byTimeframe[tf].push(task);
            }

            for (const [timeframe, tfTasks] of Object.entries(byTimeframe)) {
              md += `**${timeframe}**\n`;
              for (const task of tfTasks) {
                const statusIcon = task.status === "completed" ? "✅" : task.status === "in_progress" ? "🔄" : "📋";
                md += `- ${statusIcon} **${task.title}**`;
                if (task.priority) md += ` [${task.priority}]`;
                if (task.activityGroup) md += ` (${task.activityGroup})`;
                md += `\n`;
                if (task.description) md += `  ${task.description}\n`;
              }
              md += `\n`;
            }
          }
        }
      }

      md += `---\n\n`;

      // Assessments section
      md += `## Assessments\n\n`;
      if (assessmentsData.length === 0) {
        md += `*No assessments in this market.*\n\n`;
      } else {
        for (const assessment of assessmentsData) {
          md += `### ${assessment.name}\n\n`;
          md += `- **Type:** ${assessment.isProxy ? "Proxy Assessment" : "Competitive Assessment"}\n`;
          md += `- **Status:** ${assessment.status}\n`;
          md += `- **Created:** ${assessment.createdAt ? new Date(assessment.createdAt).toLocaleDateString() : "N/A"}\n`;
          if (assessment.isProxy) {
            if (assessment.proxyName) md += `- **Proxy Name:** ${assessment.proxyName}\n`;
            if (assessment.proxyCompany) md += `- **Proxy Company:** ${assessment.proxyCompany}\n`;
          }
          if (assessment.description) md += `\n${assessment.description}\n`;
          
          // Include analysis snapshot if available
          if (assessment.analysisSnapshot) {
            const data = typeof assessment.analysisSnapshot === "string" 
              ? JSON.parse(assessment.analysisSnapshot) 
              : assessment.analysisSnapshot;
            if (data.summary) {
              md += `\n#### Analysis Summary\n\n${data.summary}\n`;
            }
          }
          
          // Include recommendations snapshot if available
          if (assessment.recommendationsSnapshot) {
            const recs = typeof assessment.recommendationsSnapshot === "string" 
              ? JSON.parse(assessment.recommendationsSnapshot) 
              : assessment.recommendationsSnapshot;
            if (Array.isArray(recs) && recs.length > 0) {
              md += `\n**Key Recommendations:**\n`;
              recs.slice(0, 5).forEach((r: any) => md += `- ${r.title || r.description || r}\n`);
            }
          }
          md += `\n`;
        }
      }
      md += `---\n\n`;

      // Activity Log section
      md += `## Activity Log\n\n`;
      if (activityData.length === 0) {
        md += `*No activity recorded in this market.*\n\n`;
      } else {
        md += `*Showing ${Math.min(activityData.length, 50)} most recent activities*\n\n`;
        
        // Group by type
        const recentActivity = activityData.slice(0, 50);
        for (const item of recentActivity) {
          const date = item.createdAt ? new Date(item.createdAt).toLocaleDateString() : "N/A";
          const typeIcon = item.type === "website_update" ? "🌐" : 
                          item.type === "blog_update" ? "📝" : 
                          item.type === "social_update" ? "📱" : 
                          "📋";
          md += `- ${typeIcon} **${item.competitorName || "Unknown"}** - ${item.type} (${date})\n`;
          if (item.summary) md += `  ${item.summary}\n`;
          else if (item.description) md += `  ${item.description}\n`;
        }
      }

      md += `\n---\n\n`;
      md += `*Report generated by [Orbit](https://orbit.synozur.com) - Go-to-Market Intelligence Platform*\n\n`;
      md += `*Export Date: ${new Date().toISOString()}*\n\n`;
      md += `© 2026 The Synozur Alliance LLC. All Rights Reserved.\n`;

      // Send as downloadable markdown file
      const filename = `${market.name.replace(/[^a-z0-9]/gi, "_")}_complete_export.md`;
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(md);
    } catch (error: any) {
      console.error("Market export error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Switch active market context
  app.post("/api/context/market", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const parsed = switchMarketSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: fromError(parsed.error).toString() });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      const { marketId } = parsed.data;
      const market = await storage.getMarket(marketId);
      if (!market) {
        return res.status(404).json({ error: "Market not found" });
      }

      if (market.status !== "active") {
        return res.status(400).json({ error: "Cannot switch to an archived market" });
      }

      const userDomain = user.email.split("@")[1];
      const accessibleTenants = await storage.getAccessibleTenants(user.id, user.role, userDomain);
      if (!accessibleTenants.find(t => t.id === market.tenantId)) {
        return res.status(403).json({ error: "Access denied - you don't have access to this tenant" });
      }

      req.session.activeTenantId = market.tenantId;
      req.session.activeMarketId = marketId;

      // Stamp last_visited_at — fire and forget, never blocks the switch
      db.update(markets).set({ lastVisitedAt: new Date() }).where(eq(markets.id, marketId)).catch(() => {});

      res.json({
        activeTenantId: market.tenantId,
        activeMarketId: marketId,
        message: "Market context switched successfully"
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get current context (tenant + market)
  app.get("/api/context", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      const userDomain = user.email.split("@")[1];
      const userTenant = await storage.getTenantByDomain(userDomain);
      
      // Prefer per-tab headers (X-Active-Tenant-Id / X-Active-Market-Id) so this
      // endpoint reflects THIS tab's context, not whichever value another tab
      // last wrote into the session.
      let activeTenantId = getActiveTenantId(req);
      let activeMarketId = getActiveMarketId(req);
      const fromHeader = !!(req.headers["x-active-tenant-id"] || req.headers["x-active-market-id"]);

      // Header-spoof guard: a header-supplied tenant id must be in the user's
      // accessible tenants. If not, drop the spoofed value (do NOT expose
      // tenant/market metadata for tenants the user can't access).
      if (activeTenantId) {
        const accessible = await storage.getAccessibleTenants(user.id, user.role, userDomain);
        if (!accessible.find(t => t.id === activeTenantId)) {
          activeTenantId = undefined;
          activeMarketId = undefined;
        }
      }

      if (!activeTenantId && userTenant) {
        activeTenantId = userTenant.id;
        if (!fromHeader) req.session.activeTenantId = activeTenantId;
      }

      // If a market id came in but doesn't belong to the resolved tenant, drop it.
      if (activeMarketId && activeTenantId) {
        const valid = await storage.validateMarketBelongsToTenant(activeMarketId, activeTenantId);
        if (!valid) activeMarketId = undefined;
      }

      if (activeTenantId && !activeMarketId) {
        const defaultMarket = await storage.getDefaultMarket(activeTenantId);
        if (defaultMarket) {
          activeMarketId = defaultMarket.id;
          if (!fromHeader) req.session.activeMarketId = activeMarketId;
        }
      }

      const activeTenant = activeTenantId ? await storage.getTenant(activeTenantId) : null;
      const activeMarket = activeMarketId ? await storage.getMarket(activeMarketId) : null;
      
      res.json({
        activeTenantId,
        activeMarketId,
        activeTenant: activeTenant || null,
        activeMarket: activeMarket || null,
        canSwitchTenants: user.role === "Global Admin" || user.role === "Consultant"
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });


}
