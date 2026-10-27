# Development

## First checkout

Install `vp` using the [root README](../../README.md#install-vp). The checkout requires Node 24; Bun is optional. Copy `.env.example` to `.env` and set `AUTH_CLERK_PUBLISHABLE_KEY` to your Clerk development instance's publishable key. From the repository root:

```sh
vp i
vp run dev
```

Open the web URL printed by the dev runner and sign in with Clerk. The server requires `AUTH_CLERK_PUBLISHABLE_KEY`; a fresh database uses the normal organization registration and approval flow.

`vp run sync:repos` initializes the registered Effect and OpenCode reference submodules in `.repos/` and checks out tags matching `pnpm-workspace.yaml`. Run it after cloning or changing those dependency versions. This root task is uncached and leaves staging to you. Use `--repo effect` or `--repo opencode` to select one, and `--dry-run` to print the Git commands without running them. These sources do not include our installed package patches.

## Starting development

`vp run dev` is the development entry point. The root Vite task starts the server, web, and runner (`apps/runner`, where agents' sandboxed chats run) together, with task caching disabled for these long-running processes.

Flags go directly after the task name, for example `vp run dev --home-dir /tmp/t45-dev`.

### State and ports

Dev state lives in the gitignored `.t45/userdata` of the checkout you launch from, even when `DATA_DIR` is set; an explicit `--home-dir` wins. Never run a development server against the live `~/.t3/userdata`.

Read ports from the `[dev-runner]` output: occupied server, web, or local runner ports shift them together. `PORT_OFFSET` selects a preferred offset from the defaults: server 13773, web 5733, runner 8790. `--port` or `PORT` fixes the server port and fails if it is occupied; web and runner ports can still shift. `--host` or `HOST` accepts loopback and wildcard bind addresses. `LOG_REQUESTS` controls request logging. `--dry-run` prints the configuration without starting services.

The launcher passes the server's port as `PORT` and Vite's port as `WEB_PORT`, so the web proxy always targets the server.

The server writes logs to stdout. `LOG_LEVEL` sets the minimum level (default `Info`); `LOG_REQUESTS` enables HTTP request logs (enabled by default in development, disabled by default when starting the server directly).

### Remote debugging

The web client always reaches its server at the page origin. Vite proxies the backend, so the same build works over localhost and remote connections. Vite accepts only localhost and IP `Host` headers; add other names to `DEV_ALLOWED_HOSTS`.

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

`vp run dev` starts the runner on loopback next to the server (`runnerUrl=` on the `[dev-runner]` line) and points the server at it, with a token made fresh for each run. To use a shared runner instead, set both `RUNNER_URL` and `RUNNER_TOKEN`; this skips the local runner. The local runner needs two things:

- **`OPENCODE_API_KEY`** in `.env`: the runner's OpenCode Go key. The runner doesn't start without it; the sandbox only sees a placeholder.
- **The agent image**, built with Docker and loaded into microsandbox as `t45-agent:dev`: `vp run --filter @t45/runner image`. Rebuild after changing `apps/runner/image`. Without it, chats fail and the server log names the reason, as in production.

Without `/dev/kvm` the runner's inventory says it can't run sandboxes, which the runner page (`/settings/runner`) shows, and the runner refuses every chat.

## Release builds

The build cleans `apps/server/dist`, packs the server and copies the complete web client into `dist/client`. Rebuilding or switching a checkout used by a running built server removes that server's assets, so build a release in a separate checkout before switching to it.

Capture the checkout's full commit SHA once and pass it to the build:

```sh
BUILD_SHA="$(git rev-parse HEAD)" vp run --filter t45 build
```

Both artifacts embed `BUILD_SHA` as supplied; CI and manual builds are responsible for providing it. The web build is an uncached package script, so server-only commits also refresh the frontend's stamp. If build caching is enabled later, its inputs must include `BUILD_SHA`. The server reports its own stamp in the session state; open tabs offer a reload when it differs from their embedded stamp. When `BUILD_SHA` is unset or empty, both sides use `development` and do not prompt.

## Checks

Run checks for the files and packages you changed:

```sh
vp test run <files>
vp lint <files>
vp run --filter <package> typecheck
```

Every commit runs the root `pre-commit` package script: workspace format/lint checks, typechecking, unused code, then tests, with caching enabled by default. Run it manually with `vpr pre-commit`. There is no PR CI.

### Unused code

`vp run knip`, part of `pre-commit`, checks every workspace for unused files, dependencies and runtime exports. Exported types are allowed without consumers. Runtime exports, including Effect schemas, need consumers or an explicit `@public` annotation for a deliberate public API. Canonical Effect service construction APIs use that annotation. Use `vp run knip --workspace apps/web` to audit one workspace. Runtime-discovered entrypoints and dependency exceptions belong in [knip.jsonc](../../knip.jsonc).
