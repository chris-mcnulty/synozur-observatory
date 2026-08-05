/**
 * Shared Chromium executable resolver used by headless-crawler, performance-scanner,
 * and pdf-browser-pool. Resolution order:
 *
 *   1. PUPPETEER_EXECUTABLE_PATH / CHROMIUM_EXECUTABLE_PATH env vars
 *   2. `which chromium` (works in Nix without knowing the store hash)
 *   3. Glob the Nix store for any chromium package bin (hash-agnostic)
 *   4. Common Linux paths
 *
 * This deliberately avoids hard-coding any Nix store hash so the resolver
 * stays correct when Chromium is upgraded and the hash changes.
 */

import * as fs from "fs";
import { execSync } from "child_process";

export async function findChromiumPath(): Promise<string | undefined> {
  // 1. Explicit env-var overrides
  const envOverrides = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROMIUM_EXECUTABLE_PATH,
  ].filter(Boolean) as string[];
  for (const p of envOverrides) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { continue; }
  }

  // 2. `which chromium` — resolves via PATH without needing the nix hash
  const whichCandidates = ["chromium", "chromium-browser", "google-chrome"];
  for (const bin of whichCandidates) {
    try {
      const resolved = execSync(`which ${bin} 2>/dev/null`, { encoding: "utf8" }).trim();
      if (resolved && fs.existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // not on PATH — continue
    }
  }

  // 3. Glob the Nix store for any chromium package bin (hash-agnostic)
  try {
    const nixStore = "/nix/store";
    if (fs.existsSync(nixStore)) {
      const entries = fs.readdirSync(nixStore);
      // Match packages like *-chromium-*.*.*/bin/chromium (not sandbox/patch entries)
      const chromiumDirs = entries
        .filter(e => /^[a-z0-9]+-chromium-[\d.]+$/.test(e))
        .sort()
        .reverse(); // prefer newest version first
      for (const dir of chromiumDirs) {
        const candidate = `${nixStore}/${dir}/bin/chromium`;
        try {
          if (fs.existsSync(candidate)) return candidate;
        } catch { continue; }
      }
    }
  } catch {
    // nix store unavailable — continue
  }

  // 4. Common Linux fallbacks
  const linuxPaths = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  for (const p of linuxPaths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { continue; }
  }

  return undefined;
}
