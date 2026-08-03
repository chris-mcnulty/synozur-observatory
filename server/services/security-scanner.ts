/**
 * Observatory — Built-in security scanner.
 *
 * Implements the ScannerProvider interface from observatory-scanners.ts.
 * Runs HTTP-based security checks against a registered application URL:
 *   - Security response headers (CSP, HSTS, X-Frame-Options, etc.)
 *   - TLS / HTTPS enforcement
 *   - TLS certificate validity and expiry
 *   - Cookie security flags (Secure, HttpOnly, SameSite)
 *   - Server version disclosure via Server / X-Powered-By headers
 *   - Common sensitive path exposure (/.env, /.git/HEAD, /phpinfo.php, etc.)
 *   - HTTP→HTTPS redirect enforcement
 *
 * All checks are performed with plain HTTPS/HTTP requests — no headless
 * browser — so the scanner is lightweight and can run within the existing
 * job-queue concurrency limits.
 */

import https from "https";
import http from "http";
import { URL } from "url";
import type {
  ScannerProvider,
  ScanRequest,
  ScanResult,
  ScannerFinding,
} from "./observatory-scanners";

// ── Header checks ────────────────────────────────────────────────────────────

interface HeaderCheck {
  header: string;
  ruleId: string;
  title: string;
  description: string;
  severity: string;
  recommendation: string;
  cweId?: string;
  /** Return true if the header value looks misconfigured (beyond just missing). */
  checkValue?: (value: string) => { pass: boolean; note?: string } | null;
}

const HEADER_CHECKS: HeaderCheck[] = [
  {
    header: "strict-transport-security",
    ruleId: "missing-hsts",
    title: "Missing HTTP Strict Transport Security (HSTS)",
    description:
      "The Strict-Transport-Security header is absent. Without HSTS, browsers will not enforce HTTPS, leaving users vulnerable to downgrade attacks and man-in-the-middle interception.",
    severity: "High",
    recommendation:
      "Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` to every HTTPS response.",
    cweId: "CWE-319",
    checkValue: (v) => {
      const maxAgeMatch = v.match(/max-age=(\d+)/i);
      if (!maxAgeMatch) return { pass: false, note: "max-age directive missing" };
      const maxAge = parseInt(maxAgeMatch[1], 10);
      if (maxAge < 15768000) {
        return {
          pass: false,
          note: `max-age is only ${maxAge}s (< 6 months). Increase to at least 31536000.`,
        };
      }
      return { pass: true };
    },
  },
  {
    header: "x-frame-options",
    ruleId: "missing-x-frame-options",
    title: "Missing X-Frame-Options Header",
    description:
      "The X-Frame-Options header is not set. Without it, attackers can embed this page in an iframe and trick users into clicking elements they cannot see (clickjacking).",
    severity: "Medium",
    recommendation:
      "Add `X-Frame-Options: DENY` or `SAMEORIGIN`. Alternatively use `Content-Security-Policy: frame-ancestors 'none'`.",
    cweId: "CWE-1021",
  },
  {
    header: "x-content-type-options",
    ruleId: "missing-x-content-type-options",
    title: "Missing X-Content-Type-Options Header",
    description:
      "The X-Content-Type-Options header is absent. Without `nosniff`, browsers may MIME-sniff responses and execute content as a different type, enabling XSS.",
    severity: "Low",
    recommendation: "Add `X-Content-Type-Options: nosniff` to all responses.",
    cweId: "CWE-693",
  },
  {
    header: "content-security-policy",
    ruleId: "missing-csp",
    title: "No Content Security Policy (CSP)",
    description:
      "No Content-Security-Policy header was found. A CSP prevents cross-site scripting (XSS), data injection, and clickjacking by declaring approved content sources.",
    severity: "Medium",
    recommendation:
      "Define a Content-Security-Policy. Start with `default-src 'self'` and add exceptions as needed. Avoid `unsafe-inline` and `unsafe-eval`.",
    cweId: "CWE-693",
  },
  {
    header: "referrer-policy",
    ruleId: "missing-referrer-policy",
    title: "Missing Referrer-Policy Header",
    description:
      "The Referrer-Policy header is absent. Without it, the browser may send the full URL (including query strings with tokens or IDs) in the Referer header to third-party requests.",
    severity: "Low",
    recommendation:
      "Add `Referrer-Policy: strict-origin-when-cross-origin` or `no-referrer` for stricter control.",
    cweId: "CWE-116",
  },
  {
    header: "permissions-policy",
    ruleId: "missing-permissions-policy",
    title: "Missing Permissions-Policy Header",
    description:
      "The Permissions-Policy (formerly Feature-Policy) header is not set. This header restricts access to browser APIs such as camera, microphone, and geolocation.",
    severity: "Informational",
    recommendation:
      "Add a `Permissions-Policy` header to explicitly disable features your application does not need (e.g. `camera=(), microphone=(), geolocation=()`).",
    cweId: "CWE-693",
  },
];

