---
name: drive-browser
description: Drive headless Chromium from the shell for screenshots, screen recordings, PDFs, and e2e browser checks of any URL or local dev server. Use to verify user-visible web changes against the dev server, and whenever a screenshot, screen recording/video, or e2e/browser check is wanted.
---

# Drive a headless browser

Capture screenshots and videos, print PDFs, and run e2e checks against any URL
with the headless Chromium builds already on this machine. No display, no root,
no browser install: the helper reuses T3's own `chrome-headless-shell` and
bootstraps `playwright-core` into `~/.cache/t45-drive-browser` on first run
(about a second, network required once). Video also downloads a small ffmpeg
once. Nothing is installed into the repository.

## Capture

Run from the repository root; the helper prints the absolute output path.

```sh
S=.agents/skills/drive-browser/scripts/browser.mjs
node "$S" shot https://example.com --out /tmp/t3-drive/example.png
node "$S" shot "$WEB_URL" --full --wait-ms 2000 --out /tmp/t3-drive/app.png
node "$S" shot "$URL" --selector '[data-testid=sidebar]' --size 390x844 --out /tmp/t3-drive/mobile.png
node "$S" video "$WEB_URL" --steps /tmp/t3-drive/steps.mjs --out /tmp/t3-drive/flow.webm
node "$S" pdf https://example.com --out /tmp/t3-drive/example.pdf
```

- `--size WxH` sets the viewport (default `1280x800`); `--wait-ms` settles
  after load, before `--steps`; `--full` captures the whole page.
- Videos are `.webm`, which the T3 chat renders directly. Recording starts at
  navigation, so the steps capture the whole flow.

## Steps modules

`--steps` points at a module whose default export receives the live session:

```js
// /tmp/t3-drive/steps.mjs
import assert from "node:assert/strict";

export default async ({ page }) => {
  await page.getByRole("button", { name: "New chat" }).click();
  await page.getByRole("textbox").fill("hello");
  await page.keyboard.press("Enter");
  assert.match(await page.locator("[data-slot=message]").last().innerText(), /hello/);
};
```

Any thrown error (including a failing assertion) exits non-zero with the failure
on stderr, so the same command doubles as an e2e check. `page`, `context`,
`browser`, `url`, and `out` are available; use Playwright's normal API.

For authenticated T45 checks, start `vp run dev --home-dir /tmp/t45-browser` and wait for the web server to be ready. Run `vp run browser --email alice@example.test --steps /tmp/t3-drive/steps.mjs`. The browser command uses `http://localhost:5733`. It opens a fresh headless profile, signs in through the normal login form, and calls the module's default function with `{ page, context, browser, url }`. It closes the browser when the steps finish and exits nonzero on failure. Capture screenshots or PDFs from those steps using Playwright's API; keep artifacts under `/tmp`. The first user names the organization; subsequent users await approval. Omit `--steps` to leave a headed browser open for manual exploration. See [Development](../../../docs/operations/development.md#signing-in-and-browser-checks).

## Show the evidence

Reference the printed path as markdown so the user sees it inline in the chat:

```md
![settings after save](/tmp/t3-drive/20261012113200-shot.png)
[screen recording of the flow](/tmp/t3-drive/flow.webm)
```

Keep artifacts out of the repository (defaults live in `/tmp/t3-drive`). The generic capture helper starts with a fresh logged-out profile; supply sign-in steps when needed. For T45, use the authenticated browser command above. `T45_BROWSER_PATH` overrides browser discovery only for the generic capture helper.
