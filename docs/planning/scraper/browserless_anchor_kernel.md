# Browserless, Anchor Browser and Kernel as replacements for Bright Data's Browser API

All pages were read on 2026-11-12 unless a note says otherwise. Vendor docs were read through each vendor's `llms-full.txt` export: [Browserless](https://docs.browserless.io/llms-full.txt), [Anchor](https://docs.anchorbrowser.io/llms-full.txt) and [Kernel](https://www.kernel.sh/docs/llms-full.txt). Each finding cites the page URL that the export names for that section. "Summariser" marks a figure that reached me only through the WebFetch summariser and not as raw text. Kernel appears to have moved its site from onkernel.com to kernel.sh (inferred: docs live at kernel.sh, and third-party benchmarks still say "Onkernel"). The API host is still `api.onkernel.com` and the browser hosts are `*.onkernel.com` / `*.kernel.sh`.

## Connection: endpoint format, protocol, Playwright support, how the key is passed, REST-first or direct

### Takeaway

- **Browserless** is the only one that needs no REST step. You connect directly with a static token in `?token=` or in an `Authorization: Bearer` header on the WebSocket upgrade.
- **Anchor** needs a REST create (`anchor-api-key` header). Its WebSocket secret is still the static API key, in `wss://connect.anchorbrowser.io?apiKey=<key>&sessionId=<id>`, so query-param substitution fits. The create response, however, likely returns `cdp_url` with the real key embedded.
- **Kernel** needs a REST create (Bearer). Its WebSocket secret is dynamic: a per-session JWT on a per-session hostname. The host must create the browser, or let the VM see a session-scoped JWT.

### Cited Findings

**Browserless**

