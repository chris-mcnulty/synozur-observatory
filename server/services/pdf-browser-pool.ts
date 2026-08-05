import puppeteer, { Browser } from "puppeteer";
import { findChromiumPath } from "../utils/find-chromium";

let pdfBrowser: Browser | null = null;
let launching = false;
let launchQueue: Array<{ resolve: (b: Browser) => void; reject: (e: Error) => void }> = [];

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--single-process",
  "--no-zygote",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-sync",
  "--disable-translate",
  "--hide-scrollbars",
  "--mute-audio",
  "--disable-web-security",
  "--disable-features=IsolateOrigins,site-per-process",
  "--js-flags=--max-old-space-size=256",
  "--disable-software-rasterizer",
];

async function createBrowser(): Promise<Browser> {
  const executablePath = await findChromiumPath();
  console.log(`[PDF Pool] Launching dedicated PDF browser (chromium: ${executablePath || "auto-detect"})`);
  const startTime = Date.now();

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: LAUNCH_ARGS,
    timeout: 30000,
    protocolTimeout: 120000,
  });

  console.log(`[PDF Pool] Browser launched in ${Date.now() - startTime}ms`);

  browser.on("disconnected", () => {
    console.log("[PDF Pool] Browser disconnected, will recreate on next request");
    pdfBrowser = null;
  });

  return browser;
}

export async function getPdfBrowser(): Promise<Browser> {
  if (pdfBrowser) {
    try {
      if (pdfBrowser.connected) return pdfBrowser;
    } catch {}
    pdfBrowser = null;
  }

  if (launching) {
    return new Promise<Browser>((resolve, reject) => {
      launchQueue.push({ resolve, reject });
    });
  }

  launching = true;
  try {
    pdfBrowser = await createBrowser();
    for (const waiter of launchQueue) {
      waiter.resolve(pdfBrowser);
    }
    launchQueue = [];
    return pdfBrowser;
  } catch (err) {
    for (const waiter of launchQueue) {
      waiter.reject(err as Error);
    }
    launchQueue = [];
    throw err;
  } finally {
    launching = false;
  }
}

export async function closePdfBrowser(): Promise<void> {
  if (pdfBrowser) {
    try {
      await pdfBrowser.close();
    } catch {}
    pdfBrowser = null;
  }
}

export async function withPdfPage<T>(
  fn: (page: import("puppeteer").Page) => Promise<T>
): Promise<T> {
  const browser = await getPdfBrowser();
  const page = await browser.newPage();

  try {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "stylesheet", "font", "media"].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}
