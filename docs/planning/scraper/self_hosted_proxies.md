# Self-hosted remote browser + residential proxy + own anti-bot (alternative to a cloud browser service)

Scope: Chrome/Chromium running outside the agent microVM (runner host or separate machine), reached by `@playwright/cli` in the VM over CDP, egressing through a residential/mobile proxy, with our own stealth and CAPTCHA handling. All pages read on 2026-11-12 unless marked otherwise. Many vendor pages carry no date ("undated"). "Search summary" marks a claim taken from a search-engine digest of the page rather than a full fetch; treat those as slightly weaker than quoted fetches.

## Residential/mobile proxy providers usable from a self-hosted browser (KYC, restricted use, Germany, sticky sessions, auth, price)

### Takeaway

Unlike Bright Data (whose new Residential zones since 7 July 2026 require company-only, human-reviewed KYC scoped to an approved use case), Decodo, IPRoyal, Oxylabs and Webshare publish residential restrictions by target domain/category (banking, government, mail, streaming, ticketing, gaming), not by "logins" as such; none of the restricted lists read names Amazon or e-commerce (but only IPRoyal's list was read as a complete list; Oxylabs' is "not limited to", Decodo's "Business" category is undefined, Webshare's list was not read), and Webshare's AUP only prohibits abusive login activity (credential stuffing, account takeover, mass account creation). SOAX makes identity verification a condition of any paid access. NetNut's network was disrupted by Google/FBI in July 2026 and should be excluded. Keeping logins needs a stable IP: rotating residential sticky sessions top out at 24 h (Decodo, Oxylabs) or 7 days (IPRoyal) and can drop early when the residential device goes offline.

### Cited Findings

#### Bright Data residential (comparison)