- Shared-fleet WebSocket roots are `wss://production-sfo.browserless.io`, `wss://production-lon.browserless.io` and `wss://production-ams.browserless.io`. Path routes include `/chromium/playwright`, `/chrome`, `/firefox/playwright` and `/webkit/playwright`. Private fleets (Enterprise) use hosts such as `chrome-eu-ams`. The page says "All endpoints require the `?token=` query parameter." — [Connection URLs](https://docs.browserless.io/overview/connection-urls) (summariser)
- Browserless works with "the standard Puppeteer `connect()` or Playwright `connectOverCDP()` methods". Playwright's native protocol is used only on `/firefox/playwright`, `/webkit/playwright` and `/edge/playwright`, and CDP clients belong on `/chromium` and `/chrome`. — [BaaS start](https://docs.browserless.io/baas/start) (summariser). This conflicts slightly with [Connection URLs](https://docs.browserless.io/overview/connection-urls), which lists `/chromium/playwright` as "Playwright native Chromium".
- Header auth on the cloud endpoint is documented. The chrome-devtools-mcp guide says: "**Header (recommended).** Pass the token as a Bearer header with `--wsHeaders`. This keeps the token out of the endpoint URL", with `--wsEndpoint=wss://production-sfo.browserless.io --wsHeaders='{"Authorization":"Bearer YOUR_API_TOKEN_HERE"}'`. The page says it was tested with chrome-devtools-mcp 1.12.0 against `wss://production-sfo.browserless.io`. — [Chrome DevTools MCP](https://docs.browserless.io/ai-integrations/chrome-devtools-mcp)
- The open-source server's `getTokenFromRequest` returns `tokenParam ?? getAuthHeaderToken(authHeader)`, and `getAuthHeaderToken` accepts `Basic <base64(token:)>` and `Bearer <token>`. The query parameter takes precedence over the header. The repo is at `"version": "2.62.0"`, `"license": "SSPL"`. — [browserless/browserless src/utils.ts](https://github.com/browserless/browserless/blob/main/src/utils.ts) and [package.json](https://github.com/browserless/browserless/blob/main/package.json) (raw source read)
- The official Playwright MCP recipe uses a direct CDP URL with no REST step: `npx -y @playwright/mcp@latest --cdp-endpoint "wss://production-sfo.browserless.io/stealth?token=YOUR_API_TOKEN&solveCaptchas=true"`. Its documented query parameters include `timeout`, `proxy=residential` and `blockAds`. — [Playwright MCP for Claude Code](https://docs.browserless.io/ai-integrations/claude-code-playwright-mcp)
- Direct connect needs no session creation: the endpoints "launch a browser and hand control back to your library". — [Connection URLs](https://docs.browserless.io/overview/connection-urls) (summariser)
- REST session creation is optional, for persistence. `POST https://production-sfo.browserless.io/session?token=...` returns `connect`, a `wss://` URL "with the token pre-embedded", and `stop`, an HTTPS URL that also has the token embedded. — [Persisting state](https://docs.browserless.io/baas/session-management/persisting-state) (summariser)
- `POST /profile?token=...` returns `"connect": "wss://production-sfo.browserless.io/session/connect/<id>?token=..."`. — [Authenticated Profiles](https://docs.browserless.io/baas/features/authenticated-profiles)

**Anchor Browser**

- REST calls send the API key "in the `anchor-api-key` header on every call". Flow: `POST https://api.anchorbrowser.io/v1/sessions`, whose response includes `id`, `cdp_url` and `live_view_url`; you then connect Playwright or Puppeteer to `cdp_url`. — [For agents](https://docs.anchorbrowser.io/for-agents) (summariser)
- The documented WebSocket form carries the key in the query: `p.chromium.connect_over_cdp(f'wss://connect.anchorbrowser.io?apiKey={ANCHOR_API_KEY}&sessionId={session_id}')`. — [Code Quick Start](https://docs.anchorbrowser.io/quickstart/use-via-code)
- One page shows a direct connect with no `sessionId`: `chromium.connectOverCDP(`wss://connect.anchorbrowser.io?apiKey=${ANCHOR_API_KEY}`)`. — [Custom agent framework](https://docs.anchorbrowser.io/agent-frameworks/custom-agent-framework). It is not documented which session configuration (proxy, profile, stealth) such a connection gets.
- "Never log `session.data.cdp_url` — it carries the API key in the query string." — [Sandboxes integration](https://docs.anchorbrowser.io/integrations/sandboxes). This is contradicted by the webhook example `"cdp_url": "wss://connect.anchorbrowser.io?sessionId=ses_8d2c1fda"`, which has no key — [Webhook events](https://docs.anchorbrowser.io/webhooks/events). The API reference describes `cdp_url` only as "The CDP websocket connection string" — [Start browser session API](https://docs.anchorbrowser.io/api-reference/browser-sessions/start-browser-session) (summariser).
- The egress allowlist for sandboxes is `https://api.anchorbrowser.io`, `wss://connect.anchorbrowser.io` and `https://live.anchorbrowser.io`. — [Sandboxes integration](https://docs.anchorbrowser.io/integrations/sandboxes)
- Closing the Playwright connection does not end the Anchor session. "the cloud browser stays active until it times out or you call End Browser Session". — [Code Quick Start](https://docs.anchorbrowser.io/quickstart/use-via-code)

**Kernel**

- The REST API is `https://api.onkernel.com` and its security scheme is `bearerAuth` (`Authorization: Bearer <API key>`). The Browser schema's `cdp_ws_url` example is `wss://proxy.yul-upbeat-herschel.onkernel.com:8443/browser/cdp?jwt=eyJ0eXAi...`. — [Kernel OpenAPI spec](https://api.onkernel.com/spec.json) (raw JSON read)
- All docs examples create the browser via SDK/REST first, then `chromium.connectOverCDP(kernelBrowser.cdp_ws_url)`. — [Regional browsers](https://www.kernel.sh/docs/browsers/regions); [Apps develop](https://www.kernel.sh/docs/apps/develop)
- "treat the connection urls as credentials; anyone with them can access the browser while it is active." — [MPP](https://www.kernel.sh/docs/info/mpp)
- "Websocket connections typically can remain active for up to 1 hour, after which they may close automatically... reconnect to the same `cdp_ws_url`." Also: "Browsers persist independently of CDP." — [Browsers FAQ](https://www.kernel.sh/docs/browsers/faq)
- The CSP/egress allowlist is `wss://*.onkernel.com`, `wss://*.kernel.sh`, `wss://*.onkernel.com:8443` and `wss://*.kernel.sh:8443`. Kernel says not to copy a single hostname, "because that hostname can change between sessions". — [Allowlist KERNEL domains](https://www.kernel.sh/docs/info/network-access); the same list is in [Live view](https://www.kernel.sh/docs/browsers/live-view)
- Kernel also exposes `webdriver_ws_url` (WebDriver BiDi). — [MPP](https://www.kernel.sh/docs/info/mpp). Browsers can be driven "with Playwright, other browser automation frameworks, computer controls, or CDP and WebDriver BiDi directly". — [Kernel docs home](https://www.kernel.sh/docs) (summariser)
- `browser.close()` from Playwright does not delete the Kernel browser. — [Termination & Timeouts](https://www.kernel.sh/docs/browsers/termination)

### Inferences

- **Browserless** is the best fit for T45's placeholder-substitution proxy. The VM can call `chromium.connectOverCDP('wss://production-ams.browserless.io/stealth?proxy=residential&proxyCountry=de&solveCaptchas=true&profile=<name>', { headers: { Authorization: 'Bearer <placeholder>' } })`, and the host proxy swaps the header value. The query-param form (`?token=<placeholder>`) would also work, since the open-source code shows the query param overrides the header. Either way the secret is static, so a fixed substitution works.
- **Browserless trap:** avoid letting the VM call `POST /session` or `POST /profile` through the substituting proxy. Their `connect` and `stop` URLs come back with the real token embedded, so the VM would see it unless the proxy also rewrites response bodies.
- **Anchor:** the VM can create the session through the proxy, which substitutes the `anchor-api-key` header. But the `cdp_url` in the response probably carries the real API key (per the sandboxes page). The simplest safe design is untested. The host broker creates the session, using its proxy, profile, identity and stealth settings, and passes only the non-secret `id` to the VM. The VM then builds `wss://connect.anchorbrowser.io?apiKey=<placeholder>&sessionId=<id>`, and the host proxy substitutes the static key in the query of the upgrade request. This needs neither header support nor response rewriting.
- **Kernel:** the REST create call fits header substitution (`Authorization: Bearer`). The CDP URL then carries a per-session JWT on a per-session hostname at port 8443, so the secret used at connect time is dynamic and not the account key. If the VM makes the create call itself, it receives only a session-scoped JWT, not the API key. That is a lesser exposure, but the proxy cannot predict the value in advance.
- None of the three documents a Playwright-protocol (`browserType.connect`) Chromium endpoint for stealth use. For Chromium, all three assume `connectOverCDP`. Browserless has a `/chromium/playwright` route but documents its stealth and proxy features on CDP routes.

### Gaps

- Anchor: no doc says whether `wss://connect.anchorbrowser.io` accepts `anchor-api-key` (or any header) on the WebSocket upgrade instead of `?apiKey=`. This needs a test once an account exists.
- Anchor: the exact `cdp_url` returned by create is unconfirmed, since the docs disagree on whether `apiKey` is present.
- Kernel: no doc says whether the CDP endpoint accepts an API-key header instead of `?jwt=`, or how long the JWT lives. The `jwt` grep found no lifetime.
- Browserless: whether `profile=`, `proxy=` and `solveCaptchas=` work on the `/chromium/playwright` (Playwright-protocol) route is not documented.

## Logins: restrictions on password entry or logged-in scraping, KYC/compliance gates, ToS clauses

### Takeaway

None of the three documents a restriction on password entry or logging in like Bright Data's. Their upstream proxy vendors are unknown, so this is "none documented", not "none". All three document and market login flows: Browserless Authenticated Profiles and 1Password autologin, Anchor Identities, Kernel Managed Auth and Vaults. In the docs and terms I searched I found no KYC or compliance-approval gate in Browserless or Anchor. Kernel's AUP is the most explicit: it allows logins with credentials you own or are authorised to use. It also reserves "identity or business verification" for proxy capacity, and its upstream proxy providers block some destinations, including "Select e-commerce platforms".

### Cited Findings

**Browserless**

- The docs show logging in through a cloud session: `await page.type('#password', process.env.PASSWORD)`, followed by `Browserless.saveProfile`. — [Authenticated Profiles](https://docs.browserless.io/baas/features/authenticated-profiles)
- 1Password integration: "fill secrets (usernames, passwords, API keys) straight from your vault **without the value ever reaching your automation code**". It can also fetch emailed one-time codes, and "Autologin" signs in and saves a profile automatically. — [1Password](https://docs.browserless.io/baas/features/1password)
- ToS Section 11, Prohibited uses, includes "(h) to collect or track the personal information of others; (i) to spam, phish, pharm, or pretext; ... (k) to interfere with or circumvent the security features of the Service or any related website, other websites, or the Internet." The ToS has no clause on logins or passwords. — [Browserless Terms of Service](https://www.browserless.io/terms-of-service) (no last-updated date shown; operator "browserless.io, Inc."; governing law "Battle Ground, WA")
- ToS Section 2: "You agree not to reproduce, duplicate, copy, sell, resell or exploit any portion of the Service, use of the Service, or access to the Service ... without express written permission". — [Browserless Terms of Service](https://www.browserless.io/terms-of-service)
- No KYC, identity-verification or compliance-review requirement turned up in the full docs export (grep for KYC/identity verification/compliance) or in the proxy page. — [Proxies](https://docs.browserless.io/baas/bot-detection/proxies) (summariser: "The page doesn't mention KYC or identity verification")
- A "relevance and abuse gate" exists, but only for the Browserless agent task API. It rejects tasks "that request a prohibited use". — [Browserless docs export](https://docs.browserless.io/llms-full.txt) (browserless_agent REST section)
- `proxyPreset`: `px_gov01` targets government sites and `px_ipv6` targets Google domains, both residential only. This hints that some destinations need special handling on the residential pool. — [Proxies](https://docs.browserless.io/baas/bot-detection/proxies) (summariser)

**Anchor Browser**

- Managed authentication is built from Applications, Auth flows and Identities. An Identity "Stores credentials and validated session state. Attach an identity when creating a session and the browser starts already signed in." Login modes are Auto-Discovery, Preset (username/password, email OTP, authenticator) and Manual. — [Managed authentication](https://docs.anchorbrowser.io/essentials/managed-authentication)
- What an identity can store: "Username/password, TOTP secrets, 1Password refs, email MFA mailbox, custom fields". If a "Browser profile expired / re-auth requested, credentials available — Anchor runs the application's auth flow using stored credentials". — [Identities](https://docs.anchorbrowser.io/essentials/authenticated-applications)
- "identities are managed logins; Anchor signs in, handles MFA, and keeps credentials in its vault." — [Anchor MCP](https://docs.anchorbrowser.io/advanced/mcp). This contradicts the security page: "customers are never required to store credentials on our platform" — [Trust & Security](https://docs.anchorbrowser.io/security). The word "required" may reconcile the two.
- "Authenticated browsers" are not on Free. They start on Starter ($50/mo). — [Anchor pricing (docs)](https://docs.anchorbrowser.io/pricing); [anchorbrowser.io homepage pricing](https://anchorbrowser.io/) ("Authenticated (Logged in) Browsers" under Starter)
- The website Terms of Use ("Last updated: March 16, 2025") cover the website only. Use of the SaaS "may be subject to the payment of applicable license fees, all as specified in the Anchor Subscription Agreement". — [Anchor Terms of use](https://anchorbrowser.io/terms)
- The SaaS terms ("Anchor Browser Application Terms of use, Last updated: May 25th, 2025", with "ANCHOR FORGE INC.") include these Subscription Restrictions: "(b) sell, assign, transfer, lease, rent, sublicense, or otherwise distribute or make available the Service to any third party (such as offering it as part of a time-sharing, outsourcing or service bureau environment) ... (g) circumvent, disable or otherwise interfere with security-related or technical features or protocols of the Service". Customer Data must not include information "which violates any third party rights ... or otherwise is malicious or fraudulent". Governing law is New York, with ICC arbitration. — [Anchor SaaS terms 05-25-2025](https://anchorbrowser.io/saas-terms-05-25-2025). The dated URL suggests a newer version could exist, but I found none.
- No KYC, abuse-review or domain-restriction text turned up in the docs export (grep for kyc/abuse/restricted domain/identity verification). — [Anchor docs export](https://docs.anchorbrowser.io/llms-full.txt)
- The marketing FAQ says Anchor balances AI capability "with stringent anti-abuse and user management mechanisms". No details are given. — [anchorbrowser.io](https://anchorbrowser.io/)

**Kernel**

- AUP principle: "**If a person may lawfully browse a site and take an action on it, their agent may too.** ... We do not maintain a general list of approved use cases, and we do not require you to justify why your agent is visiting a site." — [Kernel Acceptable Use Policy](https://www.kernel.sh/docs/acceptable-use) (Last Modified: September 15, 2026)
- AUP prohibited use: "**Access accounts you are not authorized to use.** Credential stuffing, brute-forcing logins, session hijacking, or logging into accounts without the account holder's authorization. This does not prohibit using credentials you own, or that a user has authorized you to use on their behalf." — [Kernel AUP](https://www.kernel.sh/docs/acceptable-use)
- AUP prohibited uses also include "**Farm accounts on other services**", "**Resell the network** ... as a standalone proxy, VPN, or tunneling product", and "**Harvest training data against a site's terms**". You are "responsible for your relationship with the sites you visit, including their terms of use, their `robots.txt`". — [Kernel AUP](https://www.kernel.sh/docs/acceptable-use)
- Verification gate: "We may require a verified payment method, a verified email domain, or reasonable identity or business verification before granting or continuing access to free credit, higher concurrency, or proxy capacity." — [Kernel AUP](https://www.kernel.sh/docs/acceptable-use)
- Restricted proxy destinations, imposed by upstream providers: Government, "Banking and financial services", "Payment processors", "National postal services", "Adult content", "Direct IP addresses", "Select e-commerce platforms | Evaluated by the provider case by case". The AUP adds: "**Nothing in the table above is prohibited by this policy.** These are destinations our proxy networks will not carry". Restricted destinations "are frequently reachable without a Kernel proxy — either directly or through a custom proxy you supply". Exceptions are requested via security@kernel.sh with a business purpose and "any verification information", and "We cannot guarantee that an exception will be granted". — [Kernel AUP](https://www.kernel.sh/docs/acceptable-use)
- ToS 2.8: "The acceptable use policies and destination restrictions of those providers apply to Customer's use of Company-Provided Proxy Services and may be modified by those providers without notice to Company or Customer." — [Kernel Terms of Service](https://www.kernel.sh/docs/tos) (Last Modified: September 1, 2026; Kernel Technologies, Inc., Delaware; California law, San Francisco courts)
- ToS 3.4(d) forbids "time-share or use the Services in any service bureau arrangement or otherwise for the benefit of any third party, provided that Customer may use the Services to provide Customer's own products and services to Customer's end users in the ordinary course of Customer's business". — [Kernel Terms of Service](https://www.kernel.sh/docs/tos)
- Managed Auth and Vaults: "an agent can use Vaults to sign in without receiving raw credential values". — [Profiles](https://www.kernel.sh/docs/browsers/profiles)

### Inferences

- **Bright Data blocker:** Bright Data's specific problem (password entry blocked until KYC) does not appear in any of the three. Login is a headline feature for Anchor (Identities) and Kernel (Managed Auth), and Browserless documents it for Authenticated Profiles.
- **Kernel proxy risk for amazon.de:** Kernel's proxy layer is the main risk. Its upstream providers block "Select e-commerce platforms" case by case, and the AUP does not say whether Amazon is on the list. Kernel's mitigations are residential routing to an alternative provider, or bring-your-own proxy (Start-Up plan and above).
- **Third-party use clauses:** Anchor's clause (b), Browserless's "resell or exploit" clause and Kernel's 3.4(d) all restrict making the service available to third parties. Kernel explicitly carves out use for "Customer's end users". Anchor's docs market an "Agent platform" use case and partner BYOK, but its terms have no such carve-out. A multi-tenant platform like T45 should confirm this with Anchor.
- **Upstream proxy vendors unknown:** none of the three names its residential proxy vendor. Bright Data-style upstream restrictions, such as login or KYC rules on the residential pool, could therefore still apply to Browserless and Anchor proxies without being documented. Kernel is the only one that admits upstream blocklists.

### Gaps

- None of the three publishes its residential/mobile proxy upstream vendors. Kernel's subprocessor list at trust.kernel.sh is JavaScript-rendered and was not retrievable.
- I found no Anchor or Browserless acceptable-use policy separate from their terms.
- Whether amazon.de is on Kernel's upstream "select e-commerce" blocklist is not published.

## Persistent logged-in state: profiles, sessions, vaults; lifetime, storage location, encryption

### Takeaway

All three persist cookies and storage across sessions. Browserless uses named "Authenticated Profiles" (cookies, localStorage, IndexedDB) loaded with `?profile=<name>` on a direct connect, plus a TTL-bound Session API of up to 90 days on Scale. Anchor uses `browser.profile {name, persist}` plus Identities that re-authenticate automatically. Kernel uses Profiles holding the whole Chromium user-data dir, "encrypted end to end using a per-organization key", plus Managed Auth health checks and automatic re-login. None of the three documents how long a saved profile is retained.

### Cited Findings

**Browserless**

- What a profile captures: cookies "including HttpOnly, Secure, and SameSite attributes", `localStorage` "for every origin the session touched", and `IndexedDB`. `sessionStorage` is excluded. Usage is to pass `?profile=<profile-name>`. Profiles are "scoped to your API token". Changes made during a session "won't affect the original profile". — [Authenticated Profiles](https://docs.browserless.io/baas/features/authenticated-profiles)
- Creating a profile: via the dashboard ("Sign in via remote browser", with an optional proxy for the login session), or via `POST /profile`, then `Browserless.saveProfile` over CDP. Updating uses `Browserless.refreshProfile` or `overwrite: true`. Profiles can also be created from JSON cookies. — [Authenticated Profiles](https://docs.browserless.io/baas/features/authenticated-profiles)
- Profiles saved from a Browserless browser remember its `User-Agent` and `Accept-Language`, for "sites that tie logins to the browser". — [Authenticated Profiles](https://docs.browserless.io/baas/features/authenticated-profiles)
- The 1Password-plus-profile pattern fills credentials, signs in and calls `Browserless.saveProfile` "in **one** session". Later sessions use `wss://production-sfo.browserless.io?token=...&profile=acme-prod`. — [1Password](https://docs.browserless.io/baas/features/1password)
- Session API (a separate mechanism): a persisted `userDataDir` with an explicit `ttl`. The maximum TTL is Free 1 day, Prototyping 7 days, Starter 30 days and Scale 90 days. Only one client can attach at a time; a second client gets a 429. — [Persisting state](https://docs.browserless.io/baas/session-management/persisting-state) (summariser). The pricing page shows the same "Persisted sessions & replays" values — [Pricing](https://www.browserless.io/pricing) (summariser).
- Encryption at rest for profiles or the Session API is not stated. Only the 1Password service-account token is "encrypted at rest". — [1Password](https://docs.browserless.io/baas/features/1password). The trust page says sensitive datastores "are encrypted at rest using encryption mechanisms provided by the underlying cloud infrastructure", and customer data is "primarily stored in the United States via AWS, DigitalOcean, and Supabase". — [Browserless Trust](https://www.browserless.io/trust) (summariser; last updated September 11, 2026)

**Anchor Browser**

- Browser profiles "persist cookies, local storage, and cache". You set `persist: true` on first use, then end the session to save. "profiles do not store credentials or re-authenticate automatically." — [Managed authentication](https://docs.anchorbrowser.io/essentials/managed-authentication)
- Identities re-authenticate automatically when credentials are stored. Manual-login identities work only "until the site expires" the session. Re-auth links come from `POST /v1/identities/{identityId}/reauth-links`. — [Identities](https://docs.anchorbrowser.io/essentials/authenticated-applications)
- A Dedicated Sticky IP reserves one egress IP per profile. "Extra Stealth mode is automatically enabled for all sessions using a Dedicated Sticky IP profile." — [Dedicated Sticky IP](https://docs.anchorbrowser.io/advanced/dedicated-sticky-ip)
- Storage and encryption: "any essential configuration data or account information stored on our platform is encrypted at rest using AES-256". Data lives in AWS `us-east-2`, or in `eu-central-1` (Frankfurt) on Growth. — [Trust & Security](https://docs.anchorbrowser.io/security)
- `browser.profile.persist` defaults to `false`. No retention or expiry is documented. — [Start browser session API](https://docs.anchorbrowser.io/api-reference/browser-sessions/start-browser-session) (summariser)

**Kernel**

- "Profiles capture the browser's user-data directory, including: Cookies and authenticated sessions; Local storage and other site data; Open tabs and browsing state; Browser preferences". "Profile data is encrypted end to end using a per-organization key." Changes save only with `save_changes: true`, when the browser is deleted or times out, or via an explicit save of a running browser. — [Profiles](https://www.kernel.sh/docs/browsers/profiles)
- "Profile saves replace the complete stored snapshot and don't merge concurrent changes." — [Save and reuse profile state](https://www.kernel.sh/docs/browsers/profiles/save-and-reuse)
- Managed Auth "monitors the connection and can attempt automatic reauthentication for eligible flows". "recovery isn't guaranteed. if the site requires an email or sms code, approval, or another user action, your application must bring the user back". — [Managed Auth](https://www.kernel.sh/docs/auth/managed-auth)
- The minimum health-check interval is 6 h on Developer, 1 h on Hobbyist and 20 min on Start-Up. — [Concurrency and Limits](https://www.kernel.sh/docs/browsers/concurrency-and-limits). Managed Auth connections: 3 on Developer, unlimited on paid plans. — [Kernel Pricing](https://www.kernel.sh/docs/info/pricing)
- Platform encryption: "at rest (AES-256) using cloud provider key management services". — [Kernel Security Practices](https://www.kernel.sh/docs/security)

### Inferences

- **Browserless fit:** Browserless's `?profile=` parameter on the direct-connect URL lets T45 reuse logins with no REST step. Saving a profile needs a custom CDP command, `Browserless.saveProfile`. Playwright CLI is unlikely to send that, so a host-side step or the dashboard flow would capture logins.
- **Kernel and Anchor fit:** both attach profiles at REST create time, which matches a host-side broker that creates sessions.
- **Browser identity:** Kernel's full user-data-dir snapshot keeps more state than Browserless's cookie/localStorage/IndexedDB capture. That may help on sites that bind sessions to the device.

### Gaps

- None of the three documents how long a saved profile is kept when unused. Browserless's 1–90-day figure applies to Session API sessions; whether it also applies to Authenticated Profiles is unclear.
- Browserless does not say whether `Browserless.saveProfile` works on any direct-connect session or only on `POST /profile` creation sessions. The 1Password example suggests any session.
- Anchor does not document where profiles are stored (presumably AWS us-east-2 by default) or whether they are encrypted.

## Proxies: residential, mobile, datacenter; Germany, city, sticky; bring-your-own

### Takeaway

All three can exit from Germany. Browserless uses `proxy=residential&proxyCountry=de`; city targeting needs Scale. Anchor offers `country_code: 'de'` in its listed country table, plus region and city on `anchor_proxy`. Kernel's `country: 'DE'` works on residential and mobile, and DE is one of five ISP countries. Only Kernel explicitly documents mobile proxies. All three support bring-your-own proxy, but on paid tiers.

### Cited Findings

**Browserless**

- `proxy=residential` costs 6 units/MB and `proxy=datacenter` costs 2 units/MB. `proxyCountry` takes ISO codes. `proxyCity` "requires a Scale plan (500k+ units). Plans under 500k units will receive a `401` error." `proxySticky=true` pins the exit IP. "Stealth routes ... all BrowserQL endpoints, `/unblock`, `/scrape`, and any request with `?stealth=true` are **sticky by default**". — [Proxies](https://docs.browserless.io/baas/bot-detection/proxies)
- Germany example: `wss://production-sfo.browserless.io/stealth?token=...&proxy=residential&proxyCountry=de&proxyLocaleMatch=1`. `proxyLocaleMatch` sets browser language to the proxy location and works only on stealth routes. — [Proxies](https://docs.browserless.io/baas/bot-detection/proxies)
- Bring your own proxy: `externalProxyServer=http(s)://[user:pass@]host:port`, HTTP(S) only. SOCKS5 works via the `--proxy-server` launch flag without auth. It requires a paid plan ("Only paid cloud-unit plans can utilize a third-party proxy"). — [Proxies](https://docs.browserless.io/baas/bot-detection/proxies) (summariser)
- Mobile proxies are not mentioned. — [Proxies](https://docs.browserless.io/baas/bot-detection/proxies) (summariser)

**Anchor Browser**

- Configuration is `session.proxy: { active: true, country_code: 'de', ... }`. "You can change `country_code` to any supported country (e.g., 'gb', 'de', 'jp')". Germany `de` is in the Anchor Proxy country table. `region` and `city` are "only supported for the default proxy type (`anchor_proxy`)". — [Proxy](https://docs.anchorbrowser.io/advanced/proxy)
- The task example uses `"type": "anchor_residential"`. — [Proxy](https://docs.anchorbrowser.io/advanced/proxy). The API reference `ProxyConfig` enum lists only `anchor_proxy` and `custom`. — [Start browser session API](https://docs.anchorbrowser.io/api-reference/browser-sessions/start-browser-session) (summariser). This is a conflict.
- The MCP page claims "residential and mobile proxies by country". — [Anchor MCP](https://docs.anchorbrowser.io/advanced/mcp). The network overview says "built-in residential-style routing with country/region/city targeting". — [Network and stealth overview](https://docs.anchorbrowser.io/network-and-stealth/overview)
- Bring-your-own proxy uses `type: 'custom'` with HTTP, HTTPS or SOCKS5 and username/password. — [Bring Your Own Proxy](https://docs.anchorbrowser.io/advanced/bring-your-own-proxy). It is on Growth per the [docs pricing](https://docs.anchorbrowser.io/pricing), but the [homepage pricing](https://anchorbrowser.io/) lists "Custom proxy" on a $500/mo Team tier. This is a conflict.
- Other options are Dedicated Sticky IP per profile ([Dedicated Sticky IP](https://docs.anchorbrowser.io/advanced/dedicated-sticky-ip)) and "Anchor VPN" for a private egress path at enterprise volume ([Network and stealth overview](https://docs.anchorbrowser.io/network-and-stealth/overview)).
- "Anchor Browser infrastructure is fully hosted in the US." — [Proxy](https://docs.anchorbrowser.io/advanced/proxy)

**Kernel**

- Proxy types are ISP, Residential, Mobile and Custom. "ISP ... with country targeting in the United States (`US`), Singapore (`SG`), the United Kingdom (`GB`), France (`FR`), and Germany (`DE`)." ISP gives "a **static exit IP that persists across sessions**". "Kernel-provided proxies are unmetered and not billed". — [Proxies overview](https://www.kernel.sh/docs/proxies/overview)
- Residential takes `country` (ISO 3166), `state` (US only), `city`, `zip` (US) and `asn`. Traffic goes across multiple providers, and "Different destinations within a browser session may use different providers and exit IPs". "If you need a consistent exit IP across connections and browser sessions, use an ISP proxy instead." — [Residential Proxies](https://www.kernel.sh/docs/proxies/residential)
- Mobile proxies are "Only recommended in advanced stealth use cases". Country targeting is reliable, while city and state are best-effort. — [Mobile Proxies](https://www.kernel.sh/docs/proxies/mobile)
- The stealth-mode default proxy is "an ISP proxy from a shared Kernel pool, providing a stable exit IP for the session". — [Stealth Mode](https://www.kernel.sh/docs/browsers/bot-detection/stealth)
- Plan gating: "Configurable proxies" are not on Developer (free) but are on Hobbyist and above. "BYO proxies" start at Start-Up. — [Kernel Pricing](https://www.kernel.sh/docs/info/pricing)
- The AUP's proxy fair-use rules and upstream restricted destinations apply (see Logins). — [Kernel AUP](https://www.kernel.sh/docs/acceptable-use)

### Inferences

- **Germany coverage:** for amazon.de from a German IP, Kernel offers the most choice: a DE ISP proxy that is static across sessions, DE residential or DE mobile. That is offset by its upstream e-commerce restriction. Browserless and Anchor support DE residential-style IPs. Anchor's pool may not be truly residential: the enum conflict and the "residential-style" wording leave it unclear.
- **Logged-in sessions:** a stable IP across sessions matters for staying logged in. Kernel ISP and Anchor Dedicated Sticky IP provide one. Browserless's sticky option holds the IP within a session only.

### Gaps

- Browserless's full country list (`proxy-countries.json`) was not retrieved. DE appears only in an example.
- Anchor: whether `anchor_proxy` is residential, datacenter or mixed is unclear, and mobile proxies are documented only in a one-line MCP claim.
- None of the three names its proxy suppliers.

## Anti-bot: stealth, fingerprinting, CAPTCHA solving, evidence for Amazon

### Takeaway

All three ship stealth fingerprints and automatic CAPTCHA solving. Browserless has the broadest documented CAPTCHA type list, which includes `amazonWaf`. Anchor gates its "full stealth solution" behind Growth ($2,000/mo) and requires a proxy for stealth and CAPTCHA. Kernel includes stealth and the CAPTCHA solver on every plan. The only stealth benchmarks are vendor-published or from a single small test. I found no amazon.de-specific evidence for any of the three.

### Cited Findings

**Browserless**

- Stealth routes: `/stealth` ("advanced anti-detection and realistic fingerprinting ... entropy injection"), `/chromium/stealth` and `/chrome/stealth`. They are meant for bot-detection problems and "can produce unexpected results for some tasks". — [Stealth](https://docs.browserless.io/baas/bot-detection/stealth) (summariser)
- CAPTCHA: `solveCaptchas=true` turns on automatic solving. The `Browserless.captchaFound` and `Browserless.captchaAutoSolved` CDP events and the manual `Browserless.solveCaptcha` command are available. "Each successful CAPTCHA solve costs 10 units; attempts that don't clear aren't charged." — [CAPTCHA solving](https://docs.browserless.io/baas/bot-detection/captchas) (summariser)
- Accepted `type` values for `Browserless.solveCaptcha`: "`recaptcha`, `recaptcha-invisible`, `recaptcha-enterprise`, `recaptcha-v3`, `recaptcha-v3-enterprise`, `hcaptcha`, `hcaptcha-invisible`, `cloudflare`, `datadome`, `perimeterx`, `akamai`, `amazonWaf`, `geetest`, `funcaptcha`, `friendlycaptcha`, `mtcaptcha`, and others. Auto-detection doesn't see Cloudflare's interstitial challenge page". — [CDP extensions API reference](https://docs.browserless.io/api-reference/cdp-extensions)
- The vendor's Amazon example uses the stealth route with `proxy=residential&proxyCountry=us`. It says "Amazon aggressively blocks automated browsers with CAPTCHAs and fingerprinting", with no success-rate claim. — [Scrape Amazon example](https://docs.browserless.io/examples/scrape-amazon) (summariser)
- A forum user (achamm, May 24, 2026) wrote: "Browserless can sometimes get through but it's hit-or-miss against Amazon's detection". This was about the Swiship (Amazon logistics) tracking page, not amazon.de. — [n8n community thread](https://community.n8n.io/t/browserless-http-request-node-loading-indefinitely-when-scraping-swiship-amazon-tracking/295812)

**Anchor Browser**

- "Extra Stealth mode is available on the Growth plan." It "requires proxy configuration to be active. **If proxy is disabled, extra stealth will be automatically disabled**". — [Stealth](https://docs.anchorbrowser.io/essentials/stealth)
- CAPTCHA solving is "vision-based ... along with extension-based fallbacks ... to solve any CAPTCHA (including Cloudflare)". It "requires either an active proxy or a configured browser profile". A text-CAPTCHA mode takes `image_selector` and `input_selector`. — [CAPTCHA solving](https://docs.anchorbrowser.io/advanced/captcha-solving)
- Plans: "Automated captcha bypass" is on Starter and above, and "Full stealth solution" on Growth and above. "Unique fingerprinting" is Enterprise only. — [Anchor pricing (docs)](https://docs.anchorbrowser.io/pricing)
- Cloudflare Web Bot Auth (signed verified-bot identity) is on Growth. — [Network and stealth overview](https://docs.anchorbrowser.io/network-and-stealth/overview); [Anchor pricing (docs)](https://docs.anchorbrowser.io/pricing)
- Amazon appears only as a generic example, with no anti-bot claim about it: an action-index entry, "finding products on Amazon" — [Action index](https://docs.anchorbrowser.io/advanced/action-index); and an `amazon.com/dp/...` extraction example — [SDK quick start](https://docs.anchorbrowser.io/quickstart/use-via-sdk)

**Kernel**

- "All Kernel browsers ship with anti-detection optimizations by default". `stealth: true` adds the default ISP proxy plus an "**Automatic CAPTCHA solver** — solves reCAPTCHAs, Cloudflare challenges, and similar tests automatically". — [Stealth Mode](https://www.kernel.sh/docs/browsers/bot-detection/stealth)
- The solver "attempts supported challenges — reCAPTCHA, hCaptcha, Cloudflare/Turnstile, and press-and-hold". "The solver runs in the VM". Telemetry events are `captcha_solve_started`, `captcha_solve_result` and `captcha_challenge_result`. — [Pausing for Captcha Solves](https://www.kernel.sh/docs/browsers/telemetry/pausing-for-captcha-solves)
- "Managed stealth mode" is available on every plan, including Developer (free). — [Kernel Pricing](https://www.kernel.sh/docs/info/pricing)
- Web Bot Auth is opt-in "on request for Startup Plan and Enterprise Plan customers". — [Stealth Mode](https://www.kernel.sh/docs/browsers/bot-detection/stealth)
- Kernel's own benchmark page covers latency only, against Browserbase only (Kernel avg 793.84 ms vs Browserbase 2966.87 ms), and is undated. — [Kernel benchmarks](https://www.kernel.sh/benchmarks) (summariser; vendor-published)

**Secondary, independent or competitor evidence (labelled)**

- Ritza/techstackups hosted-browser benchmark (published March 6, 2026, updated May 31, 2026; free tiers, run from a Hetzner server in Helsinki, one run per provider per mode):
  - Kernel: fingerprint checks passed in default and stealth; reCAPTCHA v3 score 0.1 default, 0.3 stealth; CAPTCHA solved in 38.5 s.
  - Browserless: fingerprint checks failed by default and passed in stealth; reCAPTCHA v3 0.3 (stealth only); CAPTCHA solved in 17.3 s.
  - Anchor: fingerprint checks passed; reCAPTCHA v3 0.3; CAPTCHA solving not available on the free tier.
  - No Amazon test. — [techstackups hosted browser benchmarks](https://techstackups.com/comparisons/hosted-browser-benchmarks/) (summariser; author's affiliation with vendors undisclosed)
- Browser Use stealth benchmark (March 2026, 71 anti-bot-protected sites, published by a competing vendor): Browser Use Cloud 81%, Anchor 77%, "Onkernel" 67%; Browserless not tested. — [Browser Use stealth benchmark](https://browser-use.com/posts/stealth-benchmark) (figures from search snippets only, not fetched; unverified)
- Spider's Browser Fidelity Bench (competitor): Anchor 74%, Onkernel 68%. — [Spider stealth benchmark](https://spider.cloud/blog/spider-browser-stealth-benchmark/) (search snippet only; unverified)

### Inferences

- **No evidence for the target site:** whether any of the three reads amazon.de search and product pages reliably from a German IP is unproven. A trial against the real target is required.
- **Amazon WAF:** Browserless is the only one that names Amazon WAF (`amazonWaf`) as a solvable CAPTCHA type.
- **Cost of stealth:** Anchor's strongest stealth tier costs $2,000/mo, while Kernel's and Browserless's stealth is available on low or free tiers.

### Gaps

- No independent, Amazon-specific (let alone amazon.de) success-rate data exists for any of the three.
- I found no GitHub issues on Browserless, Anchor or Kernel about Amazon blocking.

## Concurrency, session limits, regions, data retention, GDPR/DPA/SOC 2, self-hosting

### Takeaway

- **EU execution:** Browserless runs browsers in the EU (Amsterdam) on every plan, but stores data mainly in the US. Kernel offers `eu-west` from the $200/mo Start-Up plan. Anchor runs in the US (Ohio) by default; Frankfurt requires Growth per the docs, or Enterprise per the homepage.
- **Compliance:** SOC 2 Type II is claimed by all three.
- **Self-hosting:** only Browserless has an open-source self-hosted image, under SSPL-1.0 or a commercial licence. Its stealth routes, CAPTCHA solving, residential proxy and persistent sessions are premium features.

### Cited Findings

**Browserless**

- Concurrency and max session by plan: Free 2 concurrent / 2 min; Prototyping 10 (+5 burst) / 15 min; Starter 40 (+10) / 30 min; Scale 100 (+20) / 60 min; Enterprise custom. — [Pricing](https://www.browserless.io/pricing) (summariser); session durations are the same in [BaaS start](https://docs.browserless.io/baas/start) (summariser)
- The default session `timeout` is 30 s; raise it with the `timeout` query parameter in ms, for example `timeout=300000`. — [Playwright MCP for Claude Code](https://docs.browserless.io/ai-integrations/claude-code-playwright-mcp)
- Regions: shared fleet in San Francisco, London and Amsterdam. Trust page: "Only Amsterdam executes in the EU". Customer data is "primarily stored in the United States". A DPA is available "on Enterprise plans". — [Browserless Trust](https://www.browserless.io/trust) (summariser)
- Pricing page compliance (Enterprise): "SOC 2 Type II, GDPR, HIPAA (BAA available), and DPA available". — [Pricing](https://www.browserless.io/pricing) (summariser)
- The privacy page says Browserless does not monitor, store, retain or resell the sites you visit or the nature of your sessions. — [Browserless privacy](https://www.browserless.io/privacy) (search snippet only)
- Self-hosting licence: "SPDX-License-Identifier: SSPL-1.0 OR Browserless Commercial License". A commercial licence is needed for "commercial sites, applications, or in a continuous-integration system that's closed-source". Premium "Self-serve cloud and Enterprise" features: "BrowserQL, hybrid automations, persistent sessions, session replay, Chrome extensions, advanced captcha/stealth routes, REST APIs, inbuilt residential proxy ...". — [browserless/browserless README](https://github.com/browserless/browserless) (summariser)
- Enterprise covers "licensed self-hosting" with Docker or Kubernetes, air-gapped licensing and HIPAA deployment. — [Pricing](https://www.browserless.io/pricing) (summariser)

**Anchor Browser**

- Concurrency: Free 5, Starter 25, Growth 200, Enterprise 500+ (docs). — [Anchor pricing (docs)](https://docs.anchorbrowser.io/pricing). The homepage adds a Team tier at $500/mo with 50 concurrent browsers. — [anchorbrowser.io](https://anchorbrowser.io/)
- Session creation rate: Free 5/min, Starter 25, Team 50, Growth 100 and Enterprise 200+. A 429 without `Retry-After` means a concurrency cap. — [Browser Sessions](https://docs.anchorbrowser.io/quickstart/browser-sessions)
- Session duration: the default `max_duration` is "`180` minutes (3 hours) ... There is no upper limit" — [Session timeout](https://docs.anchorbrowser.io/advanced/session-timeout). This conflicts with the API reference: "`max_duration`: 20 minutes ... `idle_timeout`: 5 minutes", where `-1` disables either — [Start browser session API](https://docs.anchorbrowser.io/api-reference/browser-sessions/start-browser-session) (summariser).
- Recording is enabled by default (`recording.active` defaults to `true`). — [Browser Sessions](https://docs.anchorbrowser.io/quickstart/browser-sessions)
- Data retention: Free and Starter 7 days; Growth custom; Enterprise "Customizable (ZDR)". The homepage lists "30 days data retention" for Team. — [Anchor pricing (docs)](https://docs.anchorbrowser.io/pricing); [anchorbrowser.io](https://anchorbrowser.io/)
- Data residency: "processed and stored exclusively in the AWS `us-east-2` data center in Ohio. For organizations requiring EU-based infrastructure ... `eu-central-1` data center in Frankfurt on the Growth plan." The page claims SOC 2 Type II, ISO 27001, HIPAA and GDPR. Each browser runs in a "dedicated, isolated virtual machine (VM)" that is destroyed after the session. — [Trust & Security](https://docs.anchorbrowser.io/security)
- Plan placement of compliance and regions differs between sources:
  - Docs pricing: Growth has "SOC2 Type 2, ISO27001, GDPR" and "Custom regions: US, EU, Asia, Australia". — [Anchor pricing (docs)](https://docs.anchorbrowser.io/pricing)
  - Homepage: "Custom regions - EU, Asia, Australia" and "BAA, HIPAA, DPA" are listed under Enterprise. — [anchorbrowser.io](https://anchorbrowser.io/)
  - SaaS terms: a DPA is available on request. — [Anchor SaaS terms](https://anchorbrowser.io/saas-terms-05-25-2025)
- Self-hosting: "Bring your own cloud / On premise" is Enterprise only. No open-source image exists. — [Anchor pricing (docs)](https://docs.anchorbrowser.io/pricing)

**Kernel**

- Concurrent browsers: Developer 5, Hobbyist 10, Start-Up 150, Enterprise custom. "Browsers in standby count." — [Concurrency and Limits](https://www.kernel.sh/docs/browsers/concurrency-and-limits)
- Timeout: browsers are deleted after `timeout_seconds` (default 60) once in standby, with "a custom timeout of up to 72 hours". — [Termination & Timeouts](https://www.kernel.sh/docs/browsers/termination). Idle browsers enter standby five seconds after the last client disconnects. — [Kernel docs home](https://www.kernel.sh/docs) (summariser)
- Regions: "`us-east`, `eu-west`, and `ap-southeast`", available "on Start-Up and Enterprise plans". The default is `us-east`. — [Regional Browsers](https://www.kernel.sh/docs/browsers/regions)
- Compliance: "SOC2 compliance" is on all plans and HIPAA BAA on Enterprise. — [Kernel Pricing](https://www.kernel.sh/docs/info/pricing). The security page says "Kernel holds active compliance certifications across SOC 2 Type II, HIPAA, ISO 27001, and GDPR", but later in the same page says "**GDPR** — In Progress". — [Kernel Security Practices](https://www.kernel.sh/docs/security). This is an internal contradiction.
- A DPA at kernel.sh/docs/dpa applies automatically to EU personal data (ToS 3.5). — [Kernel Terms of Service](https://www.kernel.sh/docs/tos). The trust centre hosts the SOC 2 Type II report on request and the subprocessor list. — [Trust Center](https://www.kernel.sh/docs/info/trust-center)
- Browser replays are kept 1 day (Developer), 7 days (Hobbyist), 30 days (Start-Up) and custom on Enterprise. Zero data retention is on Enterprise. — [Kernel Pricing](https://www.kernel.sh/docs/info/pricing); [Trust Center](https://www.kernel.sh/docs/info/trust-center)
- Kernel publishes open-source Chromium images (github.com/kernel/kernel-images) and its VM runtime (github.com/kernel/hypeman). — [Kernel docs home](https://www.kernel.sh/docs) (summariser)

### Inferences

- **Lowest-cost EU execution:** Browserless Amsterdam is available on all plans. Kernel requires $200/mo, and Anchor's EU region requires $2,000/mo or more.
- **Anchor recording risk:** Anchor records sessions by default. Login flows would be recorded unless recording or sensitive-data masking is configured.
- **Kernel self-hosting:** Kernel's open-source images could in principle be self-hosted. That was not verified here, and its managed stealth, proxies and auth are platform features.

### Gaps

- The physical location of Kernel's `eu-west` was not found.
- I could not establish Anchor's actual default `max_duration` or reconcile the plan conflicts on its EU region and DPA.
- Browserless's subprocessor list is available only on request.

## Pricing (secondary)

### Takeaway

Browserless charges in 30-second units, with residential proxy at 6 units/MB. Anchor charges $0.05 per browser-hour, $0.01 per browser created and $8/GB proxy. Kernel charges per second of browser time (headful about $0.48/h, headless about $0.06/h) and does not bill proxy bandwidth.

### Cited Findings

- **Browserless:** "A 'Unit' is a block of browser time of up to 30 seconds per browser connection". Reconnects count as new connections.
  - Plans: Free $0 / 1k units; Prototyping $25/mo / 20k; Starter $140/mo / 180k; Scale $350/mo / 500k (annual billing).
  - Overage: $0.0020 down to $0.0015 per unit.
  - Residential proxy 6 units/MB, datacenter 2 units/MB, CAPTCHA 10 units per successful solve.
  - [Pricing](https://www.browserless.io/pricing) (summariser)
- **Anchor:**
  - Infrastructure: "\$0.01 per browser", "\$0.05 per browser hour", "Anchor Proxy \$8 per GB"; BYO-proxy or proxyless egress "\$0.2 per GB".
  - Plans: Free $5 credits, Starter $50/mo, Growth $2,000/mo (docs), plus Team $500/mo (homepage only).
  - Overage is $1/credit, where 1 credit is $1.
  - [Anchor pricing (docs)](https://docs.anchorbrowser.io/pricing); [anchorbrowser.io](https://anchorbrowser.io/)
- **Kernel:**
  - Plans: Developer free + usage ($5 included); Hobbyist $30 + usage ($10 included); Start-Up $200 + usage ($50 included); Enterprise custom.
  - Usage rates: headful $0.0001333336/s, headless $0.0000166667/s.
  - "You're charged only while the browser is active." Standby is not billed.
  - Managed Auth has no per-connection fee.
  - [Kernel Pricing](https://www.kernel.sh/docs/info/pricing)
- **Kernel proxies:** "Kernel includes datacenter, ISP, residential, and mobile proxies at no additional charge. Bandwidth is not metered and not billed." Fair use applies. — [Kernel AUP](https://www.kernel.sh/docs/acceptable-use)

### Inferences

- **amazon.de page weight:** Amazon pages are heavy, typically several MB with images. Browserless at 6 units/MB and Anchor at $8/GB therefore make proxy traffic the dominant cost. Kernel's unmetered proxies are cheapest in principle, subject to fair use and the upstream e-commerce restriction.

### Gaps

- Browserless publishes no dollar price per residential GB. At 6 units/MB (6,000 units/GB), the estimate is inferred from the plan prices above:
  - In-plan unit prices ($25/20k, $140/180k, $350/500k) give about $4.2–7.5/GB.
  - Overage rates ($0.0015–0.002/unit) give about $9–12/GB.

## Known limitations and complaints

### Takeaway

I found few public complaints. The documented limitations are:

- **Browserless:** one client per persisted session; city targeting gated to Scale; short sessions on low tiers.
- **Anchor:** stealth and EU region gated behind expensive tiers; docs internally inconsistent on proxy types, timeouts and plan features.
- **Kernel:** upstream proxy destination blocks; residential exit IP may change per connection; profile saves overwrite rather than merge; CDP sockets may drop after about 1 hour.

### Cited Findings

- **Browserless:** a second client on a persisted session gets HTTP 429, "Session is already being accessed by another client". — [Persisting state](https://docs.browserless.io/baas/session-management/persisting-state) (summariser)
- **Browserless:** "Browserless provisions a browser per connection and doesn't expose `/json/list`, which is why tools built around tab discovery fail against it." — [Chrome DevTools MCP](https://docs.browserless.io/ai-integrations/chrome-devtools-mcp)
- **Browserless:** on the free tier, a session ended at the 60-second limit and its third concurrent request got HTTP 429. — [techstackups benchmark](https://techstackups.com/comparisons/hosted-browser-benchmarks/) (secondary; summariser)
- **Anchor:** billed while idle in the free-tier test. — [techstackups benchmark](https://techstackups.com/comparisons/hosted-browser-benchmarks/) (secondary; summariser). Docs: "Charges are based on the total active time of the browser session". — [Anchor pricing (docs)](https://docs.anchorbrowser.io/pricing)
- **Anchor:** extra stealth and the CAPTCHA solver switch off when the proxy is inactive. — [For agents](https://docs.anchorbrowser.io/for-agents) (summariser); [Stealth](https://docs.anchorbrowser.io/essentials/stealth)
- **Kernel:** "Requests to a restricted destination fail at the proxy layer; this is not a Kernel outage." — [Kernel AUP](https://www.kernel.sh/docs/acceptable-use)
- **Kernel:** "Profile saves replace the complete stored snapshot and don't merge concurrent changes." — [Save and reuse profile state](https://www.kernel.sh/docs/browsers/profiles/save-and-reuse)
- **Kernel:** reserved pool capacity and standby browsers count against concurrency. — [Concurrency and Limits](https://www.kernel.sh/docs/browsers/concurrency-and-limits)

### Inferences

- **Anchor:** its docs are inconsistent (proxy type enum, `cdp_url` contents, default `max_duration`, plan tiers), so behaviour should be confirmed by testing rather than relying on the docs.

### Gaps

- I found no substantial GitHub issue threads or forum complaints specific to Anchor or Kernel around logins or Amazon. The Browserless repo search via web search surfaced none either.
