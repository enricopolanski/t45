# Development

## First checkout

Install `vp` using the [root README](../../README.md#install-vp). The checkout requires Node 24.21.0 or newer in the 24.x line, with the development version pinned in `.node-version`; Bun is optional. Copy `.env.example` to `.env`. From the repository root:

```sh
vp env on node
vp env install
sh scripts/setup.sh
vp run dev
```

Setup installs workspace dependencies, the Chromium revision required by the pinned Playwright version, and its system libraries. Linux setup may request sudo authentication and fails if the required privileges are unavailable. Re-run setup after upgrading Playwright or switching to a branch with a different version. Browser installation uses the checkout's Playwright CLI and its managed cache.

Open the web URL printed by the dev runner and sign in with any email; a fresh database uses the normal organization registration and approval flow.

`vp run sync:repos` initializes the registered Effect and OpenCode reference submodules in `.repos/` and checks out tags matching `pnpm-workspace.yaml`. Run it after cloning or changing those dependency versions. This root task is uncached and leaves staging to you. Use `--repo effect` or `--repo opencode` to select one, and `--dry-run` to print the Git commands without running them. These sources do not include our installed package patches.

## Starting development

`vp run dev` is the development entry point. The root Vite task starts the server, web, and runner (`apps/runner`, where agents' sandboxed chats run) together, with task caching disabled for these long-running processes.

Flags go directly after the task name, for example `vp run dev --home-dir /tmp/t45-dev`.

### Signing in and browser checks

Development builds skip token validation: the login page on `localhost` or `127.0.0.1` signs you in as whatever email you enter, and every other host shows Clerk. For a fresh browser profile, run `vp run browser --email alice@example.test` with `vp run dev` running and the web server ready. The browser command opens `http://localhost:5733` in a fresh browser profile and signs in through the ordinary login flow. It stays open until you close its window. Run it again with another email to open a separate user session on the same server. The first user names the organization; later users await approval.

For agent checks, use `vp run browser --email alice@example.test --steps /tmp/check.mjs`. This opens a headless browser, signs in, calls the module's default function with `{ page, context, browser, url }`, and closes the browser when the function finishes. A thrown error exits nonzero; use the steps to wait for application signals and capture screenshots or PDFs outside the repository.

Registration, approval, and deactivation rules still apply.

The Playwright E2Es are mandatory in pre-commit. Run them on their own with `vp run --filter @t45/e2e test`. They drive the development app at `http://localhost:5733` as the people of an organization, each in a browser of their own, and start no agent. A running `vp run dev` is used as is; with none, Playwright starts one with a fresh home in the system temp folder (`t45-e2e`) and stops it after the run. They use the Chromium installed by setup; a missing browser fails the check. Browser traces on failure live under `e2e/test-results`.

### State and ports

Dev state lives in the gitignored `.t45/userdata` of the checkout you launch from, even when `DATA_DIR` is set; an explicit `--home-dir` wins. Never run a development server against the live `~/.t3/userdata`.

A request with an `x-instance-id` header (letters, digits, `_` and `-`) runs against an instance: its own copy of the app, with its own database, attachments, sessions and background work in `.t45/instances/<id>/userdata`, created on first use. Requests without the header use `.t45/userdata`, and production ignores it. `vp run browser --email <email> --instance-id <id>` opens a browser on an instance; curl needs the header and a cookie jar per instance. E2E specs import `test` from `e2e/fixtures.ts`, which gives each test attempt a new instance and attaches its id to the report; its `signIn` opens a browser for one person on that instance. Inspect an instance with `sqlite3 .t45/instances/<id>/userdata/statev2.sqlite`. An instance closes after 10 idle minutes, which stops its background work, so use `--home-dir` for a long throwaway session. Delete instances only while dev is stopped (`rm -rf .t45/instances`); an open instance keeps using its deleted files until it closes.

Ports are fixed: server 13773, web 5733, runner 8790. If one is taken, for example by a dev run in another checkout, startup fails. `--port` or `PORT` moves only the server port. `--host` or `HOST` accepts loopback and wildcard bind addresses. `LOG_REQUESTS` controls request logging. `--dry-run` prints the configuration without starting services.

The launcher passes the server's port as `PORT` so the web proxy targets it. Vite always listens on port 5733.

The server writes logs to stdout. `LOG_LEVEL` sets the minimum level (default `Info`); `LOG_REQUESTS` enables HTTP request logs (enabled by default in development, disabled by default when starting the server directly).

## microsandbox

Agents run on the runner, which runs each chat in a [microsandbox](https://github.com/superradcompany/microsandbox) microVM, so a machine that runs them needs hardware virtualization. macOS on Apple Silicon has it. Linux needs `/dev/kvm` and the `kvm` group. WSL2 on Windows 11 needs nested virtualization:

1. Under `[wsl2]` in `%UserProfile%\.wslconfig`, set `nestedVirtualization=true` (the default on Windows 11), then `wsl --shutdown` from Windows.
2. In WSL, `grep -cE 'vmx|svm' /proc/cpuinfo` is above 0 and `/dev/kvm` exists.
3. `sudo usermod -aG kvm $USER`, then restart WSL.

Install the CLI to check a machine; it goes to `~/.microsandbox` and links `msb` into `~/.local/bin`:

```sh
curl -fsSL https://install.microsandbox.dev | sh
msb doctor
msb run alpine -- uname -r
```

On AMD, the October 2026 Windows update **KB5127648** removes nested virtualization from WSL without a warning ([microsoft/WSL#41917](https://github.com/microsoft/WSL/issues/41917)). If step 2 fails, check for it with `powershell.exe -NoProfile -Command "Get-HotFix -Id KB5127648"`. Until Microsoft fixes it, uninstall it (Settings → Windows Update → Update history → Uninstall updates) and pause updates so it doesn't come back.

### The runner in dev

`vp run dev` starts the runner on loopback next to the server (`runnerUrl=` on the `[dev-runner]` line) and points the server at it, with a token made fresh for each run. To use a shared runner instead, set both `RUNNER_URL` and `RUNNER_TOKEN`; this skips the local runner. The local runner needs three things:

- **`OPENCODE_API_KEY`** in `.env`: the runner's OpenCode Go key. The runner doesn't start without it; the sandbox only sees a placeholder.
- **`CAPABILITY_SECRET_BROWSERLESS_TOKEN`** in `.env`, for agents with the Web browser capability: a Browserless Cloud API token. A capability's secret `NAME` comes from the runner's `CAPABILITY_SECRET_NAME` and goes only to the capability's hosts; the sandbox only sees a placeholder.
- **The agent image**, built with Docker and loaded into microsandbox as `t45-agent:dev`: `vp run --filter @t45/runner image`. Rebuild after changing `apps/runner/image`. Without it, chats fail and the server log names the reason, as in production.
- **`mkfs.ext4` (e2fsprogs) and GNU tar** on the host, which make and pack VM disks. On macOS, install `e2fsprogs` and `gnu-tar` with Homebrew and put their `sbin` and `gnubin` folders first on `PATH`.

Built-in MCP tools call the server’s regular workflow RPCs and attachment upload API with an execution token. `SERVER_URL` sets the server address reachable from agent VMs; by default it is `http://host.microsandbox.internal:<server port>`. Set it to a reachable server address when using a remote runner.

`packages/capabilities` builds the supplied MCP programs and exports `dist/capabilities.json` and `dist/built-ins.json`. Development builds these before startup and passes `BUILT_INS_FILE` to the server. Every server start replaces the supplied capabilities and agent presets with the file's, so changed tools reach existing databases after a restart. Import other bundles through the admin-only `capabilities.import` RPC with `{ capabilities: <contents of capabilities.json> }`; an import that uses a supplied capability's ID lasts until the next start. Agents select those stored definitions, and dispatch sends their content to the runner, which applies it without a catalogue. Changing a capability needs no server or image rebuild.

Without `/dev/kvm` every chat's VM fails to start, and the runner's log names the reason.

## Release builds

The `build:bundle` task cleans `apps/server/dist` and builds `dist/bin.mjs`. The full build also depends on the web build and only replaces `dist/client`; cached bundle outputs exclude the client. Build `@t45/capabilities` separately and deploy its `dist/built-ins.json` as data, setting `BUILT_INS_FILE` to its path when starting the server. The server has no dependency on the capability package. Rebuilding or switching a checkout used by a running built server removes that server's assets, so build a release in a separate checkout before switching to it.

Capture the checkout's full commit SHA once and pass it to the build:

```sh
BUILD_SHA="$(git rev-parse HEAD)" vp run --filter t45 build
```

Both artifacts embed `BUILD_SHA` as supplied; CI and manual builds are responsible for providing it. Releases sign in with Clerk: pass `AUTH_CLERK_PUBLISHABLE_KEY` to the build, which embeds it in the web client, and give the server the same value. A server built with a `BUILD_SHA` refuses to start without it. The bundle and web-build tasks include `BUILD_SHA` in their cache inputs, so a changed commit stamp rebuilds both artifacts. The server reports its own stamp in the session state; open tabs offer a reload when it differs from their embedded stamp. When `BUILD_SHA` is unset or empty, both sides use `development` and do not prompt.

## Checks

Run checks for the files and packages you changed:

```sh
vp test run <files>
vp lint <files>
vp run --filter <package> typecheck
```

Every commit first runs `vp staged` to fix staged files and include those fixes in the commit while preserving unstaged edits. It then runs the root `pre-commit` task: `vp check --fix` across the working tree, typechecking, unused code, unit tests and mandatory browser E2Es. Manual runs fix files but leave staging to you. The parent tasks and browser E2Es are uncached so every invocation runs the browsers; other checks retain their caches. Run it manually with `vpr pre-commit`, or `vpr --no-cache pre-commit` to force every check fresh. Pre-commit never downloads browsers or installs system packages: if Chromium is missing, re-run `sh scripts/setup.sh`. The shared bundle task finishes before server tests and client packaging; packaging replaces only `dist/client`, so recursive tests can run safely in parallel. There is no PR CI.

### Verifying setup and build changes

For setup changes, use a disposable checkout containing the proposed changes, without `node_modules`, build outputs, `.t45`, or task caches. Verify system dependencies in a fresh supported container or VM with Node, `vp`, Git, and the documented installation privileges. Do not mount the host's browser cache or supply a browser executable override. From that checkout, give Playwright an empty managed cache and run the normal setup and checks:

```sh
export PLAYWRIGHT_BROWSERS_PATH="$(mktemp -d)"
sh scripts/setup.sh
vpr --no-cache pre-commit
```

When upgrading Playwright, also run setup and checks in an environment prepared with the previous version. Confirm that the installed package selects its matching browser revision. A successful run with system dependencies already installed does not verify their installation; report that limitation when a fresh machine or the required privileges are unavailable.

For build graph or cache changes, run recursive tests directly. Force a fresh execution, then run normally twice to populate and exercise caches:

```sh
vp run --no-cache -r test
vp run -r test
vp run -r test
```

Then make a server-only source edit and run `vp run -r test` again. Confirm that the web build is a cache hit while the bundle and affected server tests execute. Inspect command output and `node_modules/.vite/task-cache/*/last-summary.json`, saving the summary before another invocation overwrites it. Require one shared pack execution on the cold and server-change runs, completed before its consumers; warm runs may restore that bundle instead. Verify that bundle cache restoration preserves the packaged client and that E2Es execute on every run. Restore temporary verification edits without discarding existing working-tree changes.

### Unused code

`vp run knip`, part of `pre-commit`, checks every workspace for unused files, dependencies and runtime exports. Exported types are allowed without consumers. Runtime exports, including Effect schemas, need consumers or an explicit `@public` annotation for a deliberate public API. Canonical Effect service construction APIs use that annotation. Use `vp run knip --workspace apps/web` to audit one workspace. Runtime-discovered entrypoints and dependency exceptions belong in [knip.jsonc](../../knip.jsonc).
