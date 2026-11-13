# T45

T45 is a web app for collaborative working assisted by agents. You can define workflows, projects, automations, assign to coworkers and/or delegate to agents (instructions, model, skills, MCP servers).

## How it works

The application is composed by 3 parts:

- `client`: the software used by humans to interface with the application
- `server`: the software handling the business logic
- `runner`: the software providing isolation for each automation, on a different machine from the server

The T45 server serves the web app and keeps the chats, workflows and agents. Agents run in sandboxed microVMs on a separate runner service, never on the server's machine; the server does not edit code or run git. Sign-in is Clerk.

## Running it

T45 needs Node.js 24.21.0 or newer in the 24.x line and [`vp`](#install-vp). For development, run `sh scripts/setup.sh` and `vp run dev` in a checkout ([docs/operations/development.md](./docs/operations/development.md)).

Setup installs workspace dependencies, the matching Playwright Chromium required by pre-commit, and its system libraries. Linux setup may request sudo authentication and fails if the required privileges are unavailable.

## Documentation

Docs live in [docs/](./docs).

Working on the code? Start at [AGENTS.md](./AGENTS.md) and [docs/operations/development.md](./docs/operations/development.md).

## Install `vp`

T45 uses [Vite+](https://viteplus.dev/guide/), so you need the global `vp` command.

```bash
# macOS / Linux
curl -fsSL https://vite.plus | bash
# Windows (PowerShell)
irm https://vite.plus/ps1 | iex
```

## Credits

This project forked originally from [t3code](https://github.com/pingdotgg/t3code), and contains implementation ideas from Patrick Roza's [effect-app](https://github.com/effect-app).
