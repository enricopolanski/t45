// @effect-diagnostics nodeBuiltinImport:off - This capability program runs as plain Node inside the agent VM.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";
import { TrimmedNonEmptyString } from "@t45/contracts/models/primitives";
import * as Schema from "effect/Schema";

const configPath = "browser-sites.json";
const decodeSites = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ url: Schema.String, profile: TrimmedNonEmptyString })),
  ),
);
const decodeSessions = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ browsers: Schema.Array(Schema.Struct({ name: Schema.String })) }),
  ),
);
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const readSites = async () => {
  try {
    return decodeSites(await NodeFSP.readFile(configPath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw new Error(
      `Cannot read ${configPath}: ${error instanceof Error ? error.message : error}`,
      {
        cause: error,
      },
    );
  }
};

const siteUrl = (value: string) => {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Browser sites must use an http:// or https:// URL.");
  return url;
};

const open = async () => {
  const [target, ...rest] = process.argv.slice(2);
  if (!target || target === "--help" || rest.length > 0) {
    process.stdout.write("Usage: node /opt/t45/browser-open.mjs <url>\n");
    process.stdout.write(
      'Reads browser-sites.json: [{ "url": "https://shop.example.com", "profile": "profile-name" }]. Matches the exact URL origin. Sites without a configured profile use a separate browser without a saved login.\n',
    );
    if (target !== "--help") process.exitCode = 1;
    return;
  }
  const url = siteUrl(target);
  const profiles = new Map<string, string>();
  for (const site of await readSites()) {
    const origin = siteUrl(site.url).origin;
    if (profiles.has(origin) && profiles.get(origin) !== site.profile)
      throw new Error(`Conflicting browser profiles for ${origin} in ${configPath}.`);
    profiles.set(origin, site.profile);
  }
  const profile = profiles.get(url.origin);
  const configuredEndpoint = process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT;
  if (!configuredEndpoint) throw new Error("The Web browser capability is not configured.");
  const endpoint = new URL(configuredEndpoint);
  if (profile) {
    endpoint.searchParams.set("profile", profile);
    // Browserless restores the saved browser identity; locale matching would override its language.
    endpoint.searchParams.set("proxyLocaleMatch", "false");
  } else {
    endpoint.searchParams.delete("profile");
  }
  // One live browser per profile, or per origin without a saved login. CLI owns its lifecycle.
  const session = `t45-${NodeCrypto.createHash("sha256")
    .update(JSON.stringify([endpoint.toString(), profile ?? url.origin]))
    .digest("hex")
    .slice(0, 16)}`;
  const run = (args: ReadonlyArray<string>) =>
    execFile("playwright-cli", args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        PLAYWRIGHT_MCP_CDP_ENDPOINT: endpoint.toString(),
        // New isolated contexts do not contain the authentication loaded by Browserless.
        PLAYWRIGHT_MCP_ISOLATED: "false",
      },
    });
  const sessions = decodeSessions((await run(["list", "--json"])).stdout);
  const command = sessions.browsers.some((browser) => browser.name === session) ? "goto" : "open";
  const result = await run([`-s=${session}`, command, url.href]);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.stdout.write(`Browser profile: ${profile ?? "none"}.\n`);
  process.stdout.write(`Use playwright-cli -s=${session} <command> for this browser.\n`);
  process.stdout.write(
    "Open another URL with node /opt/t45/browser-open.mjs <url> to select its profile.\n",
  );
};

try {
  await open();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
