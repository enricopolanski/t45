import { Capability } from "@t45/contracts/models/Capability";

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

To read websites, \`playwright-cli\` drives a Chrome that runs elsewhere, from a German IP, and shows you each page as a snapshot (\`playwright-cli --help\`). Start with \`playwright-cli open <url>\`, and run \`playwright-cli close\` when you are done. The browser deals with CAPTCHAs itself; if a page still shows a robot check, report that the site blocks automated access, and don't try to get around it.`,
});
