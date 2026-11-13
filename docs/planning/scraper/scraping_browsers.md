# Scraping-oriented remote browsers as Bright Data Browser API replacements: Scrapeless, ZenRows, Oxylabs, Zyte

> Read date for every source below: 2026-11-12, unless a different date is given. Source ages are given where the page shows one. "Fetched" means I read the vendor page itself; "(search snippet, unverified)" means I only saw a search-engine summary. Several products have been renamed, so they are not separate products: **Oxylabs** "Unblocking Browser" was renamed "Headless Browser" on 2026-02-26 and is now documented and sold as **"Agent Browser"**. The old host was `ubc.oxylabs.io` and the current docs use `hb.oxylabs.io`. **ZenRows** "Scraping Browser" is now **"Zenrows Browser"** (just "Browser"). **Scrapeless** "Scraping Browser" is now called **"Agent Browser"** in its docs, site and pricing, and the doc URLs still use `/scraping-browser/`. **Zyte** has a real CDP product, the **"CDP headless browser"**, which is part of Zyte API.

## Connection: CDP endpoint, Playwright support, where the credential travels

### Takeaway

All four vendors offer a CDP endpoint that Playwright `connectOverCDP` can reach. Where the secret travels differs, and that decides how hard the host-proxy substitution is:

- **Query parameter** (simplest to substitute): ZenRows `?apikey=` and Scrapeless `?token=`.
- **URL userinfo**, which the client probably turns into an `Authorization: Basic` header: Oxylabs.
- **Explicit `Authorization: Basic base64(KEY:)` header** through an `https://` discovery endpoint: Zyte.

### Cited Findings

**Scrapeless (Agent Browser, formerly Scraping Browser)**

