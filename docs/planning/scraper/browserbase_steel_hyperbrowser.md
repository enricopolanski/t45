# Browserbase, Steel.dev and Hyperbrowser as replacements for Bright Data's Browser API

Scope: three cloud remote-browser services, checked against T45's needs. Those needs are: Playwright CLI connecting from a microVM over WebSocket; the credential substituted by a host proxy in a header or a WS query parameter; amazon.de from a German IP; logins; and persistent logged-in state. Unless noted otherwise, every source below was read on 2026-11-12. Where a vendor page has its own date, it is given. Most vendor docs were read from the vendors' `llms-full.txt` bundles (https://docs.browserbase.com/llms-full.txt, https://docs.steel.dev/llms-full.txt, https://www.hyperbrowser.ai/docs/llms-full.txt). Each finding cites the individual page URL inside the bundle. Labels used below: "Unverified" means not confirmed from a primary source. "Inference" means my reasoning, not a vendor statement.

## 1. Connection: WebSocket endpoint, protocol, how the API key is passed, header vs query, whether a session must be created first

### Takeaway

All three services expose only a CDP WebSocket, so Playwright `chromium.connectOverCDP` is the documented path. None documents a Playwright-server endpoint for `browserType.connect`. Browserbase and Steel put the real API key in the WS URL as `?apiKey=` (a query parameter), and neither documents header authentication on the WS upgrade. Hyperbrowser is different: the API key goes only to REST (`x-api-key` header). The returned `wsEndpoint` appears to carry a session-scoped token instead of the API key, but this is unconfirmed: the only example is labelled "illustrative" and comes from the x402 page. All three use a header for REST session creation. You need that REST call to set a German proxy and a persistent profile.

### Cited Findings

**Browserbase**

- The documented flow is to create a session (SDK `bb.sessions.create()`, or REST `POST https://api.browserbase.com/v1/sessions`), then `chromium.connectOverCDP(session.connectUrl)`. Puppeteer uses `browserWSEndpoint: session.connectUrl`. — [Using a browser session](https://docs.browserbase.com/platform/browser/getting-started/using-browser-session); [Create a browser session](https://docs.browserbase.com/platform/browser/getting-started/create-browser-session)
- REST auth uses the header `x-bb-api-key` (OpenAPI security scheme `type: apiKey, in: header, name: X-BB-API-Key`). — [API overview](https://docs.browserbase.com/reference/api/overview); [Create a Session (OpenAPI .md)](https://docs.browserbase.com/reference/api/create-a-session.md)
- The create-session response requires `connectUrl` ("WebSocket URL to connect to the Session"), `seleniumRemoteUrl`, and `signingKey` ("Signing key to use when connecting to the Session via HTTP"). Neither the OpenAPI spec nor the SDK says what query parameters `connectUrl` contains. — [Create a Session (OpenAPI .md)](https://docs.browserbase.com/reference/api/create-a-session.md); [sdk-node sessions.ts](https://raw.githubusercontent.com/browserbase/sdk-node/main/src/resources/sessions/sessions.ts)
- A hand-built URL with the API key in the query string appears only in integration guides, not the core reference: `wss://connect.browserbase.com?apiKey=${BROWSERBASE_API_KEY}&sessionId=${id}` passed to `chromium.connectOverCDP`. — [Braintrust integration](https://docs.browserbase.com/integrations/braintrust/typescript); [GitHub Action skill](https://docs.browserbase.com/integrations/skills/github-action)
- The integration guides also show connecting without creating a session first, with only `?apiKey=`. — [Trigger.dev quickstart](https://docs.browserbase.com/integrations/trigger/quickstart); [OpenClaw setup](https://docs.browserbase.com/integrations/openclaw/setup) (`"cdpUrl": "wss://connect.browserbase.com?apiKey=<BROWSERBASE_API_KEY>"`). An older guide adds `&enableProxy=true` to the direct URL. — [Val Town slack-scout](https://docs.browserbase.com/integrations/val-town/slack-scout)
- One guide shows a `connectUrl` printed as `wss://connect.browserbase.com/?sessionId=...`, with the rest elided. — [Vercel agent-browser quickstart](https://docs.browserbase.com/integrations/vercel/agent-browser/quickstart)
- The Selenium example sends headers `x-bb-api-key` and `session-id` on HTTP WebDriver requests to `session.seleniumRemoteUrl`. So the connect gateway accepts the API key as a header for HTTP WebDriver. No equivalent is documented for the CDP WebSocket. — [Using a browser session](https://docs.browserbase.com/platform/browser/getting-started/using-browser-session)
- Sessions that should survive a client disconnect need `keepAlive` set at creation ("run even after disconnection"). — [Create a browser session](https://docs.browserbase.com/platform/browser/getting-started/create-browser-session)
- The session timeout runs from 60 s to 21,600 s (6 h) and defaults to the project's `defaultTimeout`. The REST body field is `timeout`; in the SDK it is `api_timeout`. — [Create a Session (OpenAPI .md)](https://docs.browserbase.com/reference/api/create-a-session.md); [sdk-node sessions.ts](https://raw.githubusercontent.com/browserbase/sdk-node/main/src/resources/sessions/sessions.ts)

**Steel**

- The docs give three auth paths: REST uses the header `steel-api-key`; SDKs use a client option or `STEEL_API_KEY`; CDP over WebSocket uses "the `apiKey` query parameter on the `wss://connect.steel.dev` endpoint". Example: `chromium.connectOverCDP(\`wss://connect.steel.dev?apiKey=${STEEL_API_KEY}&sessionId=${session.id}\`)`. — [Authentication](https://docs.steel.dev/overview/authentication)
- "The `sessionId` parameter is optional: if omitted, Steel will start a new session with default settings and connect you to it." — [Authentication](https://docs.steel.dev/overview/authentication)
- The REST-returned `session.websocketUrl` does not include the key. The docs build the URL as `${session.websocketUrl}&apiKey=${STEEL_API_KEY}`, and the quick reference says "Do NOT use `session.websocketUrl` directly — construct the WSS URL". — [Playwright cookbook](https://docs.steel.dev/cookbook/playwright); [llms-full quick reference](https://docs.steel.dev/llms-full.txt)
- "A single key grants access to your entire organization's Steel resources." Keys can be created and deleted only in the dashboard. There is no API key management and no scoped keys are mentioned. — [Authentication](https://docs.steel.dev/overview/authentication)
- For Selenium, Steel identifies callers by the `steel-api-key` header plus a `session-id` header on HTTP WebDriver requests to `http://connect.steelbrowser.com/selenium`. No header auth is documented for CDP. — [Selenium integration](https://docs.steel.dev/integrations/selenium)
- Sessions are not ended by disconnecting. They run until `sessions.release()` or until the timeout (5 min by default), and "skipping [release] keeps browsers running until the 5-minute default timeout". — [Auth-context cookbook](https://docs.steel.dev/cookbook/auth-context); [Session lifecycle](https://docs.steel.dev/overview/sessions-api/session-lifecycle)

**Hyperbrowser**

- The documented flow is to create a session (SDK, or REST `POST https://api.hyperbrowser.ai/api/session` with header `x-api-key`), then `chromium.connectOverCDP(session.wsEndpoint)`. — [Connect with Playwright](https://hyperbrowser.ai/docs/sessions/playwright); [Regions (cURL example)](https://hyperbrowser.ai/docs/sessions/regions)
- On the format of `wsEndpoint`, the only shape in the docs is on the x402 page, which calls its hosts and tokens "illustrative": `"wsEndpoint": "wss://connect.example.com/?token=CONNECT_TOKEN"`, with separate `liveUrl`/`computerActionEndpoint` tokens and a `managementToken`. The page adds: "The session token does not grant access to account management APIs." — [x402 sessions](https://hyperbrowser.ai/docs/integrations/x402/sessions)
- By default, disconnecting Playwright or Puppeteer stops the session. To keep it alive, append `&keepAlive=true` to the WS endpoint. This shows the endpoint already has a query string. "The `keepAlive` won't work if all the pages in the browser are closed." — [Session lifecycle](https://hyperbrowser.ai/docs/sessions/lifecycle)

### Inferences

- A German proxy and a saved profile are session-creation parameters on all three services: Browserbase `proxies[].geolocation` plus `browserSettings.context`, Steel `useProxy.geolocation` plus `profileId`, Hyperbrowser `proxyCountry` plus `profile`. So T45 must create the session over REST. The REST header (`X-BB-API-Key`, `steel-api-key`, `x-api-key`) is therefore the substitution point that matters most, and all three use a plain header, which T45's proxy supports.
- For the WebSocket leg, Browserbase and Steel require the real API key in the WS URL query (`apiKey=`), so T45's proxy must use query-parameter substitution there. Neither documents a header alternative for CDP. Both gateways accept header auth for HTTP WebDriver, which hints a header might work on the WS upgrade too, but that is untested.
- If its `wsEndpoint` really carries a session-scoped token, Hyperbrowser would fit the "VM never sees the API key" requirement best. The host could create the session and pass the VM a `wsEndpoint` whose token is limited to that one browser session. That token would still be a bearer credential for that browser until the session expires.
- With Browserbase, check whether the returned `connectUrl` embeds the API key or a session-scoped key before handing it to the VM. If unsure, have the VM build `wss://connect.browserbase.com?apiKey=<PLACEHOLDER>&sessionId=<id>` and let the proxy substitute the key.
- Disconnect behaviour matters for Playwright CLI, because a daemon reconnect or restart could otherwise end the session. Browserbase needs `keepAlive: true` at creation and Hyperbrowser needs `&keepAlive=true` on the WS URL. Steel sessions already survive a disconnect until release or timeout.

### Gaps

- None of the three documents header-based auth (for example `Authorization`, `x-bb-api-key`, `steel-api-key`) on the CDP WebSocket upgrade. A live test is needed. Unverified.
- The actual query contents of Browserbase's `connectUrl` (apiKey, signingKey, or sessionId only) are not documented.
- The real Hyperbrowser `wsEndpoint` host, query shape and token lifetime are not documented outside the illustrative x402 example. The x402 token lifetime equals `timeoutMinutes`, but that may apply only to x402.
- I found no documented way to connect to Hyperbrowser directly with the API key and no session: there is no `?apiKey=` URL in https://www.hyperbrowser.ai/docs/llms-full.txt.
- The old Browserbase "Connect API" reference page (https://docs.browserbase.com/reference/api/connect, and its `.md` variant) returned 404 on 2026-11-12. A web-search snippet of that page said the WS endpoint authenticates with an `apiKey` query parameter and accepts an existing session ID. I could not read the page, so this is unverified.
- None of the three documents a Playwright-server (`browserType.connect`) endpoint. I grepped all three docs bundles for `chromium.connect(`, `launchServer` and `run-server` and found no hits.

## 2. Logins: restrictions on password entry or logins, KYC/compliance gates, ToS/AUP clauses

### Takeaway

None of the three documents a KYC, identity-verification or compliance-approval gate on password entry or logins. All three actively market authenticated workflows. The gates that exist are commercial: Browserbase "Verified" needs the Scale plan and an eligibility check with sales, and Steel's Launch plan needs a $10 paid deposit for proxies and CAPTCHA solving. Browserbase's managed residential proxies come with provider-level site restrictions, including webmail (Outlook, Yahoo Mail) and banking. That can affect logins to those sites through the managed proxy. Steel's ToS bans using the service to violate any website's ToS or robots.txt, which is a contractual risk for amazon.de scraping.

### Cited Findings

**Browserbase: no login gate found; logins are a promoted use case**

- The docs recommend this login strategy: create a session with contexts, proxies and fingerprinting; log in through Session Live View or programmatically; persist the state with the context ID. 2FA can be handled by disabling it, using app passwords, or handing remote control to the user. There is a cookie-reuse example with "sign-in". — [Website authentication](https://docs.browserbase.com/platform/identity/authentication)
- Integrations exist for 1Password credential retrieval and "1Password Agentic Autofill", which fills and submits login forms without returning credential values to the app. — [Agent Identity overview](https://docs.browserbase.com/platform/identity/overview)
- Gate for Verified, the stealth browser: "Browserbase offers Verified on the Scale plan … Contact hello@browserbase.com to trial Verified." Upgrading says to "Contact Browserbase to confirm Verified eligibility and enable it for your project." This is an eligibility check by sales; the criteria are not published. — [Agent Identity overview](https://docs.browserbase.com/platform/identity/overview); [Manage billing](https://docs.browserbase.com/account/billing/plan-management)
- Proxy site restrictions: "Browserbase's built-in residential proxies use third-party providers, each with its own acceptable-use policies. Providers may restrict high-risk sites and categories … Banking and financial services … Government domains … Streaming and entertainment … Ticketing … Webmail providers: e.g., Outlook, Yahoo Mail … Gambling." The doc calls these categories "illustrative, not exhaustive". — [Proxies](https://docs.browserbase.com/platform/identity/proxies)
- Usage guidance in the docs, not in the ToS: "Use CAPTCHA solving only for workflows that users and website owners authorize. Follow the site's terms, respect access controls." — [CAPTCHA Solving](https://docs.browserbase.com/platform/identity/captcha-solving). Also: "Before your agent accesses a website: Review the site's terms of service … Check robots.txt for crawling guidelines when applicable." — [Agent Identity overview](https://docs.browserbase.com/platform/identity/overview)
- The Terms of Use (Last Updated: August 1, 2025) "Prohibited Uses" section has generic clauses: violating law, harming minors, spam, impersonation, and conduct that "may harm Browserbase … or expose them to liability". There is nothing on logins, credentials for third-party sites, scraping or CAPTCHA. The "robot, spider" clause applies to accessing "the Platform", meaning Browserbase itself, not target sites. The section also bans abusing the plan system, for example "creating multiple accounts to avoid restrictions". — [Browserbase Terms of Use](https://www.browserbase.com/terms-of-service)

**Steel: no login gate found; there is a payment "verification" and restrictive ToS clauses**

- "Credentials API … Securely store and inject login credentials into browser sessions without exposing them to agents or the page." It is in beta and free during the beta, and supports TOTP. — [Credentials API](https://docs.steel.dev/overview/credentials-api/overview)
- The only "verify" gate is a payment, not KYC: "To use CAPTCHA solving or Steel-provided proxies on Launch, verify your account by adding $10 in paid balance. Free credits do not count. The deposit goes toward usage." — [Pricing/Limits (Last Edit: October 23rd, 2026)](https://docs.steel.dev/overview/pricinglimits)
- Proxy blocklists: "Steel and its partners may restrict access to certain websites … Gambling and betting websites; Government and restricted institutional sites; Ticketing websites; Other categories flagged for compliance reasons." The suggested workaround is BYOP. — [Proxies](https://docs.steel.dev/overview/stealth/proxies)
- The Terms of Service (Nen Labs, Inc., "Last updated February 5, 2025"), section 8 "Prohibited activities", include:
  - "Use the Services to violate any website's terms of service, robots.txt, or similar access restrictions"
  - "Use the Services to bypass security measures, access controls, or authentication systems without authorization"
  - "Engage in web scraping or data collection that violates applicable laws or regulations"
  - "Use the Services to circumvent paywalls, subscription services, or other paid access controls"
  - "Use the Services to create fake accounts or engage in identity fraud"

  Source: [Steel Terms](https://steel.dev/terms)

- The same ToS also has boilerplate that conflicts with paid API use: "The Services may not be used in connection with any commercial endeavors except those that are specifically endorsed or approved by us." and "Use the Services as part of any effort to compete with us or otherwise use the Services and/or the Content for any revenue-generating endeavor or commercial enterprise." — [Steel Terms](https://steel.dev/terms)

**Hyperbrowser: no login gate found**

- Credential fill types stored secrets (username, password, TOTP) into login forms "without your code or an LLM seeing the values". It is in public preview and "enabled for teams on request". — [Credential fill](https://hyperbrowser.ai/docs/sessions/credentials)
- The profile docs give a full "Profile Login Example" (log in and save to a profile, then reuse it already authenticated) and mention "Manage multiple accounts with separate profiles". — [Profiles](https://hyperbrowser.ai/docs/sessions/profiles)
- The Terms of Service (S2 Labs Inc., undated) section 9 "Prohibited Uses" is generic: lawful use only, no harm to minors, no spam, no impersonation, no infringing or fraudulent use, no DoS, and no robots used to access the Service itself. There is nothing on logins, scraping of third-party sites, CAPTCHA, or third-party ToS. — [Hyperbrowser Terms](https://www.hyperbrowser.ai/terms)
- Other features are gated by plan or by request rather than by KYC: proxies and CAPTCHA solving need a paid plan; ultra stealth and custom proxies need Enterprise. — [Session parameters](https://hyperbrowser.ai/docs/sessions/parameters); [Proxy](https://hyperbrowser.ai/docs/sessions/proxy)

### Inferences

- For T45's main blocker, login and password entry, none of the three shows anything like Bright Data's KYC-gated login restriction. Steel and Hyperbrowser ship credential-injection features precisely for logins.
- Steel's "violate any website's terms of service, robots.txt" clause is the clearest contractual exposure for scraping amazon.de. I have not read Amazon's own terms in this research, so the specific conflict is unverified. Browserbase and Hyperbrowser have no equivalent clause in their ToS. Browserbase has similar wording only as docs guidance.
- Browserbase's provider-level webmail and banking restrictions apply to its managed residential proxies. Logins to such sites would need BYO proxy or no proxy.

### Gaps

- No public AUP was found for any of the three. I tried `https://www.browserbase.com/acceptable-use-policy` and `https://www.browserbase.com/dpa`; both were guessed URLs and both redirected to sign-in, so they may not exist at all. Browserbase's DPA (Scale only) and its Verified eligibility criteria are handled through sales.
- "No login restriction found" means none was found in the public ToS and docs read here. It does not prove that none exists: account-level enforcement or provider-side blocks are not documented.
- Hyperbrowser's ToS has no visible "last updated" date.

## 3. Persistent logged-in state: contexts and profiles, lifetime, storage, encryption

### Takeaway

All three persist a Chromium user-data-dir snapshot that you attach to new sessions. Browserbase Contexts live indefinitely and are documented as encrypted at rest. Steel Profiles are deleted after 30 days unused and capped at 300 MB, with no encryption statement. Hyperbrowser Profiles have no documented expiry and only general at-rest encryption claims.

### Cited Findings

**Browserbase Contexts**

- A context persists the Chromium user data directory: cookies, localStorage, IndexedDB, Session Storage, Service Workers, Web Data (autofill), and browser preferences (including HSTS). It excludes the HTTP cache. — [Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts)
- Changes are saved only with `persist: true`. You should wait a few seconds after the session closes before reusing the context. "Avoid simultaneous logins: Avoid having multiple sessions using the same Context at once." — [Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts)
- "Contexts **live indefinitely** … persists until you explicitly delete it". They are invalidated by deletion, project deletion, or account suspension. — [Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts)
- "Context data can include stored credentials and other sensitive browsing data … Contexts are uniquely encrypted at rest." — [Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts)
- On Enterprise, contexts, downloads, uploads and extensions can be stored in the customer's own S3 bucket (BYOS). — [Zero data retention](https://docs.browserbase.com/account/enterprise/zero-data-retention)
- Warning: with Verified, "When using contexts, changing the OS could reduce the success rate of your automation." — [Verified](https://docs.browserbase.com/platform/identity/verified-customization)

**Steel Profiles**

- A profile is a snapshot of the User Data Directory: "auth, cookies, extensions, credentials, and browser settings". You create one with `persistProfile: true` and reuse it with `profileId`. A user-data-dir zip can also be uploaded, and the user agent and proxy can be updated. — [Profiles API](https://docs.steel.dev/overview/profiles-api/overview)
- Limits: "There is a 300 MB limit on the size of a profile … If a profile is not used after 30 days, it will be automatically deleted." — [Profiles API](https://docs.steel.dev/overview/profiles-api/overview)
- The docs recommend one profile plus one dedicated IP per account, to avoid "impossible traveler" invalidation. — [Dedicated IPs](https://docs.steel.dev/overview/sessions-api/dedicated-ips); [Profiles API](https://docs.steel.dev/overview/profiles-api/overview)
- Envelope encryption (AES-256-GCM per credential, wrapped by an org-specific KMS key) is documented for the Credentials API only, not for Profiles. — [Credentials API](https://docs.steel.dev/overview/credentials-api/overview)

**Hyperbrowser Profiles**

- A profile is "a saved snapshot of a browser's user data directory". It holds cookies, local storage, session storage and cache. `persistChanges: true` is needed to save; the default makes the profile read-only for that session. You must "always use the default context" with Playwright. Saving can take "a few seconds after the browser session is closed". — [Profiles](https://hyperbrowser.ai/docs/sessions/profiles)
- Profiles can be forked into independent copies. Persisting the network cache is "available by request". — [Profiles](https://hyperbrowser.ai/docs/sessions/profiles)
- General security statement: "Production databases and managed storage systems are encrypted at rest." — [Hyperbrowser Security](https://www.hyperbrowser.ai/security); [Trust Center](https://trust.hyperbrowser.ai/)

### Inferences

- Browserbase is the safest of the three for long-lived logins, because contexts never expire and are explicitly encrypted. With Steel, any login not used within 30 days is lost, so T45 would need a keep-warm job or would have to accept re-logins.
- On all three, concurrent use of one profile risks forced logouts or lost writes. T45 should serialise sessions per profile.

### Gaps

- Not documented for any of the three: the storage region of contexts and profiles (for example, whether a Browserbase context stays in eu-central-1).
- Steel profile encryption is not documented.
- Hyperbrowser profile retention and expiry are not documented. Hyperbrowser's plan-level "data retention" (7/30/180+ days) may or may not apply to profiles.

## 4. Proxies: residential, mobile and datacenter; Germany; city; sticky sessions; BYO proxy

### Takeaway

All three offer managed residential proxies with Germany (DE) country targeting and best-effort city targeting. None documents managed mobile proxies. Bring-your-own proxy (which is how you would get mobile IPs) is available on all Steel plans and documented without a plan gate on Browserbase. On Hyperbrowser it is Enterprise-only. A stable egress IP needs Browserbase static proxies (Scale only), Steel dedicated IPs ($5/IP/month on Scale) or Hyperbrowser static IPs (plan not stated).

### Cited Findings

**Browserbase**

- Built-in proxies are managed residential (`proxies: true`, US best-effort by default). Geolocation can be set by country, US state or city, with "200+ countries" including "Germany (DE)". Routing is "best effort. If there's no proxy in the specified location, the closest proxy is used." — [Proxies](https://docs.browserbase.com/platform/identity/proxies)
- BYO proxy (`type: "external"`, HTTP/HTTPS/SOCKS5, with username and password) is validated at session creation, and "Not all proxy providers are supported". Per-domain routing rules (`domainPattern`, `type: "none"`) and custom CA certificates for TLS-intercepting proxies are also supported. — [Proxies](https://docs.browserbase.com/platform/identity/proxies)
- "Static proxies keep the same exit IP across sessions … only on Scale plans." — [Proxies](https://docs.browserbase.com/platform/identity/proxies)
- The Agent Identity page describes proxies as "residential or datacenter". No mobile proxy offering is documented. — [Agent Identity overview](https://docs.browserbase.com/platform/identity/overview)
- The Free plan includes 0 GB of proxy traffic. Developer ($20) "unlocks proxies". — [Plans & pricing](https://docs.browserbase.com/account/billing/plans)

**Steel**

- Managed residential: "Hundreds of millions of IP addresses … United States locations by default … Automatic IP rotation to ensure fresh addresses for each session". It covers 200+ countries, US states and "major global cities". "Generally, we've seen US and GB proxies have the highest quality." — [Proxies](https://docs.steel.dev/overview/stealth/proxies)
- Without a proxy, traffic comes from Steel's datacenter IPs. BYOP supports `http://`, `https://` and `socks5://` "on any plan", with "IP Type: Any (Datacenter, Residential, Mobile)". "Your proxy credentials are … never logged or stored by Steel beyond the duration of your session." — [Proxies](https://docs.steel.dev/overview/stealth/proxies)
- The docs include a German example: `"useProxy": { "geolocation": { "country": "DE" } }` combined with `deviceConfig: { device: "mobile" }`. The mobile setting changes the fingerprint and input behaviour only, not the IP type. — [Configure a Browser Session](https://docs.steel.dev/overview/sessions-api/configuration)
- Dedicated IPs are on Scale and Enterprise at "$5 per dedicated IP / month", up to 25 self-serve. You "Choose a location and quantity" when leasing. — [Dedicated IPs](https://docs.steel.dev/overview/sessions-api/dedicated-ips)

**Hyperbrowser**

- "Proxy features require a paid plan." Targeting supports 100+ countries, with DE listed. US states and cities are supported, and `proxyCity` and `proxyState` are mutually exclusive. Proxy settings can be changed on a running session (`PUT /session/:id/update`). — [Proxy](https://hyperbrowser.ai/docs/sessions/proxy)
- "Custom proxy servers are only available on the Enterprise plan." They support HTTP, HTTPS, SOCKS5 and SOCKS5h. — [Proxy](https://hyperbrowser.ai/docs/sessions/proxy); [Session parameters](https://hyperbrowser.ai/docs/sessions/parameters)
- The pricing page lists Startup with "Residential proxies" and Scale and Enterprise with "Premium residential proxies". — [Hyperbrowser pricing](https://www.hyperbrowser.ai/pricing)
- Static IPs are "Dedicated … Same IP across all your sessions" and "Perfect for … maintaining identity with authenticated sessions". — [Static IPs](https://hyperbrowser.ai/docs/sessions/static-ips)

### Inferences

- For amazon.de, all three can give a German residential IP on a paid plan. A German mobile IP is possible only through BYO proxy: available on every Steel plan, documented without a gate on Browserbase, and Enterprise-only on Hyperbrowser.
- Steel's rotation is per session. Pairing a German dedicated IP with a profile (Steel) or a static proxy with a context (Browserbase Scale) is the documented recipe for stable logins.

### Gaps

- None of the three documents whether the managed residential IP stays fixed for the whole of one session (sticky within a session) or rotates mid-session.
- I could not confirm that dedicated or static IPs are available in Germany for Steel, Browserbase or Hyperbrowser.
- I found no Hyperbrowser documentation of proxy site restrictions, and no pricing or plan gate for its static IPs.

## 5. Anti-bot: stealth, fingerprinting, CAPTCHA solving, Amazon-specific evidence

### Takeaway

Each vendor reserves its strongest stealth tier for Scale or Enterprise and sales contact: Browserbase Verified, Steel Stealth Browser, Hyperbrowser Ultra Stealth. Standard tiers get basic fingerprinting plus automatic CAPTCHA solving. On Amazon specifically, Hyperbrowser lists `amazon` as a supported CAPTCHA target for manual evaluation. Steel says Amazon WAF challenges are detected but not auto-solved. Browserbase does not list CAPTCHA types. No independent benchmark tests Amazon.

### Cited Findings

**Browserbase**

- Plans: Developer and Startup get "Basic" stealth and Scale gets "Verified". CAPTCHA solving is "Auto" on paid plans and "No" on Free. — [Plans & pricing](https://docs.browserbase.com/account/billing/plans)
- The CAPTCHA page also says "Browserbase enables CAPTCHA solving by default for all sessions." This is a minor conflict with the plans table, which shows no CAPTCHA solving on Free. — [CAPTCHA Solving](https://docs.browserbase.com/platform/identity/captcha-solving)
- Verified uses "a purpose-built Chromium browser with real browser fingerprints that Browserbase's bot protection partners recognize". It defaults to a Windows OS; "non-Verified sessions always use `linux`". — [Agent Identity overview](https://docs.browserbase.com/platform/identity/overview); [Verified](https://docs.browserbase.com/platform/identity/verified-customization)
- CAPTCHA solving can take "up to 30 seconds". It emits console events (`browserbase-solving-started/finished/errored`), and custom image CAPTCHAs can be handled with CSS selectors. Supported CAPTCHA types are not listed. — [CAPTCHA Solving](https://docs.browserbase.com/platform/identity/captcha-solving)
- Web Bot Auth (cryptographic request signing) is in beta, by request. — [Agent Identity overview](https://docs.browserbase.com/platform/identity/overview)

**Steel**

- "Fingerprinting is applied to every session." "Stealth Browser is Steel's custom Chromium fork. It is available on Enterprise … with access enabled per workload." — [CAPTCHA solving](https://docs.steel.dev/overview/stealth/captcha-solving); [Pricing/Limits](https://docs.steel.dev/overview/pricinglimits)
- Auto-solved CAPTCHA types: `recaptchaV2`, `recaptchaV3`, `turnstile`, `image_to_text`, `slider`. "DataDome, Imperva, Amazon WAF, and FunCAPTCHA challenges are detected and logged for diagnostics, but they are not auto-solved." — [CAPTCHA solving](https://docs.steel.dev/overview/stealth/captcha-solving)
- CAPTCHA solving costs $3 per 1k solves on Launch (after the $10 deposit) and $1 per 1k on Scale. — [Pricing/Limits](https://docs.steel.dev/overview/pricinglimits)

**Hyperbrowser**

- `useStealth` gives standard stealth. `useUltraStealth` is "only available on enterprise plans". CAPTCHA solving requires a paid plan, and "Some sites require proxies to be enabled for CAPTCHA solving to work reliably." — [Stealth Mode](https://hyperbrowser.ai/docs/sessions/stealth); [CAPTCHA Solving](https://hyperbrowser.ai/docs/sessions/captcha-solving)
- "Supported manual CAPTCHA targets are `turnstile`, `cloudflare-challenge`, `aliexpress`, `recaptcha`, and `amazon`." There is also a `"visual"` reCAPTCHA solver mode. — [CAPTCHA Solving](https://hyperbrowser.ai/docs/sessions/captcha-solving)

**Independent and secondary evidence (none is Amazon-specific)**

- Browser Use "stealth benchmark" (March 21, 2026; written by a competitor, Browser Use): 71 bot-protected sites, no authentication. Results: Steel 47%, Browserbase 42%, Hyperbrowser 40%, against Browser Use's own 81%. The plans, stealth modes and proxy settings used for each vendor are not stated, and the site list is not published. — [browser-use.com stealth benchmark](https://browser-use.com/posts/stealth-benchmark)

### Inferences

- amazon.de typically serves a text or image "robot check" or an AWS WAF challenge. Hyperbrowser is the only vendor that names `amazon` as a supported target. Steel's `image_to_text` might cover the classic text CAPTCHA, but that is unverified, and Steel explicitly does not auto-solve Amazon WAF. A live test from a DE residential IP is the only reliable evidence.
- Standard-tier stealth benchmarks put all three roughly level. The enterprise tiers (Verified, Stealth Browser, Ultra Stealth) are where the vendors claim the difference, and those tiers need sales contact.

### Gaps

- None of the three vendors published success rates for Amazon. I found no GitHub issues about amazon.de or amazon.com blocking for any of the three.
- Browserbase's supported CAPTCHA types are not documented.
- Unverified conflict: a web-search snippet claimed a Steel docs page lists "Amazon AWS WAF" among the services its auto-solver supports. It may be an older page at docs.steel.dev/overview/sessions-api/captchas, which I did not read. The current [CAPTCHA solving](https://docs.steel.dev/overview/stealth/captcha-solving) page says Amazon WAF is detected but not auto-solved, so prefer the current page.
- Unverified secondary data: according to a search snippet only, a Browser Use "Stealth Bench V2" (Sept 2026, 100 sites, standard non-enterprise stealth modes) reported Browserbase 78.5%, Steel 74.5% and Hyperbrowser 73.5%. I did not read the source, and these numbers conflict with Browser Use's March run.

## 6. Concurrency, session duration, regions, data retention, GDPR/DPA, SOC 2

### Takeaway

Browserbase is the only one with a documented German region: browsers run in eu-central-1 (Frankfurt). It has SOC 2 Type II, but a DPA only on the Scale plan. Hyperbrowser has a `europe-west` region (city not stated) and a SOC 2 Type 1 report. Steel runs browsers only in `us-east`, its SOC 2 status is unverified, and its maximum session length is short below Enterprise (15 min on Launch, 1 h on Scale).

### Cited Findings

**Browserbase**

- Free / Developer / Startup / Scale plans:
  - Concurrency: 3 / 25 / 100 / 250+
  - Session duration: 15 min / 6 h / 6 h / 6 h+
  - Session creation rate: 5 / 25 / 50 / 150+ per min
  - Data retention: 7 / 7 / 30 / 30+ days
  - SOC 2: yes on all plans, plus pen-test reports on Scale. HIPAA BAA, DPA and SSO: Scale only.

  Source: [Plans & pricing](https://docs.browserbase.com/account/billing/plans)

- Regions: `us-west-2` (default), `us-east-1`, `eu-central-1` (Frankfurt), `ap-southeast-1`. — [Browser regions](https://docs.browserbase.com/optimizations/latency/multi-region)
- Security: "SOC 2 Type II Certified", HIPAA BAAs, "1 browser per VM", "After each session, the virtual machine is killed and recreated", data residency "EU (Germany)". — [Enterprise security](https://docs.browserbase.com/account/enterprise/security)
- Logging and recording can be turned off per session on any plan (`logSession: false`, `recordSession: false`). Full ZDR and BYOS are Enterprise only. — [Zero data retention](https://docs.browserbase.com/account/enterprise/zero-data-retention)

**Steel**

- Launch / Scale / Enterprise plans:
  - Concurrency: 10 / 100 / 1,000+
  - Max session time: 15 min / 1 h / up to 24 h
  - Requests per minute: 60 / 600 / custom
  - Data retention: 7 / 14 days / custom
  - HIPAA-ready BAA on Scale; Enterprise SSO.

  Sources: [Pricing/Limits](https://docs.steel.dev/overview/pricinglimits); [steel.dev/pricing](https://steel.dev/pricing)

- "Steel runs browsers in one region, `us-east`. The `region` parameter is still accepted, and any other value is rejected. Proxy geolocation, not `region`, selects the public IP location." — [Configure a Browser Session](https://docs.steel.dev/overview/sessions-api/configuration)
- Conflict: cookbooks pass `region: "lax"` / `"iad"` to Steel's scrape commands and say `region` accepts `"fra"` for fetch. These appear to be Browser Tools endpoints, not sessions. — [Convex price-watch cookbook](https://docs.steel.dev/cookbook/convex-price-watch); [Scrape cookbook](https://docs.steel.dev/cookbook/scrape)
- The privacy policy ("Last updated October 30, 2026") covers GDPR and UK GDPR legal bases and uses EU Standard Contractual Clauses for transfers. — [Steel Privacy](https://steel.dev/privacy)

**Hyperbrowser**

- Free / Startup ($30) / Scale ($100) / Enterprise plans:
  - Concurrency: 1 / 25 / 100 / 1,000+
  - Data retention: 7 / 30 / 30 / 180+ days

  Source: [Hyperbrowser pricing](https://www.hyperbrowser.ai/pricing)

- Regions: `us-central`, `us-east`, `us-west`, `europe-west` ("Europe (West)"), and `asia-south` (Enterprise and Select plans only). — [Multi-Region Support](https://hyperbrowser.ai/docs/sessions/regions)
- The session timeout comes from the team default set in Settings, or `timeoutMinutes` per session. — [Session lifecycle](https://hyperbrowser.ai/docs/sessions/lifecycle); [Session parameters](https://hyperbrowser.ai/docs/sessions/parameters)
- "Our Trust Center currently lists a SOC 2 Type 1 report, available by request." Data is encrypted in transit (TLS) and at rest. — [Trust Center](https://trust.hyperbrowser.ai/); [Security](https://www.hyperbrowser.ai/security)
- The privacy policy (Last updated October 24, 2025) has a "GDPR Data Protection Rights" section. — [Hyperbrowser Privacy](https://www.hyperbrowser.ai/privacy-policy)

### Inferences

- If T45 needs EU processing plus a signed DPA, Browserbase means the Scale plan. I found no DPA offer from Steel or Hyperbrowser in the public pages I read. The browser running in Frankfurt behind a German residential IP also cuts latency and avoids a mismatch between where the browser runs and where its IP says it is.
- Steel's 1 h cap on Scale may cut off long agent runs. Enterprise raises it to 24 h.

### Gaps

- Hyperbrowser's maximum session timeout is not documented. The 5–60 min range found applies only to x402 sessions.
- Not documented: Hyperbrowser's `europe-west` city, DPA availability for Steel and Hyperbrowser, and Steel's SOC 2 status.
- The trust centres at https://trust.browserbase.com/ and https://trust.steel.dev/ render client-side and returned no readable text on 2026-11-12. Steel's SOC 2 status is therefore unverified, not shown to be absent. A third-party directory lists it as "Unknown", but I saw that only in a search snippet. I found no SOC 2 claim in Steel's own docs.

## 7. Pricing (secondary)

### Takeaway

Browser time costs roughly $0.08–$0.12 per hour and residential proxy traffic $6–$12 per GB on all three. Steel's Scale plan has the highest base fee ($250 per month).

### Cited Findings

- **Browserbase:**
  - Free: $0, 1 browser hour, 0 GB proxy.
  - Developer: $20, 100 hours, 1 GB. Overage $0.12/hr and $12/GB.
  - Startup: $99, 500 hours, 5 GB. Overage $0.10/hr and $10/GB.
  - Scale: custom.
  - Billing is per minute and per MB, with a minimum of 1 minute and 1 MB per session.

  Source: [Plans & pricing](https://docs.browserbase.com/account/billing/plans)

- **Steel:**
  - Launch: $0 plus usage, with $30 one-time credits valid for 90 days. $0.10/hr, $10/GB, $3 per 1k CAPTCHA solves.
  - Scale: $250/month plus usage, with $100 of credits per month. $0.08/hr, $6/GB, $1 per 1k CAPTCHA solves. Dedicated IPs $5 per month each.
  - Billing is per minute, rounded up.

  Source: [Pricing/Limits](https://docs.steel.dev/overview/pricinglimits)

- **Hyperbrowser:**
  - Rates: 1 credit = $0.001. Browser time $0.10/hr; proxy data $10/GB.
  - Plans: Free (5,000 credits); Startup $30/month (30k credits); Scale $100/month (100k credits); Enterprise custom.
  - No separate CAPTCHA fee is listed.
  - Plan credits reset at renewal; purchased credits expire after 12 months.

  Sources: [Pricing docs](https://hyperbrowser.ai/docs/pricing); [Pricing page](https://www.hyperbrowser.ai/pricing)

### Inferences

- For light agent use (tens of hours and a few GB per month), Browserbase Developer or Startup and Hyperbrowser Startup or Scale are cheapest to enter. Steel Launch is cheap, but its 15-minute session cap makes it unsuitable for production.

### Gaps

- Enterprise and Scale prices for the stealth tiers (Verified, Stealth Browser, Ultra Stealth) are not published.

## 8. Known limitations and complaints relevant to T45

### Takeaway

The main practical risks are:

- the stealth tiers are paywalled behind sales;
- Browserbase's managed-proxy blocks on webmail and banking;
- Steel's US-only browser region, 30-day profile expiry and short session caps;
- Hyperbrowser's enterprise-only BYO proxy and keep-alive quirks.

I found little public complaint material specific to these points.

### Cited Findings

- Browserbase: `ERR_TUNNEL_CONNECTION_FAILED` can indicate a site the proxy does not support, an unsupported city, or a temporary issue; the same domain "may work in one session and fail in another". — [Proxies](https://docs.browserbase.com/platform/identity/proxies)
- Browserbase: the create-session API is rate limited according to plan concurrency. — [Create a browser session](https://docs.browserbase.com/platform/browser/getting-started/create-browser-session)
- Browserbase: the "Connect API" reference page now returns 404, so WS URL semantics are documented only through integration guides. — https://docs.browserbase.com/reference/api/connect (404 on 2026-11-12)
- Steel: proxy connection errors (`ERR_TUNNEL_CONNECTION_FAILED`, `ERR_PROXY_CONNECTION_FAILED`) are called "normal behavior". There are compliance blocklists for gambling, government and ticketing sites. — [Proxies](https://docs.steel.dev/overview/stealth/proxies)
- Steel: profiles have a 300 MB size limit. If the upload after a session fails, the profile goes into a `FAILED` state and cannot be used. Profiles unused for 30 days are deleted automatically. — [Profiles API](https://docs.steel.dev/overview/profiles-api/overview)
- Hyperbrowser: a session stops on disconnect unless `&keepAlive=true` is set, and keepAlive "won't work if all the pages in the browser are closed". — [Session lifecycle](https://hyperbrowser.ai/docs/sessions/lifecycle)
- Hyperbrowser: features gated "on request": credential fill (preview), network-cache persistence, and Enterprise-only custom proxies and ultra stealth. — [Credential fill](https://hyperbrowser.ai/docs/sessions/credentials); [Profiles](https://hyperbrowser.ai/docs/sessions/profiles); [Proxy](https://hyperbrowser.ai/docs/sessions/proxy)

### Inferences

- Playwright CLI may close pages or reconnect, and each service handles that differently: Hyperbrowser stops the session when all pages close; Browserbase ends it on disconnect unless `keepAlive` was set; Steel keeps it until release or timeout. T45's host should own the session lifecycle (create, keep-alive, release) and not rely on the VM's connection.
- Open-source steel-browser can be self-hosted, but that runs the browser on T45's own infrastructure, so it does not meet the "cloud service" requirement. It is a fallback only.

### Gaps

- I searched the steel-browser GitHub issues only through web search and found no issue relevant to Amazon or logins. I did not systematically review GitHub issues, Discord or Reddit for any of the three.
- Unverified: according to a search snippet only, a GoLogin review of Steel saw repeated Zillow CAPTCHAs and blocking by G2's DataDome. It does not mention Amazon. I did not read the source.
