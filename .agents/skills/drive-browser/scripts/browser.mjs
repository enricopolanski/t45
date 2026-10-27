#!/usr/bin/env node
// Headless-Chromium driver for agent evidence and e2e checks.
// Browser binaries are the chrome-headless-shell builds T3 code and Playwright
// already keep on this machine; playwright-core itself is bootstrapped into a
// user cache on first run. Nothing here needs root or a display.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const PLAYWRIGHT_PIN = "playwright-core@1.64.0";
const CACHE_DIR = NodePath.join(NodeOS.homedir(), ".cache", "t45-drive-browser");
const COMMANDS = new Set(["shot", "video", "pdf"]);

function usage() {
  console.error(
    `Usage:
  browser.mjs shot <url> [--out file.png] [--full] [--selector css] [--size 1280x800] [--wait-ms ms] [--steps file.mjs]
  browser.mjs video <url> [--out file.webm] [--size 1280x800] [--wait-ms ms] [--steps file.mjs]
  browser.mjs pdf <url> [--out file.pdf] [--steps file.mjs]

Runs a headless Chromium session against <url> and prints the output path.
--steps names a module whose default export is async ({ page, context, browser, url, out }) => {}.
Run from the repository root; see the skill for examples.`,
  );
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) {
    usage();
    NodeProcess.exit(2);
  }
  const opts = { command, full: false, waitMs: 0, timeout: 30_000 };
  let url = null;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--out") opts.out = rest[++index];
    else if (arg === "--full") opts.full = true;
    else if (arg === "--selector") opts.selector = rest[++index];
    else if (arg === "--wait-ms") opts.waitMs = Number(rest[++index]);
    else if (arg === "--timeout") opts.timeout = Number(rest[++index]);
    else if (arg === "--steps") opts.steps = rest[++index];
    else if (arg === "--size") {
      const match = /^(\d+)x(\d+)$/.exec(rest[++index] ?? "");
      if (!match) throw new Error("--size expects WIDTHxHEIGHT, for example 390x844");
      opts.size = { width: Number(match[1]), height: Number(match[2]) };
    } else if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
    else if (url === null) url = arg;
    else throw new Error("only one url is accepted");
  }
  if (url === null) throw new Error("a url is required");
  opts.url = url;
  return opts;
}

