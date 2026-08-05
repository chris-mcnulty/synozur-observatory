---
name: E2E API verification behind auth
description: How to verify auth-gated Orbit APIs when the browser preview only shows the login page
---

# E2E API verification behind auth

The app preview is login-gated, so screenshots always show the login screen. Reliable verification pattern:

- Log in via `POST /api/login` (not `/api/auth/login`) with curl; capture the `connect.sid` cookie from the `Set-Cookie` response header and pass it with `-H "Cookie: connect.sid=..."` on subsequent calls. The API auto-resolves the tenant from the user's email domain — no `X-Active-Tenant-Id` header needed.
- Use a dedicated test user (`e2e-test@synozur.com`). Set a temporary bcrypt hash via SQL (`UPDATE users SET password = $hash WHERE email = ...`), run verification, then immediately overwrite with a fresh random hash so no known credential remains.
- Restart the dev workflow after editing server-side code — the dev server does NOT hot-reload backend changes; stale handlers will mislead.
- AI provider calls return 404/500 in this dev environment ("Replit AI Integrations is not configured") — confirm in logs that the route reached the provider call before treating it as a code bug.