// ── Sensitive paths ──────────────────────────────────────────────────────────

interface SensitivePath {
  path: string;
  ruleId: string;
  title: string;
  description: string;
  severity: string;
  cweId: string;
  /** If true, finding is only raised when the response body matches this pattern. */
  bodyMatch?: RegExp;
}

const SENSITIVE_PATHS: SensitivePath[] = [
  {
    path: "/.env",
    ruleId: "exposed-env-file",
    title: "Environment Configuration File Accessible",
    description:
      "The /.env file is publicly readable. It commonly contains database credentials, API keys, and other secrets that would give an attacker full access to backend systems.",
    severity: "Critical",
    cweId: "CWE-200",
    bodyMatch: /(?:DB_|DATABASE_URL|APP_KEY|SECRET|PASSWORD|TOKEN|API_KEY)/i,
  },
  {
    path: "/.git/HEAD",
    ruleId: "exposed-git-head",
    title: "Git Repository Metadata Exposed",
    description:
      "The /.git/HEAD file is publicly accessible. This indicates the full git repository may be downloadable, potentially leaking all source code and history.",
    severity: "Critical",
    cweId: "CWE-538",
    bodyMatch: /^ref: refs\//,
  },
  {
    path: "/.git/config",
    ruleId: "exposed-git-config",
    title: "Git Configuration File Exposed",
    description:
      "The /.git/config file is accessible. It may contain repository remote URLs and credential helpers.",
    severity: "High",
    cweId: "CWE-538",
    bodyMatch: /\[core\]/,
  },
  {
    path: "/phpinfo.php",
    ruleId: "exposed-phpinfo",
    title: "PHP Info Page Exposed",
    description:
      "phpinfo() output is publicly accessible. It reveals PHP configuration, loaded extensions, server environment variables, and file system paths — a reconnaissance goldmine.",
    severity: "High",
    cweId: "CWE-200",
    bodyMatch: /<title>phpinfo\(\)<\/title>/i,
  },
  {
    path: "/.htaccess",
    ruleId: "exposed-htaccess",
    title: "Apache .htaccess File Accessible",
    description:
      "The Apache .htaccess configuration file is readable. It may disclose rewrite rules, authentication configuration, or other security-relevant server settings.",
    severity: "Medium",
    cweId: "CWE-538",
    bodyMatch: /^(?:Options|RewriteEngine|AuthType|Deny from)/im,
  },
  {
    path: "/web.config",
    ruleId: "exposed-webconfig",
    title: "IIS web.config File Accessible",
    description:
      "The IIS web.config file is publicly readable. It may contain connection strings, encryption keys, and authentication configuration.",
    severity: "High",
    cweId: "CWE-538",
    bodyMatch: /<configuration>/i,
  },
  {
    path: "/server-status",
    ruleId: "exposed-server-status",
    title: "Apache Server Status Page Exposed",
    description:
      "The Apache mod_status page is publicly accessible. It reveals active requests, client IP addresses, and server load — useful for attack planning.",
    severity: "Medium",
    cweId: "CWE-200",
    bodyMatch: /Apache Server Status/i,
  },
  {
    path: "/wp-login.php",
    ruleId: "wordpress-login-exposed",
    title: "WordPress Login Page Exposed",
    description:
      "The WordPress admin login page is reachable from the internet, allowing brute-force or credential stuffing attacks on the CMS.",
    severity: "Low",
    cweId: "CWE-307",
    bodyMatch: /wp-login|WordPress/i,
  },
];

