# TODO

## Agent tool files: stop reading `dist/runtime` from `RunnerService`

`RunnerService` reads `dist/runtime` at layer construction and dies (`Effect.orDie`) when it's missing. `ChatService` provides `RunnerService.layer`, so every test that builds chats needs a built server: without `dist`, `vp test run src/chats/ChatService.test.ts` fails 13/13 and `src/agent-tools/step-tools.test.ts` fails 2/2. The `test` task hides it with `dependsOn: build:bundle`, which focused `vp test run <files>` skips (missing or stale tools), and `vp pack`'s `clean: true` wipes `dist/client` of a built server running from the same checkout.

- [ ] Add an `AgentToolFiles` Effect service (`Record<path, source>`): the live layer reads `new URL("./runtime/", import.meta.url)`, the test layer provides `{}` or a fixed map.
- [ ] Make `RunnerService` depend on it; drop the `import.meta.filename.endsWith(".ts") ? "../../dist/runtime" : "runtime"` branch, which is test-only now that `dev` runs `dist/bin.mjs`.
- [ ] Remove `dependsOn: build:bundle` from the server `test` task.
- [ ] Have `step-tools.test.ts` and `workflow-tools.test.ts` pack the tools into a temp dir themselves (as `scripts/build.test.ts` does) instead of copying the repo's `dist/runtime`; keep testing the built artifact, since the VM has no `node_modules`.
- [ ] Inject only the tools' own files: `chunkFileNames: "runtime/[name]-[hash].mjs"` routes every chunk shared with `bin.ts` into `runtime/`, and the `.mjs` glob ships all of them (today a 994 KB `AgentTools-*.mjs` that `bin.mjs` imports too, on every boot). Use an explicit entry list or a chunk-name function keyed on tool-reachable modules.

## Workflow side effects when replaying inputs

- [ ] Define how to prevent duplicate workflow actions when a failed attempt is restarted by replaying all saved inputs. Replacing the generated conversation does not undo committed workflow changes, and new tool-call IDs can bypass the existing receipt ledger. Decide which effects can repeat and how the others are deduplicated.

## Port from PR #4 (`feat/add-workflow-agent`) what PR #5 lacks

PR #4 bundled the tools into the runner image under `/opt/t45/`; port its instance tools onto #5's per-boot injection under `/work/runtime` instead.

- [ ] Seed starter agents at database creation: "Workflow designer" (drafting MCP) and "Workflow assistant" (`seed.ts`).
- [ ] Workflow assistant chats bound to one deployed workflow, opened from its board or the new-chat menu (`listTargets`, `Chat.workflowId`).
- [ ] Workflow instance tools `get_workflow`, `list_tickets`, `get_ticket`, `create_ticket`, `set_field`: run with the member's permissions, check access per call, and make retries with the same `requestId` safe through transactional receipts (`WorkflowAssistant.ts`, `WorkflowToolReceipts.ts`).
- [ ] Decide draft identities: #4 drafts carry no step or field IDs and saving assigns fresh ones (`WorkflowDraft.ts`, `definitionFromDraft`); #5 has the agent supply them.
- [ ] Let authorized users start unassigned tickets; drop the `first_step_unassigned` requirement.
- [ ] Nested, collapsible step-assignment and automation cards that explain inherited defaults (`WorkflowStepPeople.tsx` replacing `WorkflowPeople.tsx`).
- [ ] Stream automation status into the step view with Run, Stop and Run again (`watchStep`, `runStepAutomation`, `StepRuns.tsx`). Saving automation config no longer starts a run; a rerun moves pending approval back to working.
- [ ] `step_done` finishes only that automation's contribution; approval still needs complete fields and sub-steps and every automation submitted (`stepReadyForApproval`). Release the sandbox once a task is submitted or fails; an invalid write fails the task with a reason on the step.
- [ ] Chat lists and APIs show only the member's own conversations (admins stop seeing triggered task chats); task histories stay internal, with results through steps.
- [ ] Model tests: `Task.test.ts`, `Workflow.test.ts`, `WorkflowDraft.test.ts`.
