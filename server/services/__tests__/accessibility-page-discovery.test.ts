/**
 * Unit tests for the SSRF-safe sitemap fetch and sitemap-index recursion
 * added to discoverAccessibilityPages.
 *
 * Covers:
 *  1. safeFetchText — private-IP URL blocked before first connection.
 *  2. safeFetchText — redirect to private IP blocked mid-chain.
 *  3. parseSitemapPageUrls — sitemap-index: child sitemaps fetched + pages collected.
 *  4. discoverAccessibilityPages — end-to-end index discovery with mocked fetch.
 *  5. discoverAccessibilityPages — regular urlset (regression check).
 */

import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";

// ── Mock validateUrlWithDnsCheck ─────────────────────────────────────────────

const mockValidate = vi.fn();

vi.mock("../../utils/url-validator", () => ({
  validateUrlWithDnsCheck: (...args: unknown[]) => mockValidate(...args),
  validateUrlFormat: vi.fn(async (u: string) => ({ isValid: true, normalizedUrl: u })),
}));

// ── Mock runInPage (nav-link fallback should never fire in these tests) ───────

vi.mock("../headless-crawler", () => ({
  runInPage: vi.fn(async () => []),
}));

// ── Imports under test (after mocks) ─────────────────────────────────────────

import {
  safeFetchText,
  extractLocUrls,
  parseSitemapPageUrls,
  discoverAccessibilityPages,
} from "../accessibility-scanner";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal fetch Response stub. */
function makeResp(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } as any,
    text: async () => body,
  } as unknown as Response;
}

/** Make validateUrlWithDnsCheck pass for all calls (safe public URL). */
function allowAll() {
  mockValidate.mockImplementation(async (u: string) => ({
    isValid: true,
    normalizedUrl: u,
  }));
}

/** Make validateUrlWithDnsCheck block URLs containing the given substring. */
function blockContaining(substring: string) {
  mockValidate.mockImplementation(async (u: string) => {
    if (u.includes(substring)) {
      return { isValid: false, error: `blocked: contains ${substring}` };
    }
    return { isValid: true, normalizedUrl: u };
  });
}

const URLSET = (locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((l) => `  <url><loc>${l}</loc></url>`).join("\n")}
</urlset>`;

const SITEMAPINDEX = (childUrls: string[]) =>
  `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${childUrls.map((u) => `  <sitemap><loc>${u}</loc></sitemap>`).join("\n")}