// ── HTTP helper ──────────────────────────────────────────────────────────────

interface FetchResult {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  finalUrl: string;
  redirectChain: string[];
  tlsCert?: {
    valid: boolean;
    daysUntilExpiry: number | null;
    subject?: string;
    issuer?: string;
    error?: string;
  };
}

function makeRequest(
  url: string,
  options: { followRedirects?: boolean; timeout?: number; method?: string } = {},
): Promise<FetchResult | null> {
  return new Promise((resolve) => {
    const { followRedirects = false, timeout = 10000, method = "GET" } = options;
    const redirectChain: string[] = [];
    let tlsCert: FetchResult["tlsCert"];

    const doRequest = (currentUrl: string, depth: number) => {
      if (depth > 6) {
        resolve(null);
        return;
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(currentUrl);
      } catch {
        resolve(null);
        return;
      }

      const isHttps = parsedUrl.protocol === "https:";
      const lib = isHttps ? https : http;
      const port = parsedUrl.port
        ? parseInt(parsedUrl.port, 10)
        : isHttps
        ? 443
        : 80;

      const reqOptions: https.RequestOptions = {
        hostname: parsedUrl.hostname,
        port,
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: {
          "User-Agent": "Observatory-SecurityScanner/1.0 (internal)",
          "Accept": "text/html,application/xhtml+xml,*/*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        // Allow self-signed certs so we can inspect the cert ourselves
        rejectUnauthorized: false,
        timeout,
      };

      const req = (lib as typeof https).request(reqOptions, (res) => {
        // Capture TLS info on HTTPS connections
        if (isHttps) {
          const socket = res.socket as any;
          try {
            const cert = socket.getPeerCertificate?.();
            if (cert && cert.subject) {
              const now = Date.now();
              const validTo = cert.valid_to ? new Date(cert.valid_to).getTime() : null;
              const validFrom = cert.valid_from ? new Date(cert.valid_from).getTime() : null;
              const daysUntilExpiry = validTo
                ? Math.floor((validTo - now) / 86400000)
                : null;
              const isNotYetValid = validFrom ? now < validFrom : false;
              const isExpired = validTo ? now > validTo : false;

              tlsCert = {
                valid: !isExpired && !isNotYetValid && !socket.isSessionReused?.(),
                daysUntilExpiry,
                subject: cert.subject?.CN,
                issuer: cert.issuer?.O,
              };
            } else {
              tlsCert = { valid: false, daysUntilExpiry: null, error: "No certificate" };
            }
          } catch {
            tlsCert = { valid: false, daysUntilExpiry: null, error: "Certificate inspection failed" };
          }
        }

        const location = res.headers["location"] as string | undefined;
        const statusCode = res.statusCode ?? 0;

        if (followRedirects && [301, 302, 303, 307, 308].includes(statusCode) && location) {
          redirectChain.push(currentUrl);
          const nextUrl = location.startsWith("http") ? location : new URL(location, currentUrl).href;
          doRequest(nextUrl, depth + 1);
          res.resume();
          return;
        }

        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          // Cap body at 64 KB to avoid memory issues
          if (body.length < 65536) body += chunk;
        });
        res.on("end", () => {
          const headers: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) headers[k.toLowerCase()] = v as string | string[];
          }
          resolve({
            statusCode,
            headers,
            body,
            finalUrl: currentUrl,
            redirectChain,
            tlsCert,
          });
        });
      });

      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      req.on("error", () => {
        resolve(null);
      });

      req.end();
    };

    doRequest(url, 0);
  });
}

