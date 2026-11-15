import { CAPABILITIES_DIR, Capability } from "@t45/contracts/models/Capability";

/** Browserless's Amsterdam fleet, the closest to Germany. */
const BROWSER_HOST = "production-ams.browserless.io";

/**
 * A Browserless Cloud browser with a German residential IP that solves CAPTCHAs. Playwright CLI
 * in the VM connects to it over CDP; the token is substituted on the way out.
 */
export const webBrowser = Capability.make({
  id: "web-browser",
  name: "Web browser",
  description: "Visits websites in a cloud browser with a German residential IP.",
  hosts: [BROWSER_HOST],
  secrets: ["BROWSERLESS_TOKEN"],
  environment: {
    PLAYWRIGHT_MCP_CDP_ENDPOINT: `wss://${BROWSER_HOST}/stealth?proxy=residential&proxyCountry=de&proxyLocaleMatch=1&solveCaptchas=true`,
    PLAYWRIGHT_MCP_CDP_HEADERS: "Authorization: Bearer {{BROWSERLESS_TOKEN}}",
  },
  note: `# Web browser

To read websites, \`playwright-cli\` drives a Chrome that runs elsewhere, from a German IP (\`playwright-cli --help\`). Open every URL with \`node ${CAPABILITIES_DIR}/browser-open.mjs <url>\`. It reads \`browser-sites.json\` from the working folder, selects the site's saved Browserless profile, and opens or reuses its browser. The optional file is a JSON array of \`{ "url": "https://shop.example.com", "profile": "profile-name" }\` entries. Matching uses the exact URL origin (scheme, hostname and port); list each site's origins explicitly. Sites without an entry use a separate browser without a saved login. Entries with the same profile share a browser.

The opening command prints the session name. Use \`playwright-cli -s=<session> <command>\` for clicks, extraction, snapshots and other actions on that browser. For another URL, use the opening command again so it selects the appropriate profile. Run \`playwright-cli close-all\` when finished. Do not set browser endpoints, choose profiles, enter credentials or save authentication yourself. If a configured site asks you to sign in, report that its saved login needs refreshing and stop collecting its prices.

The browser deals with CAPTCHAs itself; if a page still shows a robot check, report that the site blocks automated access, and don't try to get around it.`,
});