</sitemapindex>`;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("safeFetchText — SSRF protection", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    mockValidate.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("blocks a private-IP initial URL before making any network request", async () => {
    blockContaining("192.168");

    const result = await safeFetchText("http://192.168.1.1/sitemap.xml");

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled(); // blocked before fetch
  });

  it("blocks a redirect whose Location resolves to a private IP", async () => {
    // First call: the initial URL passes SSRF validation
    // Second call: the redirect target (private IP) is blocked
    mockValidate
      .mockResolvedValueOnce({ isValid: true, normalizedUrl: "https://example.com/sitemap.xml" })
      .mockResolvedValueOnce({ isValid: false, error: "URL resolves to a private IP" });

    // fetch returns a 301 pointing at a private-range address
    fetchSpy.mockResolvedValueOnce(
      makeResp(301, "", { location: "http://10.0.0.1/sitemap.xml" }),
    );

    const result = await safeFetchText("https://example.com/sitemap.xml");

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the initial request was made
    expect(mockValidate).toHaveBeenCalledTimes(2); // initial + redirect target
  });

  it("returns null for an unreachable redirect (no Location header)", async () => {
    allowAll();
    fetchSpy.mockResolvedValueOnce(makeResp(302, "", {})); // no Location

    const result = await safeFetchText("https://example.com/sitemap.xml");
    expect(result).toBeNull();
  });

  it("follows a safe redirect and returns the body", async () => {
    allowAll();
    fetchSpy
      .mockResolvedValueOnce(makeResp(301, "", { location: "https://example.com/sitemap-v2.xml" }))
      .mockResolvedValueOnce(makeResp(200, "<urlset/>"));

    const result = await safeFetchText("https://example.com/sitemap.xml");
    expect(result).toBe("<urlset/>");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns null when the response is 4xx", async () => {
    allowAll();
    fetchSpy.mockResolvedValueOnce(makeResp(404, "Not Found"));

    const result = await safeFetchText("https://example.com/sitemap.xml");
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("extractLocUrls — urlset parser", () => {
  const isPage = (url: string) => url.startsWith("https://example.com") && !url.endsWith(".xml");

  it("extracts all page <loc> entries up to the cap", () => {
    const xml = URLSET([
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/contact",
    ]);
    expect(extractLocUrls(xml, 10, isPage)).toEqual([
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/contact",
    ]);
  });

  it("respects the cap and returns at most cap entries", () => {
    const xml = URLSET([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
    expect(extractLocUrls(xml, 2, isPage)).toHaveLength(2);
  });

  it("excludes URLs that fail the isPageUrl predicate", () => {
    const xml = URLSET([
      "https://example.com/page",
      "https://other.com/page", // different origin — would be excluded by real isPageUrl
    ]);
    const strictIsPage = (u: string) => u.startsWith("https://example.com") && !u.endsWith(".xml");
    const result = extractLocUrls(xml, 10, strictIsPage);
    expect(result).toEqual(["https://example.com/page"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("parseSitemapPageUrls — sitemap-index recursion", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    mockValidate.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const isPage = (url: string) =>
    url.startsWith("https://example.com") && !url.endsWith(".xml");

  it("treats a <urlset> as a regular sitemap and extracts pages directly", async () => {
    allowAll();
    const xml = URLSET(["https://example.com/page1", "https://example.com/page2"]);

    const pages = await parseSitemapPageUrls(xml, 10, isPage);
    expect(pages).toEqual(["https://example.com/page1", "https://example.com/page2"]);
    // No HTTP fetch needed for urlset parsing
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("detects <sitemapindex>, fetches each child, and returns pages from all children", async () => {
    allowAll();

    const child1 = URLSET(["https://example.com/en/home", "https://example.com/en/about"]);
    const child2 = URLSET(["https://example.com/fr/accueil"]);

    fetchSpy
      .mockResolvedValueOnce(makeResp(200, child1)) // sitemap-en.xml
      .mockResolvedValueOnce(makeResp(200, child2)); // sitemap-fr.xml

    const index = SITEMAPINDEX([
      "https://example.com/sitemap-en.xml",
      "https://example.com/sitemap-fr.xml",
    ]);

    const pages = await parseSitemapPageUrls(index, 10, isPage);

    expect(pages).toContain("https://example.com/en/home");
    expect(pages).toContain("https://example.com/en/about");
    expect(pages).toContain("https://example.com/fr/accueil");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("stops fetching child sitemaps once the page cap is reached", async () => {
    allowAll();

    const child1 = URLSET([
      "https://example.com/p1",
      "https://example.com/p2",
      "https://example.com/p3",
    ]);

    fetchSpy.mockResolvedValueOnce(makeResp(200, child1));

    const index = SITEMAPINDEX([
      "https://example.com/sitemap1.xml",
      "https://example.com/sitemap2.xml", // should never be fetched
    ]);

    const pages = await parseSitemapPageUrls(index, 3, isPage);

    expect(pages).toHaveLength(3);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // second child never fetched
  });

  it("skips a child sitemap whose URL is blocked by SSRF validation", async () => {
    // Child 1 (private IP) blocked, child 2 allowed
    mockValidate
      .mockResolvedValueOnce({ isValid: false, error: "private IP" })         // sitemap-bad.xml
      .mockResolvedValueOnce({ isValid: true, normalizedUrl: "https://example.com/sitemap-ok.xml" }); // sitemap-ok.xml

    fetchSpy.mockResolvedValueOnce(
      makeResp(200, URLSET(["https://example.com/safe-page"])),
    );

    const index = SITEMAPINDEX([
      "http://10.0.0.1/sitemap-bad.xml",
      "https://example.com/sitemap-ok.xml",
    ]);

    const pages = await parseSitemapPageUrls(index, 10, isPage);

    expect(pages).toEqual(["https://example.com/safe-page"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the safe child was fetched
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("discoverAccessibilityPages — end-to-end with sitemap-index", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    mockValidate.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("collects pages from a sitemap index and always includes the base URL", async () => {
    allowAll();

    const child = URLSET([
      "https://site.com/features",
      "https://site.com/pricing",
    ]);

    fetchSpy
      .mockResolvedValueOnce(
        makeResp(200, SITEMAPINDEX(["https://site.com/sitemap-pages.xml"])),
      )
      .mockResolvedValueOnce(makeResp(200, child));

    const pages = await discoverAccessibilityPages("https://site.com/", 5);

    expect(pages).toContain("https://site.com/");
    expect(pages).toContain("https://site.com/features");
    expect(pages).toContain("https://site.com/pricing");
  });

  it("falls back to just the base URL when the sitemap is SSRF-blocked", async () => {
    // Block all sitemap fetches
    mockValidate.mockResolvedValue({ isValid: false, error: "private IP" });

    const pages = await discoverAccessibilityPages("https://internal.corp/", 5);

    // Only base URL survives; nav-link extraction (runInPage) also mocked to []
    expect(pages).toEqual(["https://internal.corp/"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still includes base URL when sitemap redirect is blocked mid-chain", async () => {
    // Initial sitemap URL OK, then redirect target blocked
    mockValidate
      .mockResolvedValueOnce({ isValid: true, normalizedUrl: "https://example.com/sitemap.xml" })
      .mockResolvedValueOnce({ isValid: false, error: "redirect to private IP" });

    fetchSpy.mockResolvedValueOnce(
      makeResp(301, "", { location: "http://169.254.169.254/sitemap.xml" }),
    );

    const pages = await discoverAccessibilityPages("https://example.com/", 5);

    expect(pages).toContain("https://example.com/");
    // No sitemap pages added — sitemap was blocked
    expect(pages.filter((p) => p !== "https://example.com/")).toHaveLength(0);
  });
});