// ── Scanner implementation ────────────────────────────────────────────────────

async function checkHttpToHttpsRedirect(
  appUrl: string,
): Promise<ScannerFinding | null> {
  let parsed: URL;
  try {
    parsed = new URL(appUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;

  const httpUrl = appUrl.replace(/^https:/, "http:");
  const result = await makeRequest(httpUrl, { followRedirects: false, timeout: 8000 });
  if (!result) return null;

  const location = result.headers["location"] as string | undefined;
  const isRedirectToHttps =
    [301, 302, 307, 308].includes(result.statusCode) &&
    location?.startsWith("https://");

  if (!isRedirectToHttps) {
    return {
      ruleId: "http-no-redirect",
      title: "HTTP Requests Not Redirected to HTTPS",
      description: `Accessing ${httpUrl} over plain HTTP returned status ${result.statusCode} without redirecting to HTTPS. Users connecting over HTTP are not protected by TLS.`,
      severity: "High",
      cweId: "CWE-319",
      location: { url: httpUrl },
      raw: { statusCode: result.statusCode, location },
    };
  }
  return null;
}

async function checkTlsCertificate(
  appUrl: string,
  fetchResult: FetchResult,
): Promise<ScannerFinding[]> {
  const findings: ScannerFinding[] = [];
  const cert = fetchResult.tlsCert;
  if (!cert) return findings;

  if (cert.error || !cert.valid) {
    findings.push({
      ruleId: "invalid-tls-cert",
      title: "TLS Certificate Invalid or Missing",
      description: `The TLS certificate for ${appUrl} is invalid or could not be verified. ${cert.error ?? "Certificate validation failed."}`,
      severity: "Critical",
      cweId: "CWE-295",
      location: { url: appUrl },
      raw: cert,
    });
  } else if (cert.daysUntilExpiry !== null && cert.daysUntilExpiry < 30) {
    findings.push({
      ruleId: "tls-cert-expiring-soon",
      title: `TLS Certificate Expires in ${cert.daysUntilExpiry} Day${cert.daysUntilExpiry === 1 ? "" : "s"}`,
      description: `The TLS certificate for ${appUrl} (issued by ${cert.issuer ?? "unknown"}) expires in ${cert.daysUntilExpiry} days. Expired certificates will cause browser security warnings and break HTTPS.`,
      severity: cert.daysUntilExpiry < 7 ? "High" : "Medium",
      cweId: "CWE-298",
      location: { url: appUrl },
      raw: cert,
    });
  }
  return findings;
}

function checkSecurityHeaders(
  appUrl: string,
  fetchResult: FetchResult,
): ScannerFinding[] {
  const findings: ScannerFinding[] = [];
  const headers = fetchResult.headers;

  for (const check of HEADER_CHECKS) {
    const value = headers[check.header];

    if (!value) {
      // CSP absence is less critical if X-Frame-Options is set (partial overlap)
      if (check.ruleId === "missing-x-frame-options" && headers["content-security-policy"]) {
        const csp = Array.isArray(headers["content-security-policy"])
          ? headers["content-security-policy"].join("; ")
          : headers["content-security-policy"];
        if (/frame-ancestors/i.test(csp)) continue; // CSP covers clickjacking
      }
      findings.push({
        ruleId: check.ruleId,
        title: check.title,
        description: check.description,
        severity: check.severity,
        cweId: check.cweId,
        location: { url: appUrl },
        raw: { checkedHeader: check.header, responseHeaders: Object.keys(headers) },
      });
      continue;
    }

    // Header present — check value quality
    if (check.checkValue) {
      const rawValue = Array.isArray(value) ? value[0] : value;
      const result = check.checkValue(rawValue);
      if (result && !result.pass) {
        findings.push({
          ruleId: `${check.ruleId}-weak`,
          title: `Weak ${check.title.replace("Missing ", "")} Configuration`,
          description: `${check.description} Current value: \`${rawValue}\`. ${result.note ?? ""}`.trim(),
          severity: check.severity === "High" ? "Medium" : check.severity,
          cweId: check.cweId,
          location: { url: appUrl },
          raw: { checkedHeader: check.header, value: rawValue },
        });
      }
    }
  }

  return findings;
}

function checkServerDisclosure(
  appUrl: string,
  fetchResult: FetchResult,
): ScannerFinding[] {
  const findings: ScannerFinding[] = [];
  const serverHeader = fetchResult.headers["server"] as string | undefined;
  const poweredByHeader = fetchResult.headers["x-powered-by"] as string | undefined;

  // Check for version numbers in Server header
  if (serverHeader && /[\d.]/.test(serverHeader)) {
    findings.push({
      ruleId: "server-version-disclosure",
      title: "Server Version Disclosed in Response Header",
      description: `The Server header discloses the software version: \`${serverHeader}\`. Version disclosure helps attackers identify known vulnerabilities without active scanning.`,
      severity: "Low",
      cweId: "CWE-200",
      location: { url: appUrl },
      raw: { header: "Server", value: serverHeader },
    });
  }

  if (poweredByHeader) {
    findings.push({
      ruleId: "x-powered-by-disclosure",
      title: "Technology Stack Disclosed via X-Powered-By Header",
      description: `The X-Powered-By header reveals the server-side technology: \`${poweredByHeader}\`. This aids attacker reconnaissance and should be removed.`,
      severity: "Informational",
      cweId: "CWE-200",
      location: { url: appUrl },
      raw: { header: "X-Powered-By", value: poweredByHeader },
    });
  }

  return findings;
}

function checkCookieFlags(
  appUrl: string,
  fetchResult: FetchResult,
): ScannerFinding[] {
  const findings: ScannerFinding[] = [];
  const setCookieRaw = fetchResult.headers["set-cookie"];
  if (!setCookieRaw) return findings;

  const cookies = Array.isArray(setCookieRaw) ? setCookieRaw : [setCookieRaw];
  const insecure: string[] = [];
  const noHttpOnly: string[] = [];
  const noSameSite: string[] = [];

  for (const cookie of cookies) {
    const nameMatch = cookie.match(/^([^=]+)=/);
    const name = nameMatch ? nameMatch[1].trim() : "unknown";

    if (!/;\s*secure/i.test(cookie)) insecure.push(name);
    if (!/;\s*httponly/i.test(cookie)) noHttpOnly.push(name);
    if (!/;\s*samesite/i.test(cookie)) noSameSite.push(name);
  }

  if (insecure.length) {
    findings.push({
      ruleId: "cookie-missing-secure-flag",
      title: "Cookies Missing the Secure Flag",
      description: `The following cookies lack the Secure flag and will be transmitted over HTTP: ${insecure.join(", ")}. This exposes session tokens to network interception.`,
      severity: "Medium",
      cweId: "CWE-614",
      location: { url: appUrl },
      raw: { cookies: insecure },
    });
  }

  if (noHttpOnly.length) {
    findings.push({
      ruleId: "cookie-missing-httponly-flag",
      title: "Cookies Missing the HttpOnly Flag",
      description: `The following cookies lack the HttpOnly flag and are accessible from JavaScript: ${noHttpOnly.join(", ")}. If XSS is present, session tokens can be exfiltrated.`,
      severity: "Medium",
      cweId: "CWE-1004",
      location: { url: appUrl },
      raw: { cookies: noHttpOnly },
    });
  }

  if (noSameSite.length) {
    findings.push({
      ruleId: "cookie-missing-samesite-flag",
      title: "Cookies Missing the SameSite Attribute",
      description: `The following cookies have no SameSite attribute: ${noSameSite.join(", ")}. Without SameSite, cookies are included in cross-site requests, enabling CSRF attacks.`,
      severity: "Low",
      cweId: "CWE-352",
      location: { url: appUrl },
      raw: { cookies: noSameSite },
    });
  }

  return findings;
}

async function checkSensitivePaths(
  baseUrl: string,
): Promise<ScannerFinding[]> {
  const findings: ScannerFinding[] = [];
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return findings;
  }

  const origin = `${base.protocol}//${base.host}`;

  const results = await Promise.all(
    SENSITIVE_PATHS.map(async (sp) => {
      const url = origin + sp.path;
      try {
        const result = await makeRequest(url, { followRedirects: false, timeout: 6000 });
        return { sp, url, result };
      } catch {
        return { sp, url, result: null };
      }
    }),
  );

  for (const { sp, url, result } of results) {
    if (!result) continue;
    if (result.statusCode !== 200) continue;
    // Body match guard — only report if the response looks like the real file
    if (sp.bodyMatch && !sp.bodyMatch.test(result.body)) continue;

    findings.push({
      ruleId: sp.ruleId,
      title: sp.title,
      description: `${sp.description} The path \`${sp.path}\` returned HTTP 200.`,
      severity: sp.severity,
      cweId: sp.cweId,
      location: { url },
      raw: { statusCode: result.statusCode, bodyPreview: result.body.substring(0, 200) },
    });
  }

  return findings;
}

// ── ScannerProvider implementation ───────────────────────────────────────────

export const securityScanner: ScannerProvider = {
  key: "builtin_security",
  name: "Built-in Security Scanner",
  assessmentTypes: ["security", "pen_test", "penetration_test"],

  async isAvailable(_tenantDomain: string): Promise<boolean> {
    return true; // Always available — no external dependencies
  },

  async runScan(request: ScanRequest): Promise<ScanResult> {
    const startedAt = new Date();
    const targetUrl = request.target.url;
    if (!targetUrl) {
      throw new Error("Security scanner requires a target URL");
    }

    const findings: ScannerFinding[] = [];

    // 1. Fetch the main page (follow redirects to final destination)
    const fetchResult = await makeRequest(targetUrl, {
      followRedirects: true,
      timeout: 15000,
    });

    if (!fetchResult) {
      return {
        findings: [
          {
            ruleId: "target-unreachable",
            title: "Target URL Unreachable",
            description: `The scanner could not connect to ${targetUrl}. The application may be down, behind authentication, or blocking automated requests.`,
            severity: "Informational",
            location: { url: targetUrl },
          },
        ],
        rawReport: {
          contentType: "application/json",
          body: JSON.stringify({ error: "Target unreachable", url: targetUrl }),
        },
        tool: "builtin_security@1.0",
        startedAt,
        finishedAt: new Date(),
      };
    }

    // 2. Parallel checks against HTTP redirect, TLS, and sensitive paths
    const [httpRedirectFinding, tlsFindings, sensitivePathFindings] = await Promise.all([
      checkHttpToHttpsRedirect(targetUrl),
      checkTlsCertificate(targetUrl, fetchResult),
      checkSensitivePaths(targetUrl),
    ]);

    if (httpRedirectFinding) findings.push(httpRedirectFinding);
    findings.push(...tlsFindings);
    findings.push(...checkSecurityHeaders(fetchResult.finalUrl, fetchResult));
    findings.push(...checkServerDisclosure(fetchResult.finalUrl, fetchResult));
    findings.push(...checkCookieFlags(fetchResult.finalUrl, fetchResult));
    findings.push(...sensitivePathFindings);

    const finishedAt = new Date();

    const rawReport = {
      scannedUrl: targetUrl,
      finalUrl: fetchResult.finalUrl,
      statusCode: fetchResult.statusCode,
      redirectChain: fetchResult.redirectChain,
      responseHeaders: fetchResult.headers,
      findingCount: findings.length,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };

    return {
      findings,
      rawReport: {
        contentType: "application/json",
        body: JSON.stringify(rawReport, null, 2),
      },
      tool: "builtin_security@1.0",
      startedAt,
      finishedAt,
    };
  },
};