function runInstaller(command, args) {
  try {
    NodeChildProcess.execFileSync(command, args, { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

function installPackage(dir, spec) {
  const installed = runInstaller("npm", [
    "install",
    "--prefix",
    dir,
    "--no-fund",
    "--no-audit",
    "--loglevel=error",
    spec,
  ]);
  if (!installed && !runInstaller("pnpm", ["-C", dir, "add", spec])) {
    throw new Error(`could not install ${spec} into ${dir}; install it manually with npm or pnpm`);
  }
}

async function loadPlaywright() {
  const localRequire = NodeModule.createRequire(import.meta.url);
  try {
    const pw = localRequire("playwright-core");
    return {
      pw,
      pwDir: NodePath.dirname(localRequire.resolve("playwright-core/package.json")),
    };
  } catch {}
  const cachedRequire = NodeModule.createRequire(NodePath.join(CACHE_DIR, "package.json"));
  if (
    !NodeFS.existsSync(NodePath.join(CACHE_DIR, "node_modules", "playwright-core", "package.json"))
  ) {
    console.error(
      `[drive-browser] first run: installing ${PLAYWRIGHT_PIN} into ${CACHE_DIR} (one time)`,
    );
    NodeFS.mkdirSync(CACHE_DIR, { recursive: true });
    installPackage(CACHE_DIR, PLAYWRIGHT_PIN);
  }
  const pw = cachedRequire("playwright-core");
  return {
    pw,
    pwDir: NodePath.dirname(cachedRequire.resolve("playwright-core/package.json")),
  };
}

function versionSorted(entries) {
  return entries.slice().sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

function findBrowser() {
  if (NodeProcess.env.T45_BROWSER_PATH) return NodeProcess.env.T45_BROWSER_PATH;
  const exeName = "chrome-headless-shell";
  const candidates = [];

  const t45Root = NodePath.join(NodeOS.homedir(), ".t45", "tools", "chrome-headless-shell");
  if (NodeFS.existsSync(t45Root)) {
    for (const platformDir of versionSorted(NodeFS.readdirSync(t45Root))) {
      const platformPath = NodePath.join(t45Root, platformDir);
      if (!NodeFS.statSync(platformPath).isDirectory()) continue;
      const versions = versionSorted(NodeFS.readdirSync(platformPath)).reverse();
      for (const version of versions)
        candidates.push(NodePath.join(platformPath, version, exeName));
    }
  }

  const playwrightRoot = NodePath.join(NodeOS.homedir(), ".cache", "ms-playwright");
  if (NodeFS.existsSync(playwrightRoot)) {
    const platformDirs = [
      "chrome-headless-shell-linux64",
      "chrome-headless-shell-mac-arm64",
      "chrome-headless-shell-mac-x64",
    ];
    const revisions = versionSorted(NodeFS.readdirSync(playwrightRoot)).reverse();
    for (const revision of revisions) {
      if (!revision.startsWith("chromium_headless_shell-")) continue;
      for (const platformDir of platformDirs) {
        candidates.push(NodePath.join(playwrightRoot, revision, platformDir, exeName));
      }
    }
  }

  for (const systemPath of [
    NodeProcess.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]) {
    if (systemPath) candidates.push(systemPath);
  }

  const found = candidates.find((candidate) => NodeFS.existsSync(candidate));
  if (!found) {
    throw new Error(
      "no headless Chromium found; set T45_BROWSER_PATH to a chrome-headless-shell binary",
    );
  }
  return found;
}

function ensureFfmpeg(pwDir) {
  let revision = null;
  try {
    const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(pwDir, "browsers.json"), "utf8"));
    revision = manifest.browsers?.find((browser) => browser.name === "ffmpeg")?.revision ?? null;
  } catch {}
  if (revision === null) return;
  const dir = NodePath.join(NodeOS.homedir(), ".cache", "ms-playwright", `ffmpeg-${revision}`);
  if (NodeFS.existsSync(dir)) return;
  console.error("[drive-browser] installing the Playwright ffmpeg build for video (one time)");
  NodeChildProcess.execFileSync(
    NodeProcess.execPath,
    [NodePath.join(pwDir, "cli.js"), "install", "ffmpeg"],
    {
      stdio: "inherit",
    },
  );
}

function defaultOutPath(command) {
  const dir = NodePath.join(NodeOS.tmpdir(), "t3-drive");
  NodeFS.mkdirSync(dir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  const extension = { video: "webm", pdf: "pdf", shot: "png" }[command];
  return NodePath.join(dir, `${stamp}-${command}.${extension}`);
}

async function runSteps(opts, session) {
  if (!opts.steps) return;
  const module = await import(NodeURL.pathToFileURL(NodePath.resolve(opts.steps)).href);
  const steps = module.default ?? module.steps;
  if (typeof steps !== "function") {
    throw new Error("--steps module must default-export an async function");
  }
  await steps({ ...session, url: opts.url, out: opts.out });
}

async function main() {
  const opts = parseArgs(NodeProcess.argv.slice(2));
  opts.out = NodePath.resolve(opts.out ?? defaultOutPath(opts.command));
  NodeFS.mkdirSync(NodePath.dirname(opts.out), { recursive: true });

  const { pw, pwDir } = await loadPlaywright();
  if (opts.command === "video") ensureFfmpeg(pwDir);

  const executablePath = findBrowser();
  console.error(`[drive-browser] browser: ${executablePath}`);
  const browser = await pw.chromium.launch({
    executablePath,
    args: ["--no-sandbox"],
  });
  try {
    const viewport = opts.size ?? { width: 1280, height: 800 };
    const videoSize = {
      width: viewport.width - (viewport.width % 2),
      height: viewport.height - (viewport.height % 2),
    };
    const context = await browser.newContext({
      viewport,
      ...(opts.command === "video"
        ? { recordVideo: { dir: NodePath.dirname(opts.out), size: videoSize } }
        : {}),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(opts.timeout);
    await page.goto(opts.url, { waitUntil: "load", timeout: opts.timeout });
    if (opts.waitMs > 0) await page.waitForTimeout(opts.waitMs);

    await runSteps(opts, { page, context, browser });

    if (opts.command === "shot") {
      if (opts.selector) await page.locator(opts.selector).screenshot({ path: opts.out });
      else await page.screenshot({ path: opts.out, fullPage: opts.full });
    } else if (opts.command === "pdf") {
      await page.pdf({ path: opts.out, printBackground: true });
    }

    const video = opts.command === "video" ? page.video() : null;
    await context.close();
    if (video) {
      const recordedPath = await video.path();
      if (NodePath.resolve(recordedPath) !== opts.out) NodeFS.renameSync(recordedPath, opts.out);
    }
    console.log(opts.out);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`[drive-browser] ${error?.message ?? error}`);
  NodeProcess.exit(1);
});
