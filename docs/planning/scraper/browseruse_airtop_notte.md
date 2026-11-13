# Browser Use Cloud, Airtop and Notte as Bright Data Browser API replacements

All sources were read on 2026-11-12, mostly by downloading the raw docs (`llms-full.txt`, `.md` pages, the OpenAPI spec) and grepping them. The documents' own dates are given where they have one. "BU" means Browser Use Cloud. Quotation marks mark verbatim text from the raw files. Unquoted statements are paraphrases.

## 1. Raw CDP access: endpoint format, how the API key is passed, whether a REST call is needed first

### Takeaway

All three expose a CDP WebSocket that works with Playwright `chromium.connectOverCDP`.

- **Airtop** fits the header-injection proxy most cleanly. You create the session over REST, then send `Authorization: Bearer <key>` on the WebSocket upgrade.
- **Browser Use** and **Notte** each also document a single direct-connect URL that carries the raw API key as a query parameter (`?apiKey=` and `?token=`). Both also have a REST-then-connect flow, where the returned CDP URL appears to work without the key.
- **Playwright protocol:** none of the three documents a usable Playwright-server endpoint for `browserType.connect`. Notte has a `playwright_url` response field, but its docs say the field does not enable that endpoint.

### Cited Findings

**Browser Use Cloud**

