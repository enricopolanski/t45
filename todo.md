# TODO

## Agent tool files: stop reading `dist/runtime` from `ChatExecutions`

`ChatExecutions` reads `dist/runtime` at construction and dies (`Effect.orDie`) when it's missing. `ChatService` builds it, so every test that builds chats needs a built server: without `dist`, `vp test run src/chats/ChatService.test.ts` fails 13/13 and `src/agent-tools/step-tools.test.ts` fails 2/2. The `test` task hides it with `dependsOn: build:bundle`, which focused `vp test run <files>` skips (missing or stale tools), and `vp pack`'s `clean: true` wipes `dist/client` of a built server running from the same checkout.

- [ ] Add an `AgentToolFiles` Effect service (`Record<path, source>`): the live layer reads `new URL("./runtime/", import.meta.url)`, the test layer provides `{}` or a fixed map.
- [ ] Make `ChatExecutions` depend on it; drop the `import.meta.filename.endsWith(".ts") ? "../../dist/runtime" : "runtime"` branch, which is test-only now that `dev` runs `dist/bin.mjs`.
- [ ] Remove `dependsOn: build:bundle` from the server `test` task.
- [ ] Have `step-tools.test.ts` and `workflow-tools.test.ts` pack the tools into a temp dir themselves (as `scripts/build.test.ts` does) instead of copying the repo's `dist/runtime`; keep testing the built artifact, since the VM has no `node_modules`.
- [ ] Inject only the tools' own files: `chunkFileNames: "runtime/[name]-[hash].mjs"` routes every chunk shared with `bin.ts` into `runtime/`, and the `.mjs` glob ships all of them (today a 994 KB `AgentTools-*.mjs` that `bin.mjs` imports too, on every boot). Use an explicit entry list or a chunk-name function keyed on tool-reachable modules.

## Workflow side effects when replaying inputs

- [ ] Define how to prevent duplicate workflow actions when pending inputs are replayed after a new input starts a failed chat, or server startup recovers a running chat. Replacing the generated conversation does not undo committed workflow changes, and new tool-call IDs can bypass the existing receipt ledger. Workflow assistant writes now deduplicate a repeated request ID transactionally; a replay where the agent chooses new IDs, and step receipts keyed by native call IDs, still need a policy.

## Real-VM verification

- [ ] Exercise the workflow assistant inside a real microVM on a machine with KVM: confirm that the MCP process runs in `/work`, a reply written through `sandbox.write` wakes its filesystem watcher, and all five operations return confirmed results. Local bundled-tool checks do not verify guest filesystem notifications.
- [ ] Use the seeded Workflow designer in a real conversation to produce and save a blueprint; the seed, shared schemas and packaged tools have been checked separately.

Other unresolved investigations and product questions are consolidated in [cleanup.md](docs/planning/cleanup.md).