- Endpoint: `wss://browser.scrapeless.com/api/v2/browser?token=APIKey&sessionTTL=180&proxyCountry=ANY`. The token is the `token` query parameter, described as "The API key generated in the control panel" — [Scrapeless docs: Getting started](https://docs.scrapeless.com/en/scraping-browser/quickstart/getting-started/)
- Other query parameters: `sessionTTL`, `sessionName`, `sessionRecording`, `proxyURL`, `proxyCountry`, `proxyState`, `proxyCity`, `extensionIds`, `fingerprint`, plus `profileId` and `profilePersist`. Profiles are covered under the persistence question — [Getting started](https://docs.scrapeless.com/en/scraping-browser/quickstart/getting-started/); [Profiles](https://docs.scrapeless.com/en/scraping-browser/features/profiles)
- The intro says it is "Seamlessly integrated with tools like Puppeteer and Playwright". The getting-started page shows no Playwright `connectOverCDP` code; the sidebar lists a "CDP API" page, which I did not fetch — [Scrapeless docs: Introduction](https://docs.scrapeless.com/en/scraping-browser/quickstart/introduction/)

**ZenRows (Zenrows Browser, formerly Scraping Browser)**

- Endpoint: `wss://browser.zenrows.com?apikey=YOUR_ZENROWS_API_KEY`. The key is the `apikey` query parameter. Optional parameters are `proxy_region`, `proxy_country` and `session_ttl` — [ZenRows docs: Introduction to the Zenrows Browser](https://docs.zenrows.com/browser-sessions/introduction.md)
- Official Playwright examples use `p.chromium.connect_over_cdp(CONNECTION_URL)` and, in Node, `chromium.connectOverCDP(connectionURL)` with that URL — [ZenRows docs: Log in once and reuse the session](https://docs.zenrows.com/academy/browser/login-and-reuse-sessions.md)
- "The Zenrows Browser (formerly, Scraping Browser) is a cloud browser for real interaction, driven by your own CDP code." — [docs.zenrows.com/llms.txt](https://docs.zenrows.com/llms.txt)
- The browser blocks viewport and UA changes: "Methods like `page.setViewportSize()` or similar browser commands are blocked and will not take effect … Zenrows also restricts other browser-modifying actions, such as changing the user agent or certain device metrics." — [ZenRows Browser FAQ](https://docs.zenrows.com/browser-sessions/faq.md)

**Oxylabs (Agent Browser, formerly Unblocking Browser, then Headless Browser)**

- Endpoint: `wss://USERNAME:PASSWORD@hb.oxylabs.io?p_cc=US`. Features are added as query parameters such as `p_cc`, `solve_captcha`, `session_name` and `o_profile`. The doc's Python example calls `p.chromium.connect_over_cdp(browser_url)`. The Authentication row of the connection table reads verbatim: "In the URL, user info – `wss://USERNAME:PASSWORD@host`. Must include username suffix token (e.g. `user_ab12`). Building custom Authorization headers is not recommended." The Rate limits row reads "100 concurrent sessions, 10 session per second." — [Oxylabs docs: Agent Browser](https://developers.oxylabs.io/products/agent-browser.md)
- "Oxylabs Agent Browser uses the Chrome DevTools Protocol (CDP). You can connect to it using Playwright or Puppeteer without managing local browser binaries." The product is "fully compatible with Playwright, Puppeteer, and the Model Context Protocol (MCP)" — [Oxylabs Quick Start: Agent Browser](https://developers.oxylabs.io/get-started/quick-start-agent-browser.md)
- Changelog, 2026-02-26: "Unblocking Browser is now Headless Browser. This is a name change only". A changelog entry from 2025-11-25 uses the old host: `wss://user:pass@ubc.oxylabs.io?o_vnc=true` (live VNC inspection) — [Oxylabs docs full export, changelog section](https://developers.oxylabs.io/llms-full.txt)
- Oxylabs ships an MCP setup that runs `@playwright/mcp` with `--cdp-endpoint` pointed at its browser. This comes from a search snippet only (unverified) — [Oxylabs: Integration with MCP](https://developers.oxylabs.io/scraper-apis/unblocking-browser/integration-with-mcp)

**Zyte (Zyte API "CDP headless browser")**

- Playwright connects to the HTTP endpoint `https://browser.zyte.com/` with `connect_over_cdp(CDP_ENDPOINT, headers=headers)`. The header is `Authorization: Basic <base64("YOUR_ZYTE_API_KEY:")>`, the API key followed by a colon — [Zyte docs: CDP headless browser](https://docs.zyte.com/zyte-api/usage/cdp.md)
- A Puppeteer WebSocket endpoint, `wss://pop-us.browser.zyte.com/wss`, appears only in the fetch tool's summary of the HTML page and in a search snippet. The raw `.md` page I grepped contains no `wss` or `pop-` string, so treat this hostname as unverified — [Zyte docs: CDP (HTML)](https://docs.zyte.com/zyte-api/usage/cdp.html)
- Error `401` means "unknown API key, or credentials sent in the wrong part of the `Authorization` header". Session options are query parameters only, e.g. `https://browser.zyte.com/?ttl=600&proxy_region=GB&proxy_type=residential`. The page documents no way to put the credential in a query parameter — [Zyte CDP docs](https://docs.zyte.com/zyte-api/usage/cdp.md)

### Inferences

- **ZenRows and Scrapeless** fit the existing "replace a placeholder in a query parameter of the WebSocket upgrade" approach directly.
- **Oxylabs:** Playwright's `connectOverCDP` with `wss://user:pass@host` most likely sends the userinfo as an `Authorization: Basic base64(user:pass)` header on the upgrade request, because Node `ws` maps userinfo to `auth`. That would make it header-based on the wire. The base64 encoding covers the whole `user:pass`, so the host proxy must decode and replace the entire header value, not a substring. Passing an explicit `Authorization` header through `connectOverCDP({ headers })` with a placeholder may also work, but Oxylabs advises against it. Both points are inferred and untested.
- **Zyte:** connecting to an `https://` endpoint means Playwright first makes an HTTP discovery request (`/json/version`), then opens the WebSocket URL it gets back. That URL may be on another host (possibly `pop-*.browser.zyte.com`, unverified). The host proxy would have to inject or replace the Basic header on both requests and allow whatever host is returned. The header is base64 of `KEY:`, so a placeholder key needs whole-value substitution. Inferred, not verified on the wire.

### Gaps

- I did not fetch Scrapeless's "CDP API" page, so I have no official Playwright `connectOverCDP` example for Scrapeless. Compatibility is claimed but its edge cases are unverified.
- I did not confirm whether Oxylabs still accepts the old `ubc.oxylabs.io` host alongside `hb.oxylabs.io`.
- I did not confirm what WebSocket URL Zyte's `/json/version` returns for Playwright, or whether a non-US point of presence exists (relevant for EU latency).

## Logins: is password entry / scraping behind login allowed, blocked by default, or KYC-gated?

### Takeaway

Three of the four (Scrapeless, ZenRows, Oxylabs) say nothing in their public docs about a Bright-Data-style technical block on password entry. Zyte does document a block: Zyte API "automatically blocks login" on many sites. Whether that block reaches its CDP browser is unverified. The policies differ sharply:

- **ZenRows:** documents logins as a supported use case, with no KYC.
- **Oxylabs:** requires a KYC questionnaire from every customer. It blocks mail, banking, streaming and similar categories by default until extra KYC, and its AUP allows non-public data only with the site's permission.
- **Scrapeless:** its new AUP (effective 2026-08-07) explicitly forbids collecting data behind a login, which contradicts its own profile and MFA features.
- **Zyte:** gates the CDP browser behind business verification, which asks which sites you need to log into and may trigger legal review. Zyte API also "automatically blocks login" on many sites whose terms prohibit scraping. Whether that block applies to CDP sessions is unverified.

### Cited Findings

**Scrapeless**

- The AUP (Version 1.0, Effective and Last Updated 07 August 2026) lists these forbidden activities, among others:
  - "Collecting non-public information, meaning data located behind a login, a registration wall or a paywall."
  - "Circumventing the authentication or security measures of any host, network or account."
  - "Creating fake accounts or fake content."
  - "Use of streaming-related domains, including video, music or image streaming."
  - "Accessing, collecting or processing sensitive or special categories of data" — [Scrapeless Acceptable Use Policy](https://www.scrapeless.com/en/legal/acceptable-use-policy)
- Domain blocking: "Scrapeless proactively blocks certain web content at its sole discretion, including adult content, government websites and harmful domains. Scrapeless reserves the right to add or remove any web content block at any time" — [Scrapeless AUP](https://www.scrapeless.com/en/legal/acceptable-use-policy)
- KYC: "If you purchase a basic package, you don't need to complete KYC verification. However, if you need to unlock thread limits or customize an enterprise package, our sales representatives will ask you to complete a brief compliance process, also known as KYC … may include a quick introductory video call and some verification of your company or personal information." — [Scrapeless Pricing FAQ](https://www.scrapeless.com/en/pricing)
- The product itself is built for logins:
  - Profiles persist "storage, cookies, cache, and login states" — [Scrapeless docs: Profiles](https://docs.scrapeless.com/en/scraping-browser/features/profiles)
  - The "Real-time Signaling (MFA)" feature handles "unexpected SMS codes, email OTPs, or TOTP authentication" — [Scrapeless docs: Real-time Signaling](https://docs.scrapeless.com/en/scraping-browser/features/real-time-signaling)
  - A "GitHub MFA Automation" guide exists (search snippet, unverified) — [Scrapeless docs: GitHub MFA automation](https://docs.scrapeless.com/en/scraping-browser/guides/github-mfa-automation)
  - A blog post describes a "Credential System" with 1Password retrieval (search snippet, unverified) — [Scrapeless blog: Authentication and identity](https://ai.scrapeless.com/en/blog/authentication-and-identity)
- The Terms say the services "strictly prohibit any user from engaging in purposes that infringe on the interests of others, including but not limited to cybercrime, cracking, and fraudulent activities", and point to the AUP for prohibited activities — [Scrapeless Terms & Conditions](https://www.scrapeless.com/en/legal/terms)

**ZenRows**

- An official recipe, "Log in once and reuse the session", logs in with `page.fill("#password", …)` in the Browser, saves `storage_state`, and reuses it. It carries one warning: "Automate logins only for accounts you own or are authorized to use, and follow the site's terms." — [ZenRows docs: Log in once and reuse the session](https://docs.zenrows.com/academy/browser/login-and-reuse-sessions.md)
- The product page says the Browser helps when pages "require clicks, forms, login" and includes a credential-submission example (fetch-tool summary) — [ZenRows: Browser product page](https://www.zenrows.com/products/browser-sessions)
- Restricted categories: "Banks", "Credit Card Processors/Payment Gateways" (VISA, MasterCard, PayPal, Stripe), "Visas, eVisas, and Permits Websites", and "Governmental Websites: Mostly, those with `.gov` domain extensions". A blocked domain returns `400` with `"code": "REQS001"`. "We may also block other sites based on legal or ethical concerns." Appeals go to success@zenrows.com — [ZenRows: Forbidden Sites and Activities](https://docs.zenrows.com/forbidden-sites.md)
- Behaviour that can get an account suspended: "Brute Forcing Login Forms: Prohibited due to security concerns", "Extracting Private Personal Information: Against GDPR and other privacy laws", "Heavy Traffic Burden", "Scraping Copyrighted Content" — [ZenRows: Forbidden Sites and Activities](https://docs.zenrows.com/forbidden-sites.md)
- KYC: the Terms mention only e-mail validation at registration ("ZENROWS will send a link to validate the e-mail address"). I found no KYC or identity-verification requirement in the Terms or Browser docs — [ZenRows Terms and Conditions](https://www.zenrows.com/legal/terms.md)
- The Terms' list of prohibited uses (read in full) has no clause on logins, non-public data, or data behind authentication. The closest clauses are:
  - "Use the Services to gain an undue advantage, including any unlawful activities such as accessing government websites to obtain appointments, collecting data from third parties, or gathering information from websites for any unlawful, abusive, or misleading purposes"
  - "Impersonate other Clients by using their API keys, credentials, or create fake accounts to access the different Services"
  - "IT IS STRICTLY PROHIBITED TO COLLECT DATA OR URLS FROM THIRD-PARTY WEBSITES FOR PURPOSES THAT ARE UNLAWFUL, ABUSIVE OR IN CONTRAVENTION OF THE LAW, GOOD FAITH AND GENERALLY ACCEPTED CUSTOMS AND PRACTICES."

  — [ZenRows Terms and Conditions](https://www.zenrows.com/legal/terms.md)

- The forbidden-sites FAQ repeats that "brute forcing login forms, extracting private personal information against GDPR norms, or heavy traffic burden" can lead to suspension. It also says "scraping content directly from server IP addresses is not allowed. Only URLs with Fully Qualified Domain Names (FQDNs) can be scraped." The REQS001 example response is the "Zenrows API" `/v1` shape, and the FAQ does not mention the Browser — [ZenRows: Forbidden Sites FAQ](https://docs.zenrows.com/forbidden-sites.md)

**Oxylabs**

- "Every customer has to answer a KYC questionnaire to get access to our solutions." … "Only 75% of customers are approved. Each year at least quarter of all customer enquires are rejected". The questionnaire covers registered company name, industry, date of incorporation, address, business model, "Methodology of use", "Planned use case" and "Additional requests by the Risk team" — [Oxylabs: KYC Policy](https://oxylabs.io/kyc-and-safety)
- Agent Browser restricted targets (verbatim): "Some target categories are blocked by default and require a short KYC process with your Dedicated Account Manager to unlock." The categories:
  - Entertainment & streaming (Netflix, Spotify)
  - Banking/financial (PayPal, Bank of America, Binance)
  - Government (usa.gov)
  - Gaming
  - Ticketing
  - **Mailing (Outlook, Yahoo Mail)**
  - Ads
  - Third-party IP checkers

  The page says nothing about logins or password entry, and Amazon is not listed — [Oxylabs docs: Agent Browser restricted targets](https://developers.oxylabs.io/products/agent-browser/restricted-targets.md)

- The AUP (last updated June 25, 2024) prohibits two things:
  - Security breaches, for example "logging into a server or account that the Customer is not expressly authorized to access", and "Circumventing user authentication or security of any host, network or account".
  - Under "Automated data gathering", using the Services in a way that would "Be in violation of relevant terms of use/service" or "Include collecting or accessing non-public data. Unless the Customer has permission from the site, only publicly available data may be scraped"

  — [Oxylabs Acceptable Use Policy](https://oxylabs.io/legal/oxylabs-acceptable-use-policy)

- Separately, for the Residential Proxies product: "Accessing Residential Proxies from certain ASNs can return a `403 Access denied: restricted ASN` error if KYC verification is not completed" — [Oxylabs docs full export](https://developers.oxylabs.io/llms-full.txt)

**Zyte**

- The CDP browser is disabled until "business verification" is approved. "CDP sessions are not allowed on free trials." Business verification also gates "Setting ipType to residential". Before approval, "the connection is refused with an HTTP `403` status" — [Zyte docs: CDP headless browser](https://docs.zyte.com/zyte-api/usage/cdp.md); [Zyte docs: Business verification](https://docs.zyte.com/zyte-api/usage/business-verification.md)
- The business verification form asks for legal name, company registration number, country of registration, use case, and **"Do you need to log into any websites to collect data? — If yes, list the websites."** It also asks about personal data, republishing, media files and AI training. "Many applications are approved automatically … Depending on your answers, some are reviewed by our legal team first." "You can submit the form only once: afterwards it is locked, whether it is approved or declined." — [Zyte docs: Business verification](https://docs.zyte.com/zyte-api/usage/business-verification.md)
- "Compliance guardrails are built into Zyte API … site login mechanisms are restricted, and access to higher-trust infrastructure such as residential IPs requires KYC verification." FAQ: "Zyte respects website terms and applies automatic login restrictions to sites that explicitly prohibit scraping." — [Zyte API product page](https://www.zyte.com/zyte-web-scraping-api/)
- "Zyte API automatically blocks login for a large number of sites where their Terms of Service prohibit web scraping … any attempt to access the restricted sites behind a login page will not be permitted by Zyte API." The same post says that if you agree to ToS "by creating an account, by logging into a site … you must comply with the policies that you have agreed to." (Blog published 2024-03-15, modified 2025-09-18) — [Zyte blog: Compliant web scraping with AI](https://www.zyte.com/blog/compliant-web-scraping-with-ai/)
- The AUP forbids use "where You explicitly agree to terms of service prohibiting Your manner of access to, connection to or retrieval" (1.1.9). It also forbids using the Service to "scrape any data from LinkedIn's website" (1.1.10), "create fraudulent accounts" (4.1.1), and "breach security or authentication measures" (4.1.3). The AUP shows no date — [Zyte Acceptable Use Policy](https://www.zyte.com/terms-policies/acceptable-use-policy/)
- Zyte API returns HTTP 451 `/download/domain-forbidden` for domains it does not allow (search snippet, unverified) — [Zyte docs: errors](https://docs.zyte.com/zyte-api/usage/errors.html)

### Inferences

- **ZenRows** has the least friction for the T45 use case. Login is a documented, first-class flow, there is no KYC, its Terms have no "non-public data" or "behind a login" clause (unlike the Scrapeless and Oxylabs AUPs), and the blocked categories (banks, payment processors, visa sites, .gov) do not include Amazon or typical SaaS logins. The forbidden-sites page is written for the "Zenrows API" and does not name the Browser, so whether REQS001 blocking applies to Browser sessions is inferred, not verified.
- **Scrapeless** is technically capable, but its own AUP since 2026-08-07 contractually forbids exactly the "data behind a login" use case. Logins into the user's own accounts would be a breach on paper, even with no technical block. Treat it as policy-blocked unless Scrapeless confirms otherwise in writing.
- **Oxylabs:** logging into accounts the customer is "expressly authorized to access" is not prohibited by the AUP. However, collecting "non-public data" requires "permission from the site", and webmail targets are blocked by default. Every customer goes through a KYC questionnaire with a stated rejection rate of about 25%. This looks closest to Bright Data's gating in spirit, but there is no documented password-entry block.
- **Zyte:** the business-verification form explicitly asks which sites you log into, and Zyte API blocks login on sites whose ToS forbid scraping. Amazon's Conditions of Use are generally understood to prohibit robots and data mining (not verified here), so logged-in Amazon sessions through Zyte are likely to be refused or reviewed. Whether the automatic login block is enforced inside CDP sessions, where the client drives the browser, is not stated in the CDP docs.
- **For all four:** the restriction that matters most for "log into arbitrary websites on the user's behalf" is contractual (AUP and the target site's ToS), not a technical password-field block like Bright Data's.

### Gaps

- No vendor states in public docs whether password `<input type=password>` entry is technically intercepted in its CDP browser. Absence of a statement is not proof of absence. Only a hands-on test (not done; no sign-ups were allowed) or a written vendor confirmation would settle it.
- Whether ZenRows' REQS001 domain blocking covers Browser sessions is undocumented.
- Whether Zyte's "automatic login restrictions" apply to CDP sessions, and how they are signalled there (HTTP 451? navigation failure?), is undocumented.
- Whether Oxylabs' universal "KYC questionnaire" for self-service Agent Browser buyers is a light signup form or a manual review is not specified.
- Scrapeless's AUP is only 3 months old (v1.0). I found no earlier version or FAQ reconciling it with the Profiles and MFA features.

## Persistent logged-in state: profiles, session persistence, cookie reuse

### Takeaway

Oxylabs and Scrapeless offer server-side persistent profiles that keep cookies and localStorage across sessions. Oxylabs also offers 24 h reconnectable sessions and a pinned residential IP. ZenRows and Zyte have no server-side profiles: you save and restore state client-side with Playwright's `storageState` or the cookies API. Zyte explicitly says one CDP session's cookie jar or IP cannot be reused by another.

### Cited Findings

**Scrapeless**

- Profiles "allow you to persist user data" — "storage, cookies, cache, and login states". You attach one with `&profileId=…` on the WebSocket URL. Write-back needs `profilePersist=true`: "The data will be saved when the session is closed." With persistence on, "only the data from the last session to close will be saved." The page gives no profile-count limit and no retention period — [Scrapeless docs: Profiles](https://docs.scrapeless.com/en/scraping-browser/features/profiles)

**ZenRows**

- Persistence is client-side: save `context.storage_state(path="auth.json")`, then on the next session call `browser.new_context(storage_state="auth.json")`. Alternatives are `context.cookies()`/`add_cookies()`, the MCP tools `browser_get_cookies`/`browser_set_cookies`, and the CLI `zenrows browser cookies`. Troubleshooting note: "the site ties it to an IP. Log in again … and use the same `proxy_country` on both sessions" — [ZenRows docs: Log in once and reuse the session](https://docs.zenrows.com/academy/browser/login-and-reuse-sessions.md)
- The product page's "Sessions persist … Cookies, auth, open tabs, they stay alive across calls" applies within one live session, and "A session closes after 15 minutes" (fetch-tool summary) — [ZenRows Browser product page](https://www.zenrows.com/products/browser-sessions)

**Oxylabs**

- `o_profile` is a named persistent profile that saves "Cookies and localStorage". The intro also mentions cache. `o_profile_save` forces a save "during or at the end of the session". Profiles are retained **14 days from last use**. The default limit is **5 profiles**; past it you get a 403 "profile limit reached", and support can raise the limit — [Oxylabs docs: Persistent sessions and profiles](https://developers.oxylabs.io/products/agent-browser/persistent-sessions-and-profiles.md)
- Verbatim: `session_name` — "When defined, a session persist up to the maximum time-to-live (TTL) (max 24h or until stopped). Reconnect with the same session_name to reattach the same session ID and existing tabs." `keep_alive` — "While true, the session stays on in the cloud after you disconnect (up to 10 minutes). Requires session_name." "Persistent Sessions are enabled by default for all users, with a default limit of 5 concurrent sessions." `o_profile` — "Save/restore cookies and localStorage with a named profile (14 days from last use)." — [same page](https://developers.oxylabs.io/products/agent-browser/persistent-sessions-and-profiles.md)
- Oxylabs warns that saved cookies can be invalidated if a restored profile exits from a different residential IP. It recommends pairing profiles with `proxy_resi_ses_id` and `proxy_resi_ses_time` (up to 1440 min) — [same page](https://developers.oxylabs.io/products/agent-browser/persistent-sessions-and-profiles.md)

**Zyte**

- "a CDP connection already gives you a single browser, with one IP address and one cookie jar, for the life of the connection … What you cannot do is make a separate CDP connection … reuse the IP address or cookie jar of an existing or past CDP session." You get "full read and write access to cookies through your browser library's own API, e.g. Playwright's `context.cookies()` and `context.addCookies()`." "every session starts clean." — [Zyte docs: CDP headless browser](https://docs.zyte.com/zyte-api/usage/cdp.md)

### Inferences

- With ZenRows or Zyte, T45 would have to keep auth state (a `storageState` file) itself and re-inject it into each new remote session. Whether the VM or the host keeps it is a design choice; Playwright CLI's state save/load would work over CDP (inferred). Session cookies would pass through the VM either way.
- Without IP pinning (ZenRows, Zyte), sites that bind sessions to IP or ASN may force a re-login, possibly with 2FA, every session. ZenRows' only mitigation is keeping the same country.
- Oxylabs' 14-day retention means profiles for rarely used accounts silently expire.

### Gaps

- No vendor documents encryption at rest or retention of profile data beyond Oxylabs' 14-day rule. Scrapeless gives no retention period for profiles.
- Whether the Oxylabs and Scrapeless profile stores save IndexedDB or service-worker state is undocumented. This matters for some SPA logins.

## Proxies: residential, Germany targeting, sticky sessions

### Takeaway

All four can route through German IPs.

- **ZenRows:** residential is the default.
- **Oxylabs:** the Agent Browser uses its residential pool, with `p_cc=DE`, city targeting and a sticky exit IP for up to 24 h.
- **Scrapeless:** has country, state and city parameters but documents no IP-type parameter for the browser.
- **Zyte:** offers `proxy_region` plus `proxy_type=residential`, and residential needs business verification.

### Cited Findings

- **Scrapeless:** `proxyCountry` takes ISO codes ("ANY" picks one at random) and covers "195+ countries and territories". `proxyState` and `proxyCity` are also available. A custom `proxyURL` (`http://user:pass@ip:port`) takes precedence and is "only available to subscribers". The page does not say whether the built-in IPs are residential — [Scrapeless docs: Getting started](https://docs.scrapeless.com/en/scraping-browser/quickstart/getting-started/)
- **ZenRows:**
  - "Auto-rotate and Residential IPs are pre-configured and enabled by default for all users." — [ZenRows docs: Setup](https://docs.zenrows.com/browser-sessions/setup.md)
  - `proxy_country` example: `wss://browser.zenrows.com?apikey=…&proxy_country=es`. Germany `de` is listed. "Zenrows supports residential IPs from over 100 countries worldwide." — [ZenRows docs: Country targeting](https://docs.zenrows.com/browser-sessions/features/country.md)
  - The intro claims "over 55 million residential IPs across 190+ countries" — [ZenRows Browser intro](https://docs.zenrows.com/browser-sessions/introduction.md). This conflicts with the "over 100 countries" on the country page.
  - The Browser docs mention no sticky-IP parameter; each connection gets "its own residential IP" — [ZenRows docs: Parallel sessions](https://docs.zenrows.com/academy/browser/parallel-sessions.md)
- **Oxylabs:**
  - Only the "residential proxy pool" is described. `wss://USER:PASS@hb.oxylabs.io?p_cc=DE` targets Germany. City targeting such as `p_city=berlin` is best-effort and falls back to the country. Sticky exit IP: `proxy_resi_ses_id` (3–36 chars) plus `proxy_resi_ses_time` (1–1440 min). By default every new connection gets a fresh IP — [Oxylabs docs: Geolocation and proxy selection](https://developers.oxylabs.io/products/agent-browser/geolocation-and-proxy-selection.md)
  - A February 2026 changelog note says Deutsche Telekom IPs were added to the ISP proxy pools. That is a different product, not shown to apply to Agent Browser — [Oxylabs docs full export](https://developers.oxylabs.io/llms-full.txt)
- **Zyte:**
  - `proxy_region` takes "the same 2-letter country code accepted by geolocation"; by default it picks "the most fitting geolocation based on the first target website". `proxy_type` is `datacenter` or `residential`, by default "the type that best avoids bans on the first target website" — [Zyte docs: CDP](https://docs.zyte.com/zyte-api/usage/cdp.md)
  - "Setting ipType to residential" is disabled until business verification — [Zyte docs: Business verification](https://docs.zyte.com/zyte-api/usage/business-verification.md)
  - The product page says residential "requires KYC verification" — [Zyte API product page](https://www.zyte.com/zyte-web-scraping-api/)

### Inferences

- For "German residential IP, same IP across sessions", only Oxylabs documents it end to end.
- With Zyte, `proxy_region=DE` on amazon.de would probably pick residential automatically if Zyte judges it best, but forcing it needs verification.

### Gaps

- I did not confirm that `DE` is in Zyte's geolocation country list. It is very likely but was not fetched.
- Scrapeless's browser IP type (residential, ISP or datacenter) is not stated on the pages I read.

## Anti-bot, CAPTCHA solving, and Amazon evidence

### Takeaway

Oxylabs documents built-in CAPTCHA solving (`solve_captcha=true`) and a challenge-handling `page_handler`. Scrapeless claims to bypass CAPTCHAs. ZenRows says outright that its Browser **cannot solve CAPTCHAs**. Zyte says it manages CAPTCHAs, but its CDP sessions get none of the background ban-avoidance that its regular API requests get. No vendor publishes amazon.de-specific success evidence for its CDP browser.

### Cited Findings

- **Scrapeless:** the intro says the service "bypasses common obstacles like IP blocking and CAPTCHAs" — [Scrapeless docs: Introduction](https://docs.scrapeless.com/en/scraping-browser/quickstart/introduction/). It sells a separate "Amazon Scraper" API, listed in the site footer — [Scrapeless Terms page footer](https://www.scrapeless.com/en/legal/terms). A blog tutorial covers a Node.js Amazon scraper using its cloud browser (search snippet, unverified) — [Scrapeless blog: Node.js Amazon scraper](https://www.scrapeless.com/en/blog/nodejs-amazon-scraper)
- **ZenRows:** "At the moment, the Zenrows Browser cannot solve CAPTCHAs. You will need to handle CAPTCHA solving through third-party services if required." The FAQ points to the Fetch API for "antibot capabilities, anti-CAPTCHAs" — [ZenRows Browser FAQ](https://docs.zenrows.com/browser-sessions/faq.md). The docs list a 2Captcha integration — [docs.zenrows.com/llms.txt](https://docs.zenrows.com/llms.txt)
- **Oxylabs:** `solve_captcha` gives "Automatic, real-time CAPTCHA solving on page loads". `page_handler` "Identifies pages and handles access challenges". `p_fp_tag` selects fingerprint profiles, and `p_src=oxybrowser` selects the proprietary engine — [Oxylabs docs: Agent Browser](https://developers.oxylabs.io/products/agent-browser.md). The quick start says it "handles bot traffic control systems, CAPTCHAs, and proxy rotation automatically" — [Oxylabs Quick Start](https://developers.oxylabs.io/get-started/quick-start-agent-browser.md). Oxylabs has dedicated Amazon sources (product, search, pricing, best-sellers, with currency) in its separate Web Scraper API — [Oxylabs docs full export, changelog](https://developers.oxylabs.io/llms-full.txt)
- **Zyte:** "Zyte manages the browser infrastructure, proxy routing, TLS fingerprinting, and CAPTCHA management". However, "Browser requests also benefit from ban-avoidance work Zyte may do behind the scenes … CDP gives you none of that: every session starts clean … at the cost of a potentially lower success rate on sites where Zyte's automatic measures would otherwise help." — [Zyte docs: CDP](https://docs.zyte.com/zyte-api/usage/cdp.md)
- **Independent, secondary:** a 2026 guide reports 35–55% success for plain Playwright against Amazon product pages without anti-detection, and notes that a German IP on amazon.com redirects to amazon.de (search snippet, unverified) — [HackerNoon: I tried every way to scrape Amazon in 2026](https://hackernoon.com/i-tried-every-way-to-scrape-amazon-in-2026-here-is-what-actually-works)

### Inferences

- **ZenRows:** with no CAPTCHA solving, Amazon's occasional "Type the characters you see" interstitial would need handling by the agent or an outside solver.
- **Zyte:** the CDP mode trades away its strongest feature, so Amazon success rates over CDP may be worse than its HTTP or browser API.
- **Oxylabs:** looks strongest on paper for unattended Amazon access.

### Gaps

- I found no vendor-published Amazon or amazon.de success rate for any of the four CDP browsers, and no independent benchmark covering them on Amazon. A hands-on test is needed.
- None of the restricted-target lists I read names Amazon. Oxylabs, ZenRows and Scrapeless list categories only, and Zyte's domain-forbidden list is not public.

## Limits, data retention, GDPR/DPA, incorporation

### Takeaway

Maximum session durations are short:

- **ZenRows:** 15 min.
- **Scrapeless:** 15 min "recommended", longer possible.
- **Zyte:** 1 h.
- **Oxylabs:** up to 24 h with `session_name`.

Concurrency is plan-bound. Oxylabs documents 100 concurrent sessions, Zyte returns 429 at an organization cap, ZenRows matches the plan, and Scrapeless needs KYC to raise "thread limits". ZenRows (Spain) and Zyte (Ireland) are EU entities with DPAs in their terms. Scrapeless is run by NST LABS TECH LTD., whose country I could not confirm.

### Cited Findings

- **Scrapeless:**
  - `sessionTTL` defaults to 180 s, range 60–900 s, "recommended maximum 15 minutes, but longer times can be set" — [Scrapeless docs: Getting started](https://docs.scrapeless.com/en/scraping-browser/quickstart/getting-started/)
  - KYC is needed "to unlock thread limits" — [Scrapeless Pricing FAQ](https://www.scrapeless.com/en/pricing)
  - Operator: "Scrapeless — operated by NST LABS TECH LTD." — [Scrapeless AUP](https://www.scrapeless.com/en/legal/acceptable-use-policy). The sales team works in "Singapore Standard Time (UTC+08:00)" — [Scrapeless Pricing](https://www.scrapeless.com/en/pricing)
  - Privacy: personal data is kept "for as long as it is necessary" — [Scrapeless Privacy Policy](https://www.scrapeless.com/en/legal/privacy-policy)
- **ZenRows:**
  - `session_ttl` minimum 60, maximum 900 s (1–15 min), default 180 — [ZenRows Browser intro](https://docs.zenrows.com/browser-sessions/introduction.md)
  - "Raise `MAX_SESSIONS` to match your plan's concurrency … Some connections are refused while others run: more sessions are open than your plan's concurrency." — [ZenRows docs: Parallel sessions](https://docs.zenrows.com/academy/browser/parallel-sessions.md)
  - Contracting entity is "ZENROWS, S.L.". "ZENROWS shall act as the Data Processor … the Parties hereby incorporate a Data Processing Agreement (DPA)". B2B disputes go to the "Court and Tribunals of Bilbao (Spain)". Term changes come with 30 days' notice — [ZenRows Terms and Conditions](https://www.zenrows.com/legal/terms.md)
- **Oxylabs:**
  - Rate limits: "100 concurrent sessions, 10 session per second". Under limits you can raise through support: "Higher rate limits – increase beyond 100 concurrent sessions / 10 per second" and "Restricted targets – unlock more target categories via KYC process." A leaked session "consumes one of your 100 concurrent sessions until it is reclaimed" — [Oxylabs docs: Agent Browser](https://developers.oxylabs.io/products/agent-browser.md)
  - Persistent (named) sessions: 5 concurrent by default, up to 24 h; profiles: 5 by default, 14-day retention — [Oxylabs docs: Persistent sessions and profiles](https://developers.oxylabs.io/products/agent-browser/persistent-sessions-and-profiles.md)
  - `record=true` records session video, and VNC live inspection exists (`o_vnc=true`) — [Oxylabs docs: Agent Browser](https://developers.oxylabs.io/products/agent-browser.md); [changelog](https://developers.oxylabs.io/llms-full.txt)
- **Zyte:**
  - `ttl` 15–3600 s, default 60. The session stays reserved and billed until `ttl` even after disconnect. Playwright's `browser.close()` does not end the session, so you must send the CDP `Browser.close` command. HTTP `429` is returned when "you have reached the maximum number of concurrent browsers for your organization" — [Zyte docs: CDP](https://docs.zyte.com/zyte-api/usage/cdp.md)
  - Contracting entity is "Zyte Group Limited, an Irish limited company with the registered company number 492771". Non-US customers fall under Irish law. A DPA is at zyte.com/terms-policies/dpa — [Zyte Terms of Service](https://www.zyte.com/terms-policies/terms-of-service/)

### Inferences

- **Session length:** ZenRows' and Scrapeless's 15-minute default ceiling, and Zyte's 1 h, are short for an agent working an interactive task. T45 would have to re-create sessions and re-inject state mid-task.
- **Zyte billing:** a session is billed until its `ttl` unless `Browser.close` is sent, so a host-side cleanup that sends `Browser.close` would be needed.

### Gaps

- I did not find Oxylabs' legal entity (believed to be Lithuanian, unverified) or its DPA URL.
- I did not find Scrapeless / NST LABS TECH LTD.'s country of incorporation, a DPA, or GDPR transfer terms.
- No vendor documents per-session navigation or domain limits for its CDP browser. I found none, and Bright Data-style per-session domain limits were not mentioned.
- Retention of session recordings (Scrapeless `sessionRecording`, Oxylabs `record`) is undocumented on the pages I read.

## Pricing (secondary)

### Takeaway

Pricing is bandwidth- or time-based:

- **ZenRows:** credits per minute plus per GB.
- **Oxylabs:** per GB, $8 falling to $4.
- **Zyte:** tier units per `page.goto` or per 15 s of session.
- **Scrapeless:** prepaid CU balance; I did not extract browser rates.

### Cited Findings

- **ZenRows:** "Bandwidth is metered at a flat **25,000 credits per GB** on every plan, plus a flat **5 credits per minute** of session time." This is the same shared credit balance as other ZenRows products — [ZenRows Browser intro](https://docs.zenrows.com/browser-sessions/introduction.md). The free plan has "5,000 credits every month" (fetch-tool summary) — [ZenRows Browser product page](https://www.zenrows.com/products/browser-sessions)
- **Oxylabs:** the Agent Browser costs $8/GB at the low tiers, $7.5 up to 13 GB, $5.5 up to 90 GB and $4 at 625+ GB, billed both directions. Plans: Starter $15/mo, Basic $100/mo, Flexible $500/mo, Enterprise from $2,500/mo. New accounts get a one-time $5 welcome credit (fetch-tool summary) — [Oxylabs pricing: Agent Browser](https://oxylabs.io/pricing/headless-browser)
- **Zyte:**
  - Units consumed per session = max(number of `page.goto()` calls, ceil(duration / 15 s)), priced at the tier of the first `page.goto()` domain. Residential sessions have a per-unit bandwidth cap, with per-GB overage — [Zyte docs: CDP pricing](https://docs.zyte.com/zyte-api/usage/cdp.md)
  - Pay-as-you-go needs a spending limit ($100/mo PAYG, or $200–$2,500 with commitment). There is a $5 free credit, but CDP is not available on the free trial — [Zyte docs: Pricing](https://docs.zyte.com/zyte-api/pricing.md)
- **Scrapeless:** "When you purchase a package, we pre-deposit the amount into your balance … the system deducts CUs from your balance". Payment via Stripe, PayPal, Alipay, wire or crypto — [Scrapeless Pricing](https://www.scrapeless.com/en/pricing)

### Inferences

- An agent session idling on an interactive login costs time on ZenRows and Zyte but almost nothing on Oxylabs, whose bandwidth-only pricing does not charge for idle time.

### Gaps

- Scrapeless Agent Browser per-hour or per-GB rates were not extracted; the pricing page content is mostly rendered client-side.
- Zyte's per-tier dollar prices for amazon.de were not looked up; they are on zyte.com/pricing.