- **REST, then CDP:** `POST https://api.browser-use.com/api/v4/browsers` takes the key in the header `X-Browser-Use-API-Key` and returns `cdpUrl`. The docs say "Cloud authentication uses X-Browser-Use-API-Key, without a Bearer prefix." The Playwright example then calls `p.chromium.connect_over_cdp(os.environ["BROWSER_USE_CDP_URL"])` with no extra headers and uses `browser.contexts[0].pages[0]` — [BU Playwright/Puppeteer/Selenium](https://docs.browser-use.com/cloud/browser/playwright-puppeteer-selenium); [BU Browser quickstart](https://docs.browser-use.com/cloud/browser/quickstart)
- **Stopping:** "`browser.close()` and disconnecting CDP do not stop the managed browser." You stop it with `PATCH /api/v4/browsers/{id}` and the body `{"action":"stop"}` — [BU Playwright page](https://docs.browser-use.com/cloud/browser/playwright-puppeteer-selenium)
- **Create parameters (paraphrased from the API reference):**
  - `profileId`
  - `proxyCountryCode` (default `us`; `null` disables the proxy)
  - `timeout` in minutes (default 60, min 1, max 240)
  - `customProxy`, `solveCaptchas` (default true), `allowResizing`, `enableRecording`, `extensionIds`, `networkPolicyId`, screen width and height

  The response includes `id`, `cdpUrl`, `liveUrl`, `timeoutAt`, `proxyUsedMb`, `proxyCost` and `browserCost`. The page also says "All users: Up to 4 hours per session" — [BU Create Browser Session (v4)](https://docs.browser-use.com/cloud/api-v4/browsers/create-browser-session)

- **Direct connect without REST:** the current docs show this only on the OpenClaw tutorial page: `cdpUrl: "wss://connect.browser-use.com?apiKey=<BROWSER_USE_API_KEY>&proxyCountryCode=us"`. The page says "All Browser Use session parameters can be passed as query params in the `cdpUrl`" and lists `timeout` ("session duration in minutes (max 240)"), `profileId` and `proxyCountryCode` ("e.g. `us`, `de`, `jp`") — [BU OpenClaw integration](https://docs.browser-use.com/cloud/tutorials/integrations/openclaw)
- **Hostnames:** the Claude Managed Agents tutorial allow-lists `"*.browser-use.com", "*.cdp.browser-use.com"`. This suggests that returned `cdpUrl`s live under `*.cdp.browser-use.com`. The same tutorial notes that "The CLI sends the key in a request header, so the Console default (header injection only) works" — [BU Claude Managed Agents tutorial](https://docs.browser-use.com/cloud/tutorials/integrations/claude-managed-agents)
- **Legacy URL:** the older `docs.cloud.browser-use.com/guides/browser-api` and `docs.browser-use.com/cloud/guides/browser-api` URLs now redirect to the Playwright and Stealth pages. The standalone "Browser API" guide for `wss://connect.browser-use.com` no longer exists as its own page — observed by HTTP fetch of [docs.browser-use.com/cloud/guides/browser-api](https://docs.browser-use.com/cloud/guides/browser-api)
- **EU deployment:** create the browser on `https://api.eu.browser-use.com/api/v4` with an EU key ("US API keys do not authenticate EU API requests"), then connect Playwright to the returned `cdpUrl` — [BU EU deployment](https://docs.browser-use.com/cloud/eu-deployment)

**Airtop**

- **REST, then CDP:** `POST https://api.airtop.ai/api/v1/sessions` with the header `Authorization: Bearer <token>`. The response includes:
  - `cdpWsUrl`, described as "Websocket url to connect to the Airtop browser for CDP-based automation frameworks (e.g. Puppeteer or Playwright). Include the header 'Authorization: Bearer <airtop-api-key>.'"
  - `cdpUrl`
  - `chromedriverUrl` (Selenium)

  Source: [Airtop API: Create a session](https://docs.airtop.ai/api-reference/airtop-api/sessions/create)

- **Playwright example:** `chromium.connectOverCDP(session.data.cdpWsUrl, { headers: { authorization: \`Bearer YOUR_API_KEY\` } })`. The docs add: "Airtop only supports using the default browser context" and "Airtop does not currently support multiple contexts" — [Airtop: Integrating with Playwright](https://docs.airtop.ai/guides/how-to/automation-frameworks/playwright)
- **Startup time:** session creation is usually seconds, but "in rare cases when hardware isn't immediately available, it may take around 1 minute". Sessions also have the states `initializing`, `awaiting_capacity`, `running` and `ended` — [Airtop: Creating a Session](https://docs.airtop.ai/guides/how-to/creating-a-session)
- **No direct connect:** I found no documented direct-connect URL (one without the REST create) in the Airtop docs index — [Airtop llms.txt](https://docs.airtop.ai/llms.txt)

**Notte**

- **REST auth:** "All API requests require a Bearer token in the `Authorization` header." The OpenAPI security scheme is `OAuth2PasswordBearer` — [Notte API authentication](https://docs.notte.cc/api-reference/authentication); [Notte OpenAPI v1.10.9](https://api.notte.cc/openapi.json)
- **Session start:** `POST /sessions/start` returns `cdp_url` ("The URL to connect to the CDP server") and `playwright_url` ("The WebSocket URL for Playwright's chromium.connect(), when supported by the server. Requires a matching Playwright client version.") — [Notte OpenAPI](https://api.notte.cc/openapi.json)
- **`playwright_url` is not live yet:** "`playwright_url` is optional and defaults to `None`… The field prepares the SDK contract for servers that offer Playwright-protocol access; it does not enable that endpoint." The CDP example uses `chromium.connectOverCDP(cdpUrl)` with no headers and `browser.contexts()[0].pages()[0]` — [Notte: Connect with Playwright](https://docs.notte.cc/features/sessions/playwright); [Notte: Browser Sessions](https://docs.notte.cc/concepts/sessions)
- **CDP URLs are credentials:** "Do not share `debug_url` or `cdp_url`. They grant full control of the browser and its signed-in state, so treat them like credentials." — [Notte: Live View](https://docs.notte.cc/features/sessions/live-view)
- **SDK headers:** the Python SDK sends only `x-notte-request-origin`, `x-notte-sdk-version` and an optional `x-notte-auth-capability` header on CDP connections to Notte's own API host. It sends no API key header — [notte-sdk sessions.py on GitHub](https://raw.githubusercontent.com/nottelabs/notte/main/packages/notte-sdk/src/notte_sdk/endpoints/sessions.py)
- **Viewer URL format:** the SDK builds viewer URLs as `wss://api.notte.cc/sessions/{session_id}/debug/recording?token={token}`. The docs say the viewer URL "is signed with a JWT scoped to that session and valid for 12 hours" — [notte-sdk sessions.py](https://raw.githubusercontent.com/nottelabs/notte/main/packages/notte-sdk/src/notte_sdk/endpoints/sessions.py); [Notte: Embed iframe](https://docs.notte.cc/features/sessions/embed-iframe)
- **Direct connect without REST:** shown only on the OpenClaw integration page: `"cdpUrl": "wss://api.notte.cc/sessions/connect?token=<NOTTE_API_KEY>"`. The page says "The `wss://api.notte.cc/sessions/connect` endpoint creates a fresh browser session when OpenClaw connects and tears it down when the connection closes" — [Notte OpenClaw integration](https://docs.notte.cc/integrations/openclaw)

### Inferences

- **Browser Use direct connect:** `wss://connect.browser-use.com?apiKey=…` fits the "substitute a placeholder in a URL query parameter" proxy mode. The REST flow fits the "substitute a header" mode for `POST /browsers` and `PATCH …/stop`. The returned `cdpUrl` seems to need no key, because the docs connect without headers. That would make it a per-session bearer capability that the VM would see. The VM would not see the provider API key.
- **Airtop:** the key is required on every CDP WebSocket upgrade, so header substitution covers both REST and CDP. The VM never needs a session-capability URL that works without the key. This is the best fit for "VM never sees the credential".
- **Notte `cdp_url`:** it almost certainly embeds a token in the query string, since the SDK sends no key and the docs say to treat it like a credential. Whether that token is the account API key or a session-scoped JWT (like the viewer URL) is unverified. If it is the raw API key, the T45 host would have to create the session and rewrite the token, or connect the VM only through `/sessions/connect?token=<placeholder>`.
- **Default context only:** Airtop says so explicitly. BU and Notte examples also use `contexts[0]`. Playwright CLI/MCP in CDP mode should be checked to confirm it uses the existing default context and does not call `browser.newContext()`. That check is a T45-side test, not vendor-verified.

### Gaps

- **Exact `cdpUrl` string format** for BU's REST response and for Notte's `cdp_url`: not documented in the pages read, and it is unknown whether a key or token is embedded. A search snippet claimed BU returns `https://<uuid>.cdpN.browser-use.com`. That is unverified and was not seen in the raw docs.
- **BU direct connect on disconnect:** whether `wss://connect.browser-use.com` stops the browser on disconnect (a search snippet claimed it does) and whether it saves the profile on disconnect. Neither is in the current docs.
- **Notte `/sessions/connect`:** whether it accepts proxy-country, profile, timeout or other session parameters as query params. Only `token` is documented.
- **Airtop:** whether `cdpWsUrl` accepts the key as a query parameter instead of a header. Not documented.

## 2. Logins: restrictions on password entry or logged-in scraping, KYC/identity/compliance gates, ToS and AUP clauses

### Takeaway

- **No KYC, identity verification or approval gate on password entry or logins** was found for any of the three in the pages read. All three actively market and document logged-in automation.
- **Notte's only approval gate is for stealth**, not logins: `advanced_stealth` is "available to approved workspaces".
- **Airtop's FAQ forbids** "any activity that violates… the terms of service of the websites you are visiting". That clause bears on scraping Amazon.
- **Browser Use's ToS (rev. Oct 15, 2026)** has boilerplate banning use of the Service to "engage in… scraping" and to circumvent "geographic restrictions". Read literally, that conflicts with the product. The ambiguity is flagged here, not resolved.
- **Notte's ToS could not be read:** console.notte.cc returned a Vercel bot checkpoint (HTTP 429).

### Cited Findings

**Browser Use Cloud**

- **ToS, prohibited uses:** dated "Date of Last Revision: October 15, 2026". Under "You agree to not use the Service to:", the list includes:
  - "engage in or use any data mining, robots, scraping, or similar data gathering or extraction methods."
  - "circumvent, remove, alter, deactivate, degrade, or thwart any of the content protections in or geographic restrictions on any content (including Service Content (as defined below)) available on or through the Service, including through the use of virtual private networks"
  - "violate any applicable local, state, national, or international law"

  Source: [BU Terms of Service](https://browser-use.com/legal/terms-of-service)

- **ToS, termination:** "Browser Use, in its sole discretion, may suspend or terminate your account… for any reason" — [BU Terms of Service](https://browser-use.com/legal/terms-of-service)
- **No login gate in the docs:** the docs show logins with no gate. Examples:
  - A 2FA guide ("The most reliable options are a saved profile or a human checkpoint") — [BU 2FA](https://docs.browser-use.com/cloud/guides/2fa)
  - Secret bindings that type a password into allowed hosts — [BU Secrets](https://docs.browser-use.com/cloud/guides/secrets)
  - A 1Password integration whose example task is "Open amazon.com, log in, and check my recent orders" — [BU 1Password](https://docs.browser-use.com/cloud/guides/1password)
- **Security page on credentials:** "Secret bindings give each credential an alias and the hosts where it may be typed… The value is encrypted at rest, kept out of the worker payload, and ends with the run." — [BU Security](https://browser-use.com/security)
- **Unrelated "compliance" text:** the only "compliance" or approval gating found in the BU docs is about ZDR, HIPAA and EU image inputs ("EU image inputs require separate approval for enhanced ZDR…"). It is not about logins — [BU Zero Data Retention](https://docs.browser-use.com/cloud/zero-data-retention)

**Airtop**

- **FAQ, restrictions:** "We do not allow any use of Airtop to engage in any activity that violates laws or the terms of service of the websites you are visiting. Please be aware that the excessive or abusive use of bots, or automation tools on some websites can lead to penalties, including temporary or even permanent restrictions on your account." — [Airtop FAQ](https://docs.airtop.ai/guides/misc/faq)
- **ToS:** "Updated July 29, 2025 / Effective date: July 28, 2025". You may not use the Services in a manner that, among other things:
  - "(f) violates the security of any computer network, or cracks any passwords or security encryption codes"
  - "(g) runs… any processes that run or are activated while you are not logged into the Services, or that otherwise interfere with the proper working of the Services"
  - "(h) copies or stores any significant portion of the Content"

  "Content" is defined as materials "on or through the Services". Source: [Airtop Terms](https://www.airtop.ai/tos)

- **Marketing:** "Airtop lets you run agents across the open web, behind logins, and inside legacy vendor portals", "Sign in once, stay signed in" — [Airtop Web Automation](https://www.airtop.ai/web-automation)
- **Profiles for authentication:** profiles are meant for "when your users need to authenticate to a site via a Live View" — [Airtop Profiles](https://docs.airtop.ai/guides/how-to/saving-a-profile)

**Notte**

- **Approval gate on stealth:** "`advanced_stealth=True` runs the session in Notte's highest-fidelity browser environment. It is available to approved workspaces; contact hello@notte.cc to enable it." The OpenAPI repeats "Available to approved workspaces." — [Notte Stealth Mode](https://docs.notte.cc/features/sessions/stealth-mode); [Notte OpenAPI](https://api.notte.cc/openapi.json)
- **Login features with no gate:**
  - Vaults: "lets sessions authenticate using credential placeholders… Secrets are encrypted at rest and in transit… 2FA Support" — [Notte Secret Vaults](https://docs.notte.cc/concepts/vaults)
  - Managed Auth (`auth_ids`, which verify and "when necessary, authenticate inside this session") — [Notte OpenAPI](https://api.notte.cc/openapi.json)
  - Secret proxies that swap stand-ins for "usernames and passwords on login forms, 2FA codes, API keys and tokens" — [Notte Secret Proxies](https://docs.notte.cc/features/sessions/secret-proxies/overview)
- **ToS unreadable:** `https://docs.notte.cc/legal/terms` redirects to `https://console.notte.cc/terms`, which returned "Vercel Security Checkpoint… We're verifying your browser" (HTTP 429). An archive.org fetch was blocked by the tool — [Notte terms (unreadable)](https://console.notte.cc/terms)

### Inferences

- **Compared with Bright Data:** none of the three has a Bright-Data-style KYC requirement before password fields work. In all three, password entry over raw CDP is ordinary keyboard input, with no documented interception.
- **Contract risk:** the main risk is contractual, not technical.
  - Airtop's FAQ ties permitted use to the target site's ToS. Amazon's Conditions of Use restrict robots and data mining, but I did not read them in this session.
  - BU's ToS "scraping" and "geographic restrictions… virtual private networks" clauses literally cover the core use case. They are probably meant to protect BU's own Service Content, but the text is ambiguous. Legal review or written confirmation from BU would settle it.
- **Notte's gate may matter for Amazon:** if baseline stealth fails on amazon.de, the stronger tier needs manual approval.

### Gaps

- Notte ToS / AUP text: could not be read (Vercel checkpoint).
- None of the three publishes a dedicated Acceptable Use Policy page that I found. BU's `/acceptable-use` returns 404.
- Whether any vendor's residential-proxy supplier imposes KYC for specific domains, as Bright Data does: not documented by any of the three.

## 3. Persistent logged-in state: profiles, persistent sessions, credential vaults, storage, encryption

### Takeaway

All three have server-side profiles that hold cookies and local storage. All three save the profile only at session stop or terminate, or on explicit save. With raw CDP, T45 must therefore make an explicit stop or terminate call, which is authenticated with the key, for state to persist.

- **Airtop** states AES-256 encryption at rest for profiles.
- **Notte** profiles also store session storage. Notte can snapshot a running session, and it has a credential vault plus a "secret proxy" feature that is architecturally close to T45's own host proxy.
- **BU** profiles are documented mainly for agent runs, but `profileId` is also a field on standalone browser create.

### Cited Findings

**Browser Use Cloud**

- **What a profile holds:** "A profile persists cookies, local storage, and login state across browsers. Log in once, save the profile, then reuse it to start future browsers already logged in." The diagram caption says Browser 1's "state is saved to the profile when it stops" — [BU Profiles](https://docs.browser-use.com/cloud/guides/authentication)
- **Standalone browsers:** `profileId` is a parameter of `POST /api/v4/browsers` — [BU Create Browser Session](https://docs.browser-use.com/cloud/api-v4/browsers/create-browser-session). It can also be passed as `&profileId=` on the direct `wss://connect.browser-use.com` URL — [BU OpenClaw](https://docs.browser-use.com/cloud/tutorials/integrations/openclaw)
- **Profile API:** "You can set a `user_id` when creating a profile to associate it with a user in your system" — [BU Create Profile](https://docs.browser-use.com/cloud/api-v4/profiles/create-profile)
- **Profile sync:** a helper syncs local logins ("curl -fsSL https://browser-use.com/profile.sh | sh"). Caveat: "Cookie sync does not import a password manager or guarantee that the target site accepts a moved login. Sites can expire cookies, bind sessions to a device or network… Use a stable proxy location when the site's security policy depends on location." — [BU Profile sync](https://docs.browser-use.com/cloud/guides/profile-sync)
- **Deletion:** "Deletion removes the profile and its stored cookies and local storage. You cannot undo deletion." — [BU Profile sync](https://docs.browser-use.com/cloud/guides/profile-sync)
- **ZDR interaction:** "Full Zero Data Retention: cleanup deletes existing profiles, saved logins… and blocks new ones". The alternative is "Zero Data Retention, except profiles and extensions" — [BU ZDR](https://docs.browser-use.com/cloud/zero-data-retention)
- **EU storage:** saved browser profiles are stored in "EU database/object storage when retained. Profiles include saved browser state such as cookies" — [BU EU deployment](https://docs.browser-use.com/cloud/eu-deployment)
- **Credentials:** secret bindings are per agent run ("Bindings belong to one run"). The docs warn they "do not guarantee that the agent cannot see the value: once typed, it is accessible to the page and to an agent with browser/CDP access" — [BU Secrets](https://docs.browser-use.com/cloud/guides/secrets)

**Airtop**

- **What a profile holds:** "Profiles are saved archives of the artifacts produced by a browsing session. Most importantly, they contain the cookies and local storage of a session".
- **Saving:** done with `saveProfileOnTermination(sessionId, "NAME")`, then `terminate`. "Profiles are only saved when the sesssion is terminated." Restore with `configuration.profileName`.
- **Encryption:** "All profiles are encrypted at rest using AES-256 encryption."

  Source: [Airtop Profiles](https://docs.airtop.ai/guides/how-to/saving-a-profile)

- **Deprecated fields:** `persistProfile` and `baseProfileId` are deprecated in favor of the Save-Profile-On-Termination API and `profileName` — [Airtop Create session](https://docs.airtop.ai/api-reference/airtop-api/sessions/create)
- **Marketing:** "Sign in once, stay signed in. Airtop stores credentials and sessions securely, never exposed in agent code or logs." — [Airtop Web Automation](https://www.airtop.ai/web-automation)

**Notte**

- **What a profile holds:** "A profile is a saved snapshot of a browser's cookies, local storage, and session storage. Other browser data, such as the HTTP cache, history, and extensions, is not saved."
- **Saving:** with `persist=True`, "Notte saves that session's browser state when the session ends". `save_profile()` "snapshots the running session into a new profile… and the session keeps running".

  Source: [Notte Browser Profiles](https://docs.notte.cc/features/sessions/browser-profiles)

- **API:** `SessionProfile {id, persist (default false): "Whether to save browser state to profile on session close"}`. There are also endpoints `/sessions/{id}/profile/save`, `/profiles/{id}/cookies` and `/profiles/{id}/state` — [Notte OpenAPI](https://api.notte.cc/openapi.json)
- **Vaults:** "Secrets are encrypted at rest and in transit." The vault "replaces the dummy value with the actual credential for the current website, directly inside the browser" during `fill` / `form_fill` actions. Plan limits are 5, 50 and 200 vaults on Free, Developer and Startup — [Notte Vaults](https://docs.notte.cc/concepts/vaults); [Notte pricing](https://www.notte.cc/pricing)
- **Secret proxy:** a session can route listed hosts through the customer's own "secret proxy". "Requests to the listed hosts go to your secret proxy. For HTTPS sites they go through a tunnel, so Notte only carries encrypted bytes", and the proxy swaps stand-ins for real values. The password field is "Never stored or returned". Caveat: "A value the page encrypts before sending it cannot be swapped." — [Notte Secret Proxies](https://docs.notte.cc/features/sessions/secret-proxies/overview); [Notte OpenAPI `SecretProxy`](https://api.notte.cc/openapi.json)

### Inferences

- **Profile save over raw CDP:** for all three, a Playwright `browser.close()` from the VM will not save the profile. The host or server must call BU `PATCH …{"action":"stop"}`, Airtop `terminate`, or Notte stop or `save_profile`. Those calls carry the provider key, so they belong on the T45 server or host side, not in the VM.
- **Notte secret proxy:** this mechanism could let T45 keep website passwords out of both the VM and Notte. It means running a TLS-intercepting proxy reachable from Notte's cloud.

### Gaps

- **Encryption at rest for profiles:** not stated by BU (only secret bindings are said to be encrypted) or by Notte (only vault secrets are).
- **Profile retention, size limits and count limits:** not documented by any of the three. BU documents none; Notte documents none; Airtop documents none.
- **BU direct connect:** whether a `wss://connect.browser-use.com?...&profileId=` session writes state back to the profile when the socket closes. Not documented.

## 4. Proxies: residential, mobile or datacenter; Germany targeting; sticky sessions; bring-your-own

### Takeaway

All three default to managed residential proxies (US exit), with per-session country selection.

- **Germany:** BU explicitly shows `de` (its own amazon.de example) and Notte's country enum includes `de`. Airtop says only that it covers "many of the most-populous countries".
- **Mobile proxies:** none of the three documents mobile proxies.
- **Bring your own proxy:** all three support it. BU allows it on every account. Airtop requires the $189/mo Professional plan, and Notte the $100/mo Startup plan.
- **Airtop's integrated proxy refuses some domains:** some banking, LinkedIn, Ticketmaster and some streaming sites.

### Cited Findings

**Browser Use Cloud**

- **Default proxy:** "A US residential proxy is enabled by default." The docs show `browser_settings={"proxyCountryCode": "de"}` for the task "Get the iPhone 16 price on amazon.de" — [BU Proxies](https://docs.browser-use.com/cloud/browser/proxies)
- **Coverage:** "Residential proxies are enabled by default across 195+ countries." — [BU Stealth](https://docs.browser-use.com/cloud/browser/stealth)
- **Changing the proxy of a running browser:** `PATCH /api/v4/browsers/{id}/proxy` accepts:
  - `{"mode": "managed", "country": "de"}`
  - `{"rotate": true}` ("New residential IP in the same country")
  - `{"mode": "direct"}`
  - `{"mode": "custom", "customProxy": {...}}`

  "The browser does not restart, so tabs, cookies and local storage stay." Custom mode "is not available on the EU route (`422`)" — [BU Proxies](https://docs.browser-use.com/cloud/browser/proxies)

- **Custom proxy:** "Custom proxies are available to all accounts, including free and pay-as-you-go accounts." The fields are `host`, `port`, `username`, `password`, `protocol` (http or https), `caBundle` / `caBundleUrl` and `ignoreCertErrors` — [BU Proxies](https://docs.browser-use.com/cloud/browser/proxies)
- **Sticky IPs:** "Selecting a proxy country chooses a location; it does not promise a particular city or a unique IP on every launch." — [BU Troubleshooting](https://docs.browser-use.com/cloud/guides/troubleshooting). Also: "A new managed browser does not guarantee a unique proxy IP or particular city." — [BU Proxies](https://docs.browser-use.com/cloud/browser/proxies)

**Airtop**

- **Proxy configuration:** `proxy: true` uses the integrated proxy. `country` takes an ISO 3166-1 alpha-2 code or `global`, defaulting to US. The docs say: "We do not guarantee an available proxy in all countries." `sticky` (default true) means "Try to maintain the same IP address for the duration for up to a maximum of 30 minutes… best-effort" — [Airtop Create session](https://docs.airtop.ai/api-reference/airtop-api/sessions/create)
- **Sticky duration conflict:** the proxy guide says "By default, Airtop-provided proxies will be in the US and will attempt to keep the same IP address 10 minutes", but also "Sticky sessions attempt to keep the same IP address for up to 30 minutes" — [Airtop Using a Residential Proxy](https://docs.airtop.ai/guides/how-to/using-a-proxy)
- **Blocked domains:** "The integrated proxy service has a few domains that it cannot access. If you try to access one of these domains, the session will fail." The list:
  - "Some streaiming services like (e.g., Netflix)"
  - "Some banking and other financial institutions"
  - "Ticketing sites like Ticketmaster"
  - "Linkedin"

  Source: [Airtop proxy guide](https://docs.airtop.ai/guides/how-to/using-a-proxy)

- **BYO proxy:** "If you'd like to use your own proxy, Airtop doesn't charge for the data". Per-domain routing is available through `[{domainPattern, relay}]`. Recommended providers are Oxylabs, Smartproxy and IPRoyal — [Airtop proxy guide](https://docs.airtop.ai/guides/how-to/using-a-proxy)
- **Plan gating:** "Integrated Proxy" is listed from Starter ($29/mo) and "Custom Proxy" from Professional ($189/mo) — [Airtop Pricing](https://www.airtop.ai/pricing)

**Notte**

- **Proxy types:** "Built-in proxies are on by default (`proxies=True`) and exit in the US unless you pick a country." Custom HTTP, HTTPS or SOCKS5 proxies are supported (HTTP/HTTPS only with `chrome-nitro`), as are a Tailscale tailnet (with an optional `exit_node`) and a secret proxy. The docs also warn: "`ERR_TUNNEL_CONNECTION_FAILED` indicates either a temporary proxy hiccup or a site unsupported by our built-in proxies." — [Notte Proxies](https://docs.notte.cc/features/sessions/proxies)
- **`NotteProxy` schema:**
  - `country` (enum `ProxyGeolocationCountry`, 202 values including `de`)
  - `city`
  - `sticky_session`: "Keep the session's exit on one residential IP, shared with a proxy gateway credential minted with the same `sticky_session`"

  Source: [Notte OpenAPI](https://api.notte.cc/openapi.json)

- **Fingerprint follows location:** "Location matching — Timezone, locale, and geolocation follow the session's proxy exit IP" — [Notte Stealth Mode](https://docs.notte.cc/features/sessions/stealth-mode)
- **Plan gating:** BYO proxy is listed as "No" on Free and Developer and "Yes, $0.20 / GB" on Startup. Add-on: "Fixed IPs — Contact us" — [Notte pricing](https://www.notte.cc/pricing); [Notte docs pricing tab](https://docs.notte.cc/llms-full.txt)

### Inferences

- **Germany coverage:** for amazon.de from a German residential IP, BU (`proxyCountryCode=de`) and Notte (`country: "de"`) are documented. Airtop's German coverage is plausible but not confirmed.
- **Mobile proxies:** for mobile IPs, all three would need a third-party mobile proxy through BYO. That works on any BU account but needs a paid tier on Airtop and Notte.
- **Airtop's domain list:** a blocklist on banking and LinkedIn implies its upstream residential network applies domain restrictions. Other sites' logins might hit similar unlisted restrictions.

### Gaps

- Mobile or datacenter managed proxies: not documented by any of the three.
- Residential proxy upstream supplier, IP-pool size per country, and per-domain restrictions for BU and Notte: not published.
- Airtop: whether `DE` is available.
- BU: sticky-IP duration within a session. Only explicit `rotate` is documented.

## 5. Anti-bot: stealth and fingerprinting, CAPTCHA solving, Amazon evidence

### Takeaway

- **BU** has the most detailed claims: a hardened Chromium fork with per-session randomized fingerprints and an automatic CAPTCHA solver. Its vendor-run benchmark, on a non-random site sample, puts it first. Automatic CAPTCHA solving is disabled on BU's EU (Frankfurt) deployment.
- **Notte** solves reCAPTCHA v2, hCaptcha, Turnstile and press-and-hold, and uses a coherent fingerprint tied to the proxy location. Its stronger "advanced stealth" requires approval.
- **Airtop** documents a CAPTCHA solver and residential proxies, but no fingerprinting details.
- **Amazon:** I found no independent evidence about amazon.de for any of the three. BU's amazon.de docs example is not evidence of success.

### Cited Findings

**Browser Use Cloud**

- **Stealth claims:** "Every cloud browser session runs in a hardened Chromium fork with stealth enabled by default". "Anti-detect browser fingerprinting — Canvas, WebGL, fonts, navigator, and other browser fingerprints are randomized per session to appear as a real user. Fingerprint test results vary with browser version and the target site." "Anti-bot protections — Help with sites protected by Cloudflare, PerimeterX, and other detection services. Access to every site is not guaranteed." — [BU Stealth](https://docs.browser-use.com/cloud/browser/stealth)
- **Window size:** fixed by default "because resizing makes a browser easier to detect" (`allowResizing` overrides it) — [BU Stealth](https://docs.browser-use.com/cloud/browser/stealth)
- **CAPTCHA solver:** "Automatic CAPTCHA solving is enabled by default for API V4 Agent runs and standalone Cloud Browser sessions." "Cloudflare and other bot walls are handled by the browser's stealth layer and residential proxies, not by the CAPTCHA solver." "CAPTCHA solving is not guaranteed." — [BU CAPTCHA handling](https://docs.browser-use.com/cloud/browser/captcha-handling)
- **EU deployment:** "Automatic CAPTCHA solving and browser response caching are disabled." — [BU EU deployment](https://docs.browser-use.com/cloud/eu-deployment). Also: "the EU deployment has its own keys and endpoint, and does not solve CAPTCHAs automatically." — [BU OpenClaw](https://docs.browser-use.com/cloud/tutorials/integrations/openclaw)
- **Vendor benchmark ("Stealth Bench V2"):** "100 bot-protected sites. 2 visits each"; results for Sep 25, 2026 are Browser Use 90.5%, Anchor 82%, Kernel 80.5%, Browserbase 78.5%, Browserless 77.5%, Steel 74.5%, Hyperbrowser 73.5%. Disclosed bias: "We picked sites where Browser Use got through before and Chrome with a US proxy did not." The page claims an independent rerun ("Browser Use 90%, best other 85%"). Airtop and Notte were not tested. This is vendor-run evidence — [BU Browser benchmark](https://browser-use.com/benchmarks/browsers)
- **Amazon:** an amazon.de task appears as the docs' proxy-country example. This is not evidence that amazon.de lets it through — [BU Proxies](https://docs.browser-use.com/cloud/browser/proxies)

**Airtop**

- **Built-in solver:** `solveCaptcha: true`. "every time a Captcha is detected, Airtop will automatically solve it using the built-in solver". Events report the type (e.g. "recaptcha, hcaptcha"). Third-party extensions (NopeCHA, CapSolver, 2Captcha) are suggested as an alternative — [Airtop Solving Captchas](https://docs.airtop.ai/guides/how-to/solving-captchas)
- **Marketing:** lists "Stealth Mode" and "Built-in proxies and CAPTCHA solving keep your agents from getting flagged as bots" — [Airtop Web Automation](https://www.airtop.ai/web-automation)
- **Docs coverage:** the docs index has no stealth or fingerprint page — [Airtop llms-full.txt](https://docs.airtop.ai/llms-full.txt)

**Notte**

- **Stealth features:** "Coherent browser fingerprint — A realistic, recent Chrome desktop fingerprint (user agent, platform, screen, and graphics hardware) that stays internally consistent". Timezone, locale and geolocation follow the proxy. Advanced stealth is for "approved workspaces" — [Notte Stealth Mode](https://docs.notte.cc/features/sessions/stealth-mode)
- **CAPTCHA solving:** "Notte can automatically detect and solve captchas including reCAPTCHA v2, hCaptcha, Cloudflare Turnstile, press-and-hold challenges, and simple text challenges… Captcha solving is on by default" — [Notte CAPTCHA Solving](https://docs.notte.cc/features/sessions/captcha-solving)
- **Browser types:** `chromium` (default), `chrome`, `chrome-nitro`; `block_ads` defaults to true — [Notte OpenAPI](https://api.notte.cc/openapi.json)
- **Plan wording:** "Captcha solving / stealth: Included" on Free, Developer and Startup, and "Targeted" on Enterprise — [Notte pricing](https://www.notte.cc/pricing)

**Secondary (non-vendor or general)**

- A Browserless blog describes Amazon's bot defenses as AWS WAF, image CAPTCHAs, IP blocking, user-agent checks and behavioral analysis. It is a competitor's marketing blog — [Browserless: Bypassing Amazon CAPTCHA](https://www.browserless.io/blog/how-to-bypass-amazon-captcha) (search-result summary only, not read in full)

### Inferences

- **Amazon is the deciding test:** it uses its own AWS WAF CAPTCHA, which none of the vendors' solver lists names explicitly. Success on amazon.de will depend mostly on the residential IP plus fingerprint, not on the solvers. BU and Notte both claim location-consistent stealth. A short paid trial on amazon.de search and product pages is the only reliable test.
- **BU region trade-off for amazon.de:** use the US control plane with `proxyCountryCode=de` (solver on), or the EU deployment (data in Frankfurt, solver off).

### Gaps

- No independent, recent (2026) measurement of any of the three on amazon.de or amazon.com.
- Airtop's fingerprinting approach: undocumented.
- Notte's and Airtop's solver coverage of AWS WAF CAPTCHA: not stated.
- I did not search for third-party complaints about Airtop or Notte stealth.

## 6. Concurrency, session duration, browser regions, data retention, GDPR/DPA, SOC 2

### Takeaway

- **BU** is the strongest here:
  - concurrency of 10 to 1,000 by lifetime spend
  - 4-hour max session
  - a Frankfurt EU deployment
  - SOC 2 Type II, a published DPA with EU SCCs, and ZDR

  The pricing page and the docs disagree on whether EU residency and ZDR are Enterprise-only.

- **Airtop:** 3, 30 or 100 simultaneous sessions by plan; US-hosted; claims SOC 2 and HIPAA.
- **Notte:** 5, 25 or 100 concurrent browsers by plan, with max session duration 15, 120 or 300 min. Its Trust Center lists SOC 2 Type 2, with GDPR, HIPAA and ISO 27001 "in progress". It publishes no region information.

### Cited Findings

**Browser Use Cloud**

- **Concurrency:** lifetime qualifying spend of $0, $100, $1,000, $5,000 and $25,000 unlocks 10, 50, 250, 500 and 1,000 concurrent sessions respectively. "Browser Use has separate limits for simultaneous browser work and API request frequency" — [BU Concurrency and limits](https://docs.browser-use.com/cloud/guides/concurrency); [BU Pricing](https://browser-use.com/pricing)
- **Session duration:** "Session Limits: All users: Up to 4 hours per session" (`timeout` max 240 min) — [BU Create Browser Session](https://docs.browser-use.com/cloud/api-v4/browsers/create-browser-session)
- **EU region:** "Browser Use's EU deployment runs agents and browsers in Frankfurt, Germany", on "Frankfurt AWS infrastructure".
  - "Account administration and billing remain shared in the US".
  - "Standalone browser custom proxies are unavailable" in the EU.
  - Automatic CAPTCHA solving is disabled in the EU.

  Source: [BU EU deployment](https://docs.browser-use.com/cloud/eu-deployment)

- **Security and DPA:** "SOC 2 Type II, audited by Accorp Partners for July 17 to October 17, 2025. Report on request." The DPA covers "GDPR and UK GDPR, with EU Standard Contractual Clauses. Incident notice within 72 hours… Personal data destroyed within 90 days of termination" — [BU Security](https://browser-use.com/security)
- **DPA date:** "Last updated: July 30, 2026" — [BU DPA](https://browser-use.com/dpa)
- **Recording and ZDR:** recording is off by default for API browsers. "Zero Data Retention (ZDR) projects never record" — [BU ZDR](https://docs.browser-use.com/cloud/zero-data-retention); [BU Browser quickstart](https://docs.browser-use.com/cloud/browser/quickstart)
- **Conflict on plan tiers:** the pricing page lists "HIPAA and zero data retention", "EU data residency" and "On-prem deployment" under Enterprise. Pay-as-you-go lists "SOC 2 Type II and a signed DPA" — [BU Pricing](https://browser-use.com/pricing). The docs, however, say "Enable self-service Zero Data Retention for US and EU browser automation… without an enterprise contract or additional commitment", enabled from "Settings → Privacy & compliance", and an EU dashboard where you create EU keys — [BU ZDR](https://docs.browser-use.com/cloud/zero-data-retention); [BU EU deployment](https://docs.browser-use.com/cloud/eu-deployment)

**Airtop**

- **Plans and session limits:**

  | Plan         | Price   | Simultaneous sessions | Other                 |
  | ------------ | ------- | --------------------- | --------------------- |
  | Free         | $0      | 3                     |                       |
  | Starter      | $29/mo  | 3                     |                       |
  | Professional | $189/mo | 30                    |                       |
  | Enterprise   | $558/mo | 100                   | "SOC 2 Type 2 report" |
  | Custom       | custom  | custom                |                       |

  Source: [Airtop Pricing](https://www.airtop.ai/pricing)

- **Idle timeout:** `timeoutMinutes` is the idle timeout, default 10. No maximum is documented — [Airtop Create session](https://docs.airtop.ai/api-reference/airtop-api/sessions/create)
- **Hosting:** "The Services are hosted and operated in the United States" (privacy policy "Updated September 2, 2025") — [Airtop Privacy](https://www.airtop.ai/privacy)
- **Compliance claims:** "Yes, Airtop is SOC 2 compliant… Yes, Airtop is HIPAA compliant", reports via support — [Airtop FAQ](https://docs.airtop.ai/guides/misc/faq). The Trust Center at trust.airtop.ai is JS-rendered and was not readable by fetch.

**Notte**

- **Plan limits:**

  | Limit                | Free   | Developer ($20/mo) | Startup ($100/mo) | Enterprise |
  | -------------------- | ------ | ------------------ | ----------------- | ---------- |
  | Browser concurrency  | 5      | 25                 | 100               | Custom     |
  | Max session duration | 15 min | 120 min            | 300 min           | Custom     |

  Source: [Notte pricing](https://www.notte.cc/pricing)

- **Timeout parameters:** the API caps `idle_timeout_minutes` at 30 (default 3) and `max_duration_minutes` at 1440 (default 15) — [Notte OpenAPI](https://api.notte.cc/openapi.json)
- **Rate limits:** "Max active sessions limit exceeded (limit: 5, current: 5)" returns 429. `POST /sessions/start` has per-minute, per-hour and per-day windows. A 529 is returned "when no browser capacity is available" — [Notte Rate Limits](https://docs.notte.cc/api-reference/rate-limits)
- **Recording and logs:** `record_session` and `log_session` both default to true. Setting them false "permanently disables saved replay" and logs — [Notte OpenAPI](https://api.notte.cc/openapi.json)
- **Trust Center:** "SOC2 type 2 report"; ISO 27001 (2022) "(In progress)"; GDPR "(In progress)"; HIPAA "(In progress)" — [Notte Trust Center](https://trust.notte.cc)
- **HIPAA conflict:** the pricing page lists "SSO, SLAs, HIPAA" for Enterprise, against HIPAA "in progress" on the Trust Center — [Notte pricing](https://www.notte.cc/pricing)

### Inferences

- **Regions:** for GDPR-sensitive logged-in sessions (cookies of EU users), BU is the only one of the three with a documented EU data region and a published DPA with SCCs. Airtop is US-hosted. Notte's hosting region is undocumented.
- **Long sessions:** a long-lived agent session, more than 15 min, needs at least Notte Developer, any BU account (up to 4 h), or Airtop with a raised idle timeout.

### Gaps

- Notte hosting regions, DPA and data retention defaults.
- Airtop: DPA, data retention for recordings and profiles, maximum `timeoutMinutes`, and whether it offers any EU region.
- BU: exact retention defaults for non-ZDR projects (not extracted).
- Resolution of the BU Enterprise-vs-self-service conflict for EU and ZDR.

## 7. Pricing model

### Takeaway

- **Browser Use:** $0.02 per browser-hour plus $5/GB residential traffic ($0.20/GB for BYO or direct), no subscription.
- **Notte:** $0.01 per browser-hour plus $10/GB residential ($0.20/GB BYO, Startup plan only), plus monthly plans of $0, $20 or $100.
- **Airtop:** credit subscriptions of $0, $29, $189 or $558/mo. Its per-minute and per-GB credit rates are not public.

  For amazon.de reading, proxy GB dominates cost on all three.

### Cited Findings

**Browser Use Cloud**

- **Rates:** "$0.02 per hour, billed by the minute, 1-minute minimum." "$5/GB on home-IP proxies. $0.20/GB direct or your own proxy." CAPTCHA solving is included. Credits start at $5 and top-ups never expire — [BU Pricing](https://browser-use.com/pricing)
- **Billing mechanics:** "The full rate is charged upfront when the session starts. When you stop the session, any unused time is automatically refunded proportionally." — [BU Create Browser Session](https://docs.browser-use.com/cloud/api-v4/browsers/create-browser-session)
- **Competitor prices (vendor-compiled, Oct 24):** BU lists "Anchor $8/GB", "Browserbase $10-12/GB" and "Kernel: Unmetered, from $30/mo" — [BU Pricing](https://browser-use.com/pricing)

**Airtop**

- **Plan credits:**
  - Free: 1,000 credits/mo
  - Starter $29: 30,000 to 150,000 credits
  - Professional $189: 225,000 to 500,000
  - Enterprise $558: 775,000 to 1,500,000

  Source: [Airtop Pricing](https://www.airtop.ai/pricing)

- **What uses credits:** "Airtop also charges credits for CPU time of the browser instance, as well as proxy bandwidth" — [Airtop FAQ](https://docs.airtop.ai/guides/misc/faq). "sessions are billed per 30s increments" — [Airtop Creating a Session](https://docs.airtop.ai/guides/how-to/creating-a-session)
- **No one-off purchases:** "Airtop does not offer one-off credit purchases." — [Airtop Billing & Credits](https://www.airtop.ai/help/billing/billing.md)
- **Conflict on the signup bonus:** the pricing page says "10,000 one-time credit bonus" — [Airtop Pricing](https://www.airtop.ai/pricing). The billing help says "one-time signup grant of 30,000 credits" — [Airtop Billing & Credits](https://www.airtop.ai/help/billing/billing.md)

**Notte**

- **Rates:** "Browser Sessions $0.01 / hour", "Residential Proxies $10 / GB… BYO proxy: $0.20 / GB". The Developer plan is $20/mo with $20 credits, and Startup is $100/mo with $100 credits. Free gives $10 of credits once — [Notte pricing](https://www.notte.cc/pricing)
- **BYO proxy billing:** "For a custom proxy, the full bandwidth is first recorded as a Proxy charge at $10 per GB. When the session closes, a BYO Proxy Credit refunds all but $0.20 per GB of it on the Startup plan." — [Notte Proxies](https://docs.notte.cc/features/sessions/proxies)

### Inferences

- **Cost ranking:** for residential traffic, BU ($5/GB) is half of Notte's price ($10/GB). Browser-hour costs are negligible on both.

### Gaps

- Airtop's credits per browser-minute and per proxy GB: not published on any page read.

## 8. Known limitations and complaints relevant to T45

### Takeaway

- **Airtop shows signs of de-prioritizing its raw browser API.**
  - A site banner reads "Airtop is working on something new. Stay tuned!"
  - The pricing page is framed around agents ("Agent Builder", "Mark").
  - The developer changelog stops at September 3, 2025.
  - Profiles do not support multiple contexts, and the integrated proxy blocks banking and LinkedIn.
- **Browser Use's main caveats:**
  - Its EU region drops the CAPTCHA solver and custom proxies.
  - Its ToS has an ambiguous anti-scraping clause.
  - Disconnecting CDP leaves the browser running and billing.
- **Notte's main caveats:**
  - Its ToS could not be read.
  - Advanced stealth needs approval.
  - BYO proxy needs the Startup plan.
  - Free and Developer sessions are capped at 15 and 120 min.
  - Its built-in proxies do not support some sites.

### Cited Findings

**Airtop**

- **Product-direction signals:** the pricing page opens with "Airtop is working on something new. Stay tuned!" and markets "Agent Builder" and "Mark" — [Airtop Pricing](https://www.airtop.ai/pricing). The latest changelog entry is "September 3, 2025", with nothing listed for the 14 months since — [Airtop Changelog index](https://docs.airtop.ai/changelog/llms.txt)
- **Default context only:** "Airtop does not currently support multiple contexts. Please be sure to use the default context." — [Airtop Playwright](https://docs.airtop.ai/guides/how-to/automation-frameworks/playwright)
- **Proxy domain blocks:** the integrated proxy blocks banking, LinkedIn, ticketing and streaming domains — [Airtop proxy guide](https://docs.airtop.ai/guides/how-to/using-a-proxy)
- **Capacity waits:** "awaiting_capacity" is a session state, and startup can take about 1 minute when hardware is not available — [Airtop Creating a Session](https://docs.airtop.ai/guides/how-to/creating-a-session)

**Browser Use Cloud**

- **EU limits:** the EU route disables CAPTCHA solving and standalone custom proxies — [BU EU deployment](https://docs.browser-use.com/cloud/eu-deployment)
- **Billing on disconnect:** "browser.close() and disconnecting CDP do not stop the managed browser" — [BU Playwright page](https://docs.browser-use.com/cloud/browser/playwright-puppeteer-selenium)
- **Moved logins can fail:** "Sites can still expire the login, bind it to a device or network, or ask you to verify again; re-sync when that happens." — [BU OpenClaw](https://docs.browser-use.com/cloud/tutorials/integrations/openclaw)
- **Docs churn:** API versions v2 (legacy), v3 and v4 coexist, and the earlier "Browser API" guide URL now redirects elsewhere — [BU FAQ](https://docs.browser-use.com/cloud/faq); [BU docs](https://docs.browser-use.com/cloud/guides/browser-api)

**Notte**

- **Limits:**
  - Advanced stealth is approval-gated — [Notte Stealth](https://docs.notte.cc/features/sessions/stealth-mode)
  - `ERR_TUNNEL_CONNECTION_FAILED` can mean "a site unsupported by our built-in proxies" — [Notte Proxies](https://docs.notte.cc/features/sessions/proxies)
  - The 5-session cap on Free returns 429 — [Notte Rate Limits](https://docs.notte.cc/api-reference/rate-limits)
  - `playwright_url` is not yet enabled — [Notte Playwright](https://docs.notte.cc/features/sessions/playwright)
- **Vault scope:** vault substitution works only in Notte's own `fill` / `form_fill` actions, not in raw CDP typing — [Notte Vaults](https://docs.notte.cc/concepts/vaults)

### Inferences

- **Fit for T45** (raw CDP, header or query-key injection, German residential IP, logins, persistent profiles):
  - **Browser Use** (US control plane with `proxyCountryCode=de`) covers the most requirements with documented features, at the lowest proxy price.
  - **Notte** is a close second. Its profiles also store session storage, and it has a secret-proxy design. Its region and terms are unknown.
  - **Airtop** has the cleanest key handling (Bearer header on CDP), but carries product-continuity risk and plan-gated BYO proxies.
- **Notte vault:** because Notte's vault substitution happens only in Notte's AI actions, a T45 agent typing through Playwright over CDP would have to use Notte's secret-proxy route, or type real passwords itself, to keep passwords out of the VM.

### Gaps

- I did not search for independent user complaints (Reddit, GitHub issues, HN) about Airtop or Notte. One search for BU plus Amazon found no specific GitHub issue.
- No hands-on test was done. Per the constraints, no account was created.