- "There is no automatic, instant or self-serve path to the Residential network." Every request gets human-reviewed KYC; update expected within 48 hours. While pending, ISP/datacenter proxies or Web Unlocker can be used. — [Bright Data docs: Residential network access](https://docs.brightdata.com/proxy-networks/residential/network-access)
- "The KYC requirement applies only to new Residential zones created after July 7, 2026"; for new zones KYC is required for every Residential type (shared rotating IPv4, Mega Pool, IPv6, dedicated). Older zones and already-verified customers keep access. — [Bright Data docs: Residential network access](https://docs.brightdata.com/proxy-networks/residential/network-access)
- "Residential proxies are available only to verified companies"; personal email domains (Gmail, Outlook) not eligible; "Bright Data is a B2B platform and supports business-related use cases only." — [Bright Data docs: Residential network access](https://docs.brightdata.com/proxy-networks/residential/network-access)
- "Requests to domains or categories outside your approved use case are blocked" (`Access denied`); government sites blocked on all networks; expanding targets means updating the KYC use case with compliance. — [Bright Data docs: Residential network access](https://docs.brightdata.com/proxy-networks/residential/network-access)
- Browser API: password entry is disabled by default so that no data behind a login is collected, per Bright Data's AUP; enabling it requires KYC then compliance approval (search summary). — [Bright Data docs: Browser API KYC and access](https://docs.brightdata.com/scraping-automation/scraping-browser/kyc-and-access)
- A 2022 residential "no-KYC mode" (vetted site list) is superseded by the current docs (older info). — [Proxyway, 2022](https://proxyway.com/?p=9462)

#### Decodo (ex-Smartproxy)

- Residential restricted-by-default categories: Banking/financial, Government, Entertainment (e.g. Netflix), Apple/Google stores, Ticketing, Gaming, Mailing*, Streaming*, Business*, Telecommunications. Starred categories "can be unblocked after ID verification with rotating" Residential subscriptions; other targets can be requested via support. No mention of logins, account creation, Amazon/e-commerce or social media. Undated. — [Decodo help: Residential proxy restricted targets](https://help.decodo.com/docs/residential-proxy-restricted-targets)
- ID verification for individuals: government ID (passport, ID card or driver's licence) + selfie, "automatically reviewed for authenticity"; businesses can submit a KYB form (company details, use case, target websites) instead. Verification is framed as unlocking blocked categories; users must be over 18. — [Decodo help: ID verification](https://help.decodo.com/docs/id-verification)
- Decodo runs new customers through automated fraud checks and, "when needed", KYC and third-party screening (search summary). — [Decodo security & compliance](https://decodo.com/security-compliance)
- Auth: either whitelisted IP or proxy users (user:pass); "your first proxy user and password are created automatically." Country selection plus city/state/ZIP(US only)/ASN targeting. Sticky "Sessions of up to 24 hours can be selected"; longer sessions risk early rotation because the residential device may go offline. Endpoint `gate.decodo.com:7000`; protocols HTTP, HTTPS, SOCKS5; whitelisted-IP session control "is supported only by the HTTPS protocol". — [Decodo help: Residential quick start](https://help.decodo.com/docs/residential-proxy-quick-start)
- Price: starting at about $2/GB (third-party listing; tiers not verified on Decodo's site). — [HackerNoon roundup](https://hackernoon.com/10-best-residential-proxies-for-developers-2026?embedable=true)

#### IPRoyal

- Residential domain access terms: permanently blocked: Secure.gsb-yourbank.com, Digital.iberiabank.com, Wyndlabs.ai. Unlock after identity confirmation: Login.yahoo.com, Login.live.com, Linkedin.com, Ticketswap, listed banks. Unlock after identity confirmation + >$500 spend: all .gov sites, PlayStation sites. No Amazon/e-commerce restriction; no general rule on logins. — [IPRoyal docs: Domain access terms](https://docs.iproyal.com/proxies/residential/domain-access-terms)
- KYC policy applies to new and existing customers; unverified accounts get limited access (restricted items include the Residential Proxies API and some websites) (search summary). — [IPRoyal blog: KYC](https://iproyal.com/blog/kyc-enhances-security-trust-proxy-networks/)
- Static residential (ISP) users must go through KYC (search summary). — [IPRoyal static residential](https://iproyal.com/static-residential-proxies/)
- Proxy string = host, port, username, password; targeting/rotation is set in the password segment; the page lists `proxy.iproyal.com` under a Germany _entry_ region (gateway location, not evidence of German exit IPs) and `geo.iproyal.com` for automatic region selection. — [IPRoyal docs: Residential proxy](https://docs.iproyal.com/proxies/residential/proxy)
- Sticky lifetime from 1 second to 7 days (`_lifetime-` parameter) per IPRoyal docs (search summary); one third-party page lists 24 h instead (conflict; IPRoyal's own docs take precedence). — [IPRoyal docs: rotation](https://docs.iproyal.com/proxies/residential/proxy/rotation); [IPRoyal quick-start](https://iproyal.com/blog/residential-proxies-quick-start-guide/); [TrustMyIP (secondary)](https://trustmyip.com/blog/best-rotating-proxies)
- Price: ~$7.00/GB at 1 GB down to ~$1.75/GB in bulk; traffic non-expiring (third-party summary). — [use-apify.com IPRoyal pricing 2026](https://use-apify.com/blog/iproyal-pricing-plans-2026); official page: [IPRoyal residential pricing](https://iproyal.com/pricing/residential-proxies)

#### Oxylabs

- Residential restricted targets ("includes but is not limited to"): Entertainment/streaming (Netflix, Spotify, Twitch, Disney), Banking/financial (PayPal, Bank of America, Binance), Government (usa.gov, canada.ca), Gaming (PlayStation, Steam), Ticketing (Ticketmaster, Eventbrite), Mailing (Outlook, Yahoo mail), Ads (Google Tag Manager, DoubleClick), IP-check sites. "Some targets can be enabled after going through a short KYC procedure." No mention of Amazon, e-commerce, social media or logins. Undated. — [Oxylabs docs: Residential restricted targets](https://developers.oxylabs.io/products/proxies/residential-proxies/restricted-targets)
- Advanced residential filters (IP version, OS) may require quick KYC (search summary). — [Oxylabs help: restricted targets](https://developers.oxylabs.io/help-center/most-popular-questions/restricted-targets-proxy-solutions-and-web-scraper-api)
- Secondary claim, not confirmed on an Oxylabs page: every customer answers a KYC questionnaire (company, contact, use case) and a share of enquiries is rejected. — [cipherssecurity.com, Nov 2026 (secondary)](https://cipherssecurity.com/bright-data-vs-oxylabs-vs-decodo-2026/)
- Country and session go in the username (`customer-USER-cc-DE-sessid-X-sesstime-N`, minutes); max 24 h (1440 min); `sessid` gets a new IP if the exit node goes offline, `sessid_oneip` pins one exit node and returns HTTP 502 when it disappears (search summary of docs). — [Oxylabs docs: Session control](https://developers.oxylabs.io/products/proxies/residential-proxies/session-control)
- Price: starting ~$6/GB (third-party listing). — [HackerNoon roundup](https://hackernoon.com/10-best-residential-proxies-for-developers-2026?embedable=true)

#### SOAX

- KYC Policy v1.0 (effective/last updated 1 June 2026; metadata 2026-06-24): "Identity verification is a condition of access to the paid Platform." Owner, and where applicable the business entity and representatives, must verify; documents can include identity/contact details, business registration, tax ID, beneficial ownership and ID copies; third-party verification providers used (help center names Sumsub, per search summary). Usage rules are in a separate AUP not retrieved. — [SOAX legal: KYC](https://soax.com/legal/kyc); [SOAX help: identity verification via Sumsub](https://helpcenter.soax.com/en/articles/7127940-identity-verification-with-soax)
- SOAX's "available and restricted use cases" help article returned HTTP 404. — [SOAX help (404)](https://helpcenter.soax.com/en/articles/6666774-available-and-restricted-use-cases)

#### Webshare

- "Some websites are restricted on our Residential Proxy network. Certain targets can be unblocked after completing a brief KYC procedure." Static residential/datacenter proxies have per-site rate limits; exceeding them can trigger automated verification (brief KYC) during which proxy access may be paused (search summary + Webshare staff reply on Proxyway). — [Webshare help: restricted websites](https://help.webshare.io/en/articles/10068143-restricted-websites-on-our-residential-proxy-network); [Webshare help: rate limits](https://help.webshare.io/en/articles/10068156-rate-limits-for-static-residential-and-datacenter-proxies); [Proxyway Webshare review](https://proxyway.com/reviews/webshare-proxies/feed)
- Restricted activities: prohibited "Account takeover attempts, credential stuffing, or automated login abuse", "Mass creation of accounts on sensitive websites (e.g., betting platforms)", carding/payment fraud, spam, ticket scalping. Login pages are not blocked, but high request volume can trigger rate limits. — [Webshare help: restricted activities](https://help.webshare.io/en/articles/9987853-restricted-activities-with-webshare-proxies)
- Username parameters `{username}-{country_code}-{geo_params}-{session_id}`; city targeting on residential; numeric session ID = sticky, `rotate` = rotating; docs include a German-city sticky example (search summary). — [Webshare API docs: Proxy connection](https://apidocs.webshare.io/proxy-connection)

#### NetNut (exclude)

- Google Threat Intelligence Group, the FBI, Lumen and others disrupted NetNut (tracked as Popa) around 2 July 2026: ≥2 million devices (mostly smart TVs/streaming boxes), operator linked to Israel-listed Alarum Technologies; FBI seized several domains; Google calls it "significant degradation". GTIG assessed with high confidence that several popular residential proxy brands white-label NetNut. Alarum disputes the "botnet" label; as of its 13 July 2026 update operations remained disrupted (search summaries of news reports). — [The Hacker News, July 2026](https://thehackernews.com/2026/07/google-disrupts-netnut-residential.html); [SiliconANGLE, 2 July 2026](https://siliconangle.com/2026/07/02/google-disrupts-netnut-residential-proxy-network-built-2-million-devices/); [SecurityWeek](https://www.securityweek.com/google-fbi-disrupt-netnut-residential-proxy-network-powered-by-millions-of-devices/amp/)
- Spur tags NETNUT_PROXY with no strict KYC or abuse process (third-party, possibly dated). — [Spur: NETNUT_PROXY](https://spur.us/tags/NETNUT_PROXY)

#### Rayobyte

- No Rayobyte KYC or restricted-target page found; Proxyway says the residential service emphasises ethics, "meaning that the number of supported use cases may be limited". — [Proxyway Rayobyte review](https://proxyway.com/reviews/rayobyte-proxies)

#### Market price range

- Residential typically ~$1 to $15/GB depending on volume (third-party aggregators; vendor sources conflict). — [AIMultiple proxy pricing](https://aimultiple.com/proxy-pricing); [DataImpulse (competitor) pricing comparison](https://dataimpulse.com/blog/residential-proxy-pricing-comparison/)

### Inferences

- A proxy only sees hostnames (CONNECT to `www.amazon.de`), so provider "login" limits are domain lists (e.g. IPRoyal gates `login.live.com`, `login.yahoo.com`) plus AUP wording, not a technical block on typing passwords. Logging in to an ordinary site through Decodo, IPRoyal, Oxylabs or Webshare residential does not appear to need KYC; Bright Data-style "no data behind login" is not in these providers' published rules.
- amazon.de is not on any restricted list read. Decodo's "Business" category is undefined on its page, so whether amazon.de falls in it is unknown (see Gaps).
- Per-provider fit for "German IP + stable login, no KYC": Decodo, IPRoyal and Webshare are the candidates that _may_ work without KYC for amazon.de and generic logins, but this is unconfirmed: IPRoyal's blog says unverified accounts get limited access, Webshare's restricted list was not read, Decodo's "Business" category is undefined, and German exit targeting was not confirmed from a fetched page for any of them. Verify with each vendor before committing. Oxylabs may require a questionnaire (unconfirmed); SOAX requires verification for any paid use; Bright Data residential requires company KYC; NetNut is out. Static ISP residential (best for long logins) is a separate product and at IPRoyal requires KYC.
- Because GTIG says several brands white-labelled NetNut, the sourcing of a provider's pool is a due-diligence item, not just price.
- For login persistence, a sticky session is not a guarantee: Decodo and Oxylabs both document that the IP can change early when the peer device goes offline, so sites may see IP changes mid-session. Pinning one IP (Oxylabs `sessid_oneip`) trades that for 502 errors.

### Gaps

- No primary source for Rayobyte's or NetNut's KYC/AUP; Oxylabs' "KYC for every customer" is secondary only.
- Decodo's "Business" category definition and whether it covers amazon.de or other e-commerce; Decodo/Oxylabs/IPRoyal AUP wording on logins (only Webshare's retrieved).
- Official current per-GB prices (vendor pricing pages not fetched; only third-party figures); mobile proxy KYC rules not checked.
- Whether Decodo/Webshare static (ISP) German residential requires KYC.
- Max sticky duration for Webshare residential not found.
- German exit targeting not confirmed from a fully fetched page for any provider: Oxylabs (`cc-DE`) and Webshare (German-city example) come from search digests only; Decodo's quick-start does not name Germany; IPRoyal's `_country-de` syntax unverified.
- IP-whitelist authentication confirmed only for Decodo; not checked for IPRoyal, Oxylabs, Webshare (matters for launching plain Chrome, whose `--proxy-server` cannot carry credentials).

## Running Chrome as a remote browser for Playwright (browserless, plain CDP, launchServer, Steel, per-session proxy, isolation)

### Takeaway

`@playwright/cli` can attach to a remote Chromium over CDP (`attach --cdp=<url>`, config `browser.cdpEndpoint` + `cdpHeaders`) or to a Playwright server (`browser.remoteEndpoint`), so both plain `chrome --remote-debugging-port` and `launchServer`-style servers are reachable; CDP is lower fidelity and has no authentication of its own. Chrome's `--proxy-server` cannot carry proxy credentials, so authenticated residential proxies need Playwright's proxy option, per-context proxies, provider IP whitelisting, or a credential-adding forwarder. Browserless self-hosted is SSPL-or-commercial (commercial use needs a paid licence); Steel Browser is Apache-2.0 with per-session `proxyUrl`.

### Cited Findings

- `@playwright/cli` attach options: `playwright-cli attach --cdp=chrome` (running Chrome/Edge by channel), `attach --cdp=<url>` (CDP endpoint), `attach --extension=chrome`, `detach` leaves the external browser running. Config: `browser.cdpEndpoint`, `browser.cdpHeaders` ("CDP headers to send with the connect request"), `browser.cdpTimeout` (default 30 s), `browser.remoteEndpoint` ("Remote endpoint to connect to an existing Playwright server"), `browser.browserName` (`chromium|firefox|webkit`), `browser.userDataDir`, `browser.isolated`, plus `launchOptions`, `contextOptions`, `initScript`, `network`. Local use needs Playwright 1.59+. — [microsoft/playwright-cli README](https://github.com/microsoft/playwright-cli)
- `connectOverCDP`: "only supported for Chromium-based browsers"; "significantly lower fidelity than the Playwright protocol connection". `connect()` attaches to a `launchServer` browser via its `wsEndpoint`; client and server Playwright major.minor must match. `launchServer` binds to localhost by default; binding wider (e.g. `0.0.0.0`) exposes the browser RPC to anything reaching the port. — [Playwright docs: BrowserType](https://playwright.dev/docs/api/class-browsertype)
- `launchPersistentContext(userDataDir)`: stores cookies/local storage; "browsers do not allow launching multiple instances with the same User Data Directory"; "automating the default Chrome user profile is not supported". — [Playwright docs: BrowserType](https://playwright.dev/docs/api/class-browsertype)
- Chrome 136+: `--remote-debugging-port`/`--remote-debugging-pipe` are no longer respected on the default data directory and must be paired with a non-default `--user-data-dir` (rationale: infostealers abusing the switches); does not affect Chrome for Testing or Chromium (search summary). — [Chrome for Developers blog: remote debugging switch changes](https://developer.chrome.com/blog/remote-debugging-port)
- Playwright proxies can be set "globally for the entire browser, or for each browser context individually"; optional username/password for HTTP(S) proxies. — [Playwright docs: Network, HTTP proxy](https://playwright.dev/docs/network#http-proxy)
- Chromium's `--proxy-server` switch does not accept username/password (Chromium developer on chromium-dev); Chrome shows an auth prompt instead; workarounds are extensions using `chrome.proxy`/auth handling or answering the auth challenge via the automation API (e.g. Puppeteer `page.authenticate()`) (search summary; threads are older but no contrary source found). — [chromium-dev thread](https://groups.google.com/a/chromium.org/g/chromium-dev/c/x-GDesVs1eI); [headless-dev thread](https://groups.google.com/a/chromium.org/g/headless-dev/c/KOR84u-FNU0); [Apify blog (older)](https://blog.apify.com:443/how-to-make-headless-chrome-and-puppeteer-use-a-proxy-server-with-authentication-249a21a79212)
- Browserless licence: SPDX `SSPL-1.0 OR Browserless Commercial License`; building commercial sites/apps or use in closed-source CI requires purchasing a commercial licence. — [browserless LICENSE](https://raw.githubusercontent.com/browserless/browserless/main/LICENSE)
- Steel Browser: Apache-2.0; "Uses Puppeteer and CDP for complete control over Chrome instances", connect with Puppeteer, Playwright or Selenium; "Built-in proxy chain management for IP rotation"; sessions accept `proxyUrl`, the sessions endpoint can relaunch the browser with custom options/extensions; "Includes stealth plugins and fingerprint management"; keeps cookies/local storage across requests. README does not document isolation/concurrency model, CAPTCHA handling or release dates. — [steel-dev/steel-browser](https://github.com/steel-dev/steel-browser)

### Inferences

- Simplest topology: one Chrome (or Chromium) process per agent profile on the host, `--user-data-dir=<per-profile dir>`, remote debugging on loopback only, exposed to the VM through an authenticated tunnel or reverse proxy; `@playwright/cli` attaches via `cdpEndpoint` + `cdpHeaders` (headers can carry a bearer token to that proxy).
- Proxy credentials: launching Chrome yourself means `--proxy-server` without credentials, so pick a provider with IP whitelisting (Decodo supports it; note HTTPS-only session control) or run a small local forwarder on the host that adds upstream credentials; Playwright's own `launch({proxy})` handles credentials but only when Playwright launches the browser (e.g. `launchServer`, not plain attach). Per-context proxies over CDP via Playwright `newContext({proxy})` may work (Playwright documents per-context proxies, but whether this holds over `connectOverCDP` was not verified because the CDP protocol page did not render); either way it is driven by the VM-side client and so puts proxy choice (and credentials) in the agent's hands.
- `launchServer`/Playwright-server route gives higher fidelity than CDP and lets the host own launch flags and proxy credentials, at the cost of version lockstep between host server and VM `@playwright/cli`.
- Browserless self-hosted inside a commercial product means buying the commercial licence (SSPL obligations otherwise); Steel avoids the licence issue but its isolation/concurrency must be verified.

### Gaps

- Exact CDP `Target.createBrowserContext` proxy parameters (protocol page did not render in the fetcher).
- Whether `@playwright/cli` exposes a proxy flag or passes `contextOptions.proxy` when attached over CDP; whether `cdpHeaders` are honoured by `attach --cdp`.
- Steel's concurrency/isolation model and maintenance cadence.
- Whether `attach --cdp` reuses the browser's existing default context (and so the host-side persistent profile with its cookies) or creates a fresh context; this decides whether host-side persistent profiles keep logins when the VM attaches.
- Headful vs headless and fingerprint consistency: no cited source gathered on how headless Chrome fingerprints differ from headful in 2026 or on running headful Chrome under a virtual display on a server.

## Anti-bot/stealth for Chromium in 2026 and effectiveness against Amazon

### Takeaway

The maintained Chromium stealth tools work at the automation-client level: rebrowser-patches says outright it patches "the library code only, not the browser"; Patchright ships a patched Playwright driver and modifies launch flags (its README does not say whether the browser binary is touched). Inference: their main fix (avoiding the `Runtime.enable` leak, a CDP command issued by the client) would not apply when stock `@playwright/cli` in the VM drives Chrome over CDP. Camoufox is Firefox driven over Juggler/Playwright protocol (not CDP), had a maintenance gap and maintainer handover in 2026, and says it may not suit stable production. nodriver is Python/AGPL and not Playwright. There is no independent evidence on Amazon effectiveness; available figures are vendor blogs.

### Cited Findings

- Patchright: repo "serves the Patchright Driver" (client libraries are separate packages); avoids `Runtime.enable` by running JS in isolated ExecutionContexts; disables the Console API; modifies Chromium launch flags to drop automation markers. Chromium only; README does not say whether the browser binary is modified. Claims (its own, unverified) to pass Cloudflare, Kasada, Akamai, Shape/F5, DataDome, CreepJS etc. "With the right setup"; "passes most, but not all the Playwright tests"; bugs from upstream changes take "a few days" to fix. No connectOverCDP guidance. — [Patchright repo](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)
- rebrowser-patches: "The drop-ins patch the library code only, not the browser"; fix "disables the automatic `Runtime.Enable` command on every frame". Latest fully tested: Puppeteer 25.16.0 (2026-10-22), Playwright 1.64.1 (2026-10-14); actively maintained with community help. — [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches)
- Camoufox: Firefox build; Playwright drives it via Juggler ("Playwright drives Chromium over CDP but Firefox over Juggler"); remote Playwright server via `launch_server()`/`camoufox server`; per-launch fingerprint from real-world distributions (navigator, screen, WebGL, audio, fonts, WebRTC IP), `geoip=True` aligns timezone/locale/geolocation with proxy exit IP; authenticated SOCKS5 supported; "This project is under development. It may not be suitable for stable production use." — [daijro/camoufox](https://github.com/daijro/camoufox)
- Camoufox status: original author stepped down as primary maintainer; Clover Labs now maintains (github.com/CloverLabsAI/camoufox); `cloverlabs-camoufox` 0.6.0 released 2026-05-13; project note cites a year-long maintenance gap (search summary; no release after mid-May 2026 found). — [CloverLabs camoufox on PyPI](https://pypi.org/project/cloverlabs-camoufox/); [CloverLabsAI/camoufox](https://github.com/CloverLabsAI/camoufox)
- nodriver: "official successor of the Undetected-Chromedriver python package"; "No more webdriver, no more selenium", full CDP access; AGPL-3.0; latest noted change 0.50.1 ("switch to flat mode connection"), no date shown. — [nodriver repo](https://github.com/ultrafunkamsterdam/nodriver)
- Amazon (anecdotal, vendor/indie sources, search summary): datacenter IPs (AWS, GCP, DigitalOcean, Linode) draw Robot Check/503 quickly; one single small test reports success rates of 10% (free proxies), 55% (residential + plain requests), 85% (Playwright + stealth + residential); a German IP is recommended for amazon.de. Many sources sell proxies/solvers. — [Indie Hackers post](https://www.indiehackers.com/post/amazon-captcha-is-not-a-puzzle-its-aws-waf-scoring-you-on-7-signals-b75657a285); [HackerNoon, 2026](https://hackernoon.com/i-tried-every-way-to-scrape-amazon-in-2026-here-is-what-actually-works); [browserless blog (vendor)](https://www.browserless.io/blog/how-to-bypass-amazon-captcha)

### Inferences

- With the browser on the host and `@playwright/cli` in the VM, the CDP commands come from the VM-side client; Patchright/rebrowser-style fixes would require replacing or patching the Playwright package that `@playwright/cli` uses in the VM image, and keeping it in lockstep with Playwright releases. Browser launch configuration (flags, headful vs headless, real Chrome vs Chromium) is owned by whoever launches the browser on the host, independent of the VM client.
- Camoufox cannot be the target of `attach --cdp`; it could only be reached through `browser.remoteEndpoint` (Playwright server) with `browserName: firefox`, untested and subject to Playwright version matching; plus maintenance risk.
- No source gives credible, independent success rates against amazon.de with any stack; expect to measure ourselves.

### Gaps

- Recent Patchright/Camoufox issue-tracker breakage not reviewed (repo pages showed no release dates).
- undetected-chromedriver's own maintenance status not checked (only that nodriver calls itself its successor).
- Independent (non-vendor) evidence on Amazon robot-check rates for residential + headful Chrome.

## CAPTCHA solving services and Amazon CAPTCHA / AWS WAF

### Takeaway

2Captcha, CapSolver and (per secondary sources) Anti-Captcha offer token-solving task types for AWS WAF CAPTCHA, which Amazon properties can serve; CapSolver's docs also list image-to-text recognition (not checked for the others). Using them on amazon.de runs against Amazon's Conditions of Use clause on robots/data extraction tools (verbatim amazon.de text not retrieved).

### Cited Findings

- 2Captcha: "Token-based method for automated solving of Amazon AWS captcha", task types `AmazonTaskProxyless` (their proxies) and `AmazonTask` (your proxies); price not on page (sample task cost 0.00145). — [2Captcha API: Amazon AWS WAF captcha](https://2captcha.com/api-docs/amazon-aws-waf-captcha)
- CapSolver: AWS WAF CAPTCHA token API, `AntiAwsWafTask` (requires your own proxies) and `AntiAwsWafTaskProxyLess`; example uses `www.amazon.com`; ImageToText recognition listed elsewhere in docs. — [CapSolver docs: AWS WAF](https://docs.capsolver.com/en/guide/captcha/awsWaf/)
- Anti-Captcha: `AmazonTaskProxyless`/`AmazonTask` with `websiteURL`, `websiteKey`, `iv`, `context` (search digest of secondary sources only; no Anti-Captcha page fetched, no official changelog found; unsourced beyond that).
- The `amazon-orders` Python library ships an opt-in Anti-Captcha extra to clear Amazon login WAF challenges (search summary). — [amazon-orders docs: Solving WAF challenges](https://amazon-orders.readthedocs.io/waf.html)
- AWS WAF CAPTCHA action responds with HTTP 405 and header `x-amzn-waf-action: captcha` (search summary). — [AWS WAF docs: CAPTCHA and Challenge](https://docs.aws.amazon.com/waf/latest/developerguide/waf-captcha-and-challenge.html)
- Amazon Conditions of Use licence excludes use of "data mining, robots, or similar data gathering and extraction tools" (wording seen via third-party copies of the US/CA terms; amazon.de AGB returned HTTP 503 to the fetcher; search summary). Secondary commentary: breach risks account suspension; legality of scraping public data is jurisdiction-dependent. — [ConductAtlas: Amazon CoU data-mining provision](https://conductatlas.com/platform/amazon/amazon-conditions-of-use/provision/CA-P-018441/prohibition-on-data-mining-and-scraping-tools/); [Thunderbit (secondary)](https://thunderbit.com/blog/is-scraping-amazon-legal)

### Inferences

- Solving CAPTCHAs on a site that logs our users in (Amazon account) puts that user's account at risk under the CoU; this is a policy decision, not only a technical one.

### Gaps

- Whether amazon.de's classic "Robot Check" page is an AWS WAF CAPTCHA or Amazon's own text CAPTCHA (only secondary sources mention `validateCaptcha`); vendor pricing per 1,000 solves; solver ToS clauses on permitted targets were not read.

## Operational burden (memory, concurrency, IP rotation, login persistence, CDP security)

### Takeaway

Each logged-in identity needs its own persistent user-data-dir, used by one browser at a time, with a stable proxy session; memory per browser has no authoritative figure and must be measured; the CDP port has no authentication and must never be exposed beyond loopback without an authenticating front.

### Cited Findings

- CDP has no authentication; any local process can drive the browser when the debugger is enabled; HTTP endpoints like `/json/version`, `/json/new` need no credentials (secondary security write-ups; search summary). — [Canva engineering: CVE-2023-0704](https://www.canva.dev/blog/engineering/discovering-headroll-cve-2023-0704-in-chromium); [Qt bug QTBUG-50725](https://bugreports.qt.io/browse/QTBUG-50725)
- Chrome restricted remote debugging on default profiles because the switches were abused by infostealers to extract data (search summary). — [Chrome for Developers blog](https://developer.chrome.com/blog/remote-debugging-port)
- Playwright `launchServer` binds to loopback by default; `0.0.0.0` exposes the RPC to anyone reaching the port. — [Playwright docs: BrowserType](https://playwright.dev/docs/api/class-browsertype)
- A userDataDir cannot be opened by multiple browser instances simultaneously. — [Playwright docs: BrowserType](https://playwright.dev/docs/api/class-browsertype)
- Browserless capacity = workers × per-worker concurrency; lower concurrency gives each browser more CPU/memory and stability; no portable sessions-per-GB rule is published (search summary). — [Browserless docs: performance](https://docs.browserless.io/enterprise/private-deployment/performance); [Browserless docs: long queues](https://docs.browserless.io/enterprise/long-queues)
- Residential sticky sessions max 24 h (Decodo, Oxylabs) or 7 days (IPRoyal) and may rotate early when the device goes offline. — [Decodo quick start](https://help.decodo.com/docs/residential-proxy-quick-start); [Oxylabs session control](https://developers.oxylabs.io/products/proxies/residential-proxies/session-control); [IPRoyal rotation](https://docs.iproyal.com/proxies/residential/proxy/rotation)

### Inferences

- Login persistence = per-user profile directories on the host (or a store that restores them), a profile-to-proxy-session mapping, and serialised access per profile; profiles hold live cookies, so they are sensitive data at rest.
- Exposure of the browser to the VM is the main security design item: loopback-bound CDP behind an authenticated tunnel/reverse proxy with per-session tokens (`cdpHeaders`), so one agent cannot reach another agent's browser.
- Operating cost includes per-GB proxy traffic for every page load (images, scripts), so blocking heavy resources or using cheaper egress for non-sensitive sites matters.

### Gaps

- No authoritative memory-per-Chrome figure (measure on the target workload; peak, not average).
- Behaviour of sites (Amazon included) when a logged-in session's IP changes after a sticky-session rotation.
