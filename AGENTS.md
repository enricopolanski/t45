# AGENTS.md

T45 is a web app for collaborative working assisted by agents via workflows. You define operations, automations, agents (instructions, model, skills, MCP servers).

The T45 server serves the web app and keeps the chats, workflows and agents. Agents run in sandboxed microVMs on a separate runner service, never on the server's machine; the server does not edit code or run git.

Before changing or reviewing code, read and follow [Styles and rules](docs/operations/styles-and-rules.md).

## Schema and dependencies

- Never leave `pnpm-lock.yaml` out of sync with `package.json`; regenerate it with `CI= pnpm install --no-frozen-lockfile` instead of taking a side.
- Clean slate: until the first release, installations start from an empty database, with no compatibility for older data, servers, or clients. Change the schema by editing `apps/server/src/persistence/Schema.ts` in place; don't add migrations or backward-compat shims. A changed schema refuses databases created by an older one.
- From the first release, the schema is frozen as the baseline and changes ship as migrations applied on top of it.

## Pull requests and validation

Continue on the current branch. Create a new branch or PR only when the user asks.

Every commit runs the root `pre-commit` task: workspace format/lint checks, typechecking, unused code (knip), unit tests and mandatory browser E2Es. E2Es use the running development app at `http://localhost:5733`, or start a throwaway one when none is up. Run pre-commit manually with `vpr pre-commit` (`vp run pre-commit` is equivalent). The parent tasks and browser E2Es are uncached so every commit runs the E2Es; other checks retain their caches. `vpr --no-cache pre-commit` forces all checks fresh. It checks the whole working tree without modifying files or staging.

Commits use conventional, plain-language titles (`fix(web): new threads no longer spike CPU`), a body stating the problem and the fix, and end with the model and harness that did the work.

## Tests and verification

- Test business logic in models and user behavior in the frontend, with frontend e2es as the integration boundary. Do not add server tests or parser/codec tests. Existing server tests remain for now, pending an inventory of what needs coverage, why, and whether it belongs in a model test or frontend e2e.
- Only write meaningful tests that can guarantee invariants: if you're mocking the dom, you're not testing anything. Don't test dependencies indirectly.
- Wait on an observable signal, such as a chat's change feed, a stream event or a fake's receipt; never sleeps or polling. A test that needs a timeout to pass is wrong.

## Dev servers

`sh scripts/setup.sh` installs workspace dependencies, the matching Playwright Chromium, and its system libraries. Linux setup may request sudo authentication and fails if the required privileges are unavailable. Re-run setup after changing Playwright versions. `vp run dev` starts server and web. Details: `docs/operations/development.md`.

- Dev state lives in the gitignored `.t45` of the checkout you launch from, even when `DATA_DIR` is set.
- Dev ports are fixed: server 13773, web 5733, runner 8790. A second dev run on the same machine fails on the busy port.
- Dev builds sign in with any email, without token validation: with `vp run dev` running, `vp run browser --email <email>` opens a signed-in browser; `--steps <module>` runs authenticated headless checks.

## Code map

TODO:

## Documentation

Most changes need no doc change; agents can read the code.

- `docs/internals/`: decisions, cross-component constraints, and traps the source doesn't reveal. No feature catalogs, field lists, control-flow narration, or PR summaries. When a decision changes, rewrite the text instead of appending.
- `docs/user/`: one concise section per major feature in the product's voice: what it does, how to start, anything unintuitive. No UI descriptions or contributor tooling.
- `docs/operations/`: development rules, maintainer setup, release, and debugging procedures.
- Don't commit plans, research notes, or scratch files; a merged PR is the implementation record.
- Don't hard-wrap Markdown: each paragraph and list item is one line.
