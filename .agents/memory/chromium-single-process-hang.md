---
name: Chromium --single-process CDP hangs in production
description: Why production puppeteer scans stalled at launch and the timeout/flag rules for all browser launch sites
---

**Rule:** Never pass `--single-process` to puppeteer launches; it causes CDP protocol hangs on Chromium 125 ("Timed out waiting for the WS endpoint URL", "Network.enable timed out") in the deployed VM even though it works in the dev container. Keep `--no-zygote`, `--no-sandbox`, `--disable-dev-shm-usage`.

**Why:** Production accessibility scans "never finished" — logs showed the 300s job timeout, but the real failure was Chromium never completing launch (30s puppeteer default). Switching Autoscale→Reserved VM did not fix it; removing `--single-process` did.

**How to apply:** Three launch sites share this config: headless-crawler, performance-scanner, pdf-browser-pool. The headless-crawler (accessibility path) must keep launch `timeout`/`protocolTimeout` ≤60s so a worst-case mid-scan relaunch at the last budget-allowed page (elapsed ~190s + 60s launch + 40s page) still fits the 300s job budget. Diagnose scan "timeouts" from deployment logs around `ChromeLauncher`/`Protocol error` lines before blaming CPU or budget.
