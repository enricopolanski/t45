# AGENTS.md

T45 is a web app for collaborative working assisted by agents via workflows. You define operations, automations, agents (instructions, model, skills, MCP servers).

The T45 server serves the web app and keeps the chats, workflows and agents. Agents run in sandboxed microVMs on a separate runner service, never on the server's machine; the server does not edit code or run git.

## Schema and dependencies

- Never leave `pnpm-lock.yaml` out of sync with `package.json`; regenerate it with `CI= pnpm install --no-frozen-lockfile` instead of taking a side.
- Clean slate: until the first release, installations start from an empty database, with no compatibility for older data, servers, or clients. Change the schema by editing `apps/server/src/persistence/Schema.ts` in place; don't add migrations or backward-compat shims. A changed schema refuses databases created by an older one.
- From the first release, the schema is frozen as the baseline and changes ship as migrations applied on top of it.

## Pull requests and validation

Continue on the current branch. Create a new branch or PR only when the user asks.

Every commit runs the `pre-commit` package script: workspace format/lint checks, typechecking, unused code (knip), then tests. Run it manually with `vpr pre-commit` (`vp run pre-commit` is equivalent). Vite+ caches successful tasks by default; `vpr --no-cache pre-commit` forces fresh checks. It checks the whole working tree without modifying files or staging. Use focused `vp test run <files>` while iterating.

Commits use conventional, plain-language titles (`fix(web): new threads no longer spike CPU`), a body stating the problem and the fix, and end with the model and harness that did the work.

## Tests and verification

- Test business logic in models and user behavior in the frontend, with frontend e2es as the integration boundary. Do not add server tests or parser/codec tests. Existing server tests remain for now, pending an inventory of what needs coverage, why, and whether it belongs in a model test or frontend e2e.
- Only write meaningful tests that can guarantee invariants: if you're mocking the dom, you're not testing anything. Don't test dependencies indirectly.
- Wait on an observable signal, such as a chat's change feed, a stream event or a fake's receipt; never sleeps or polling. A test that needs a timeout to pass is wrong.

## Dev servers

`vp i` installs; `vp run dev` starts server and web. Details: `docs/operations/development.md`.

- Dev state lives in the gitignored `.t45` of the checkout you launch from, even when `DATA_DIR` is set.
- Read the real ports from the `[dev-runner]` line; occupied ports shift them.
- Sign-in is Clerk (`AUTH_CLERK_PUBLISHABLE_KEY` in `.env`).

## Code map

TODO:

## Taste

- TODO:
- Complexity lives at the OpenCode boundary, in `RunnerService.ts` for per-chat execution and in `TaskService.ts` and workflow hooks for applying task receipts; T45 stores and sends OpenCode's own shapes, imported from `@opencode/*` and never declared again, and UI stays dumb.
- Inferred types over annotations; no `any`. Comments describe how a thing is used.

## Documentation

Most changes need no doc change; agents can read the code.

- `docs/internals/`: decisions, cross-component constraints, and traps the source doesn't reveal. No feature catalogs, field lists, control-flow narration, or PR summaries. When a decision changes, rewrite the text instead of appending.
- `docs/user/`: one concise section per major feature in the product's voice: what it does, how to start, anything unintuitive. No UI descriptions or contributor tooling.
- `docs/operations/`: maintainer setup, release, and debugging procedures.
- Don't commit plans, research notes, or scratch files; a merged PR is the implementation record.
- Don't hard-wrap Markdown: each paragraph and list item is one line.
