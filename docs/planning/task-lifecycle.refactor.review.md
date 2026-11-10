# Task lifecycle refactor: review and experiment

Review of [task-lifecycle.refactor.md](./task-lifecycle.refactor.md) against three goals: clearer boundaries, domain logic as pure model/aggregate functions in `packages/contracts` rather than on the server, and less code, with rules tested purely in contracts instead of through services. Four readers mapped the code (task core, workflows, automations and agents, tools and transport), a critic checked the plan against the maps, three designers proposed experiments, a judge picked one, and the winner was implemented on `task-refactor`.

## Verdict

The plan gets the boundary right and names every real leak: the `Trigger` variants, `TaskState`, `StepHooks`/`saved`, `canRun` reading tickets, approval and refusals settling tasks and then deleting chats, and the step query, ledger and receipts living in `ChatRepository`. Its removals are correct.

It misses the other two goals. It assigns decisions to "the workflow model and application service" without naming a single pure function, so run planning, readiness, write scope, run closing and the automation status view would stay inline in `WorkflowService`. It makes model tests conditional on later authorization, which contradicts AGENTS.md ("Test business logic in models"), and calls line reduction a bonus. Most of its additions are not needed to remove the leak and would make the change net-neutral or larger.

## Keep

- Remove `Trigger`, `TaskState` and `Outcome`; move `ChatOrigin` to `Chat.ts` and delete `Task.ts`.
- Delete `TaskService` outright instead of renaming `StepHooks` into generic hooks. Without the state machine it is ID generation plus `chats.post`.
- The workflow owns submission, eligibility and the step↔chat association; readiness runs over workflow-owned facts.
- Approval and tool refusals stop writing task outcomes.
- Drop `chat_origins.trigger`/`state`, both JSON indexes, `listByTrigger` and `setState`.
- `AutomationRepository.list` stops decoding `TaskState` and joining chat origins.
- Keep `StepAutomation` separate from the global `Automation`.
- Keep one runtime and one owner per chat, the deferred receiver, and the guarantees in §8 (atomic slot advance and start, no automatic retry, delivery after commit).

## Overreach

| Plan section                              | Proposal                                                                                                    | Why it hurts the goals                                                                                                                               | Instead                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| §4 member conversations, §7 `workflow_id` | New workflow-owned conversation binding table, chat list composed in application code                       | It is a conversation→workflow coupling, not task→workflow; adds a table and touches `send`, `answer`, `listTargets`, the assistant and the chat list | Keep `workflow_id` for now; a later slice                                                        |
| §3 retention                              | Retain every task's output and disk until an explicit release nobody performs; a generic output-reading API | No reader exists; interval automations would accumulate VM disks                                                                                     | Pure transitions that close a run return the chats to remove; automation runs stay one-shot      |
| §4 automation activation                  | A run association table                                                                                     | The only consumer reads the latest run                                                                                                               | `lastRunChatId` on the automation                                                                |
| §5 MCP request/response                   | Request IDs, reply waiting, step-tool receipts, an export tool and two-phase attach                         | Not needed to remove the leak; a product change that roughly cancels the deletions; the attach stall is admitted to be unreproduced                  | Move the completed-part consumer to the workflow side; request/response is its own slice         |
| §4, §5 freshness                          | Store the current `InputId` on the run and bind tool calls to it                                            | Guards an imaginary race; run state already closes writes after submission                                                                           | Scope is "run working and step actionable"                                                       |
| §6 runtime extraction                     | Move posting and stopping out of `ChatService` into a shared runtime layer                                  | Moves about 70 lines between files; its payoff is server-test isolation, which the goals don't want                                                  | Make `post` generic; split only when a caller needs it                                           |
| §7 kind column                            | Explicit conversation/task kind to avoid "ambiguous all-null origins"                                       | Imaginary once trigger/state are gone; a null owner already marks a task                                                                             | Keep the null owner, pinned by a CHECK                                                           |
| §10 verification                          | No new tests, disposable checks                                                                             | Contradicts goal 3 and AGENTS.md; the step lifecycle has no tests today                                                                              | Every extracted rule gets a pure contracts test; server tests that only exercised those rules go |

## Missing

- Pure functions with signatures. The plan never names one.
- Where the run association lives. The Ticket aggregate is the consistency boundary: submission and readiness change step status atomically, and `TicketRepository.update` already writes the whole ticket.
- What happens to failed and ended runs once settlement is gone. Today a step task that ends without submitting fails, is deleted, and blocks automatic restart.
- Existing behavior the plan contradicts: mark done and approval already cancel sibling runs (the plan says not to add that), readiness auto-advances after any field write, a task whose `canRun` is false ignores its end and stays active forever.
- A test migration list, `hasWorkflowTools` next to `canWorkSteps`, removing `task_settled` from `Chat.Refused`, and that only `WorkflowService` registers the runtime receiver, so nothing runs without it.

## Inaccuracies

- `task_calls` is described as "also" a step-tool ledger; it is only that.
- "Deleting the workflow context would break assistants" is unsupported: the seeded assistant already uses `get_workflow`, which resolves the binding server-side.
- "The cleanup prompt forbids new tests": AGENTS.md forbids server and parser tests and requires model tests.
- "The existing caller-chosen input protocol": `TaskService` generates input IDs; only `ChatService.post` accepts one.
- "The inactive-task guard intends to refuse": it records the call and silently drops it after the tool already answered `ok: true`.
- "Submitted work is the resumption exception": stopped runs are continued on unblock and restart too.
- "Do not add cancellation of siblings": it already exists.
- "A step ID supplied by the LLM is not authority" is presented as a change; it is already true.
- "AutomationService records the run": nothing on the automation side records a run today.
- The plan omits that `ChatExecutions` cannot run without `WorkflowService` registering the receiver, and that it reads `WorkflowRepository`.

## Aggregates

| Aggregate                          | Module                                                     | Owns                                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Ticket, with `Step.automationRuns` | `models/Workflow.ts`, view in `resources/Workflows.ts`     | Run planning, readiness, write scope, submit, fail, end, cancel, entry change, approval through step completion, the step automation view |
| Automation                         | `models/Automation.ts`, view in `resources/Automations.ts` | Due activation, recording a run start or refusal, the last-run label                                                                      |
| Chat origin                        | `models/Chat.ts`                                           | Conversation or ownerless task; no trigger, no state                                                                                      |

## Experiment

Implemented, uncommitted, in the main checkout on `task-refactor` (from `1e65951`).

### What changed

- `models/Task.ts` and `apps/server/src/tasks/TaskService.ts` are deleted. A chat origin is a member conversation or an ownerless task with one generic flag, `isRemovedWhenEnded`. `ChatService.startTask` replaces `TaskService.start`.
- A step's automated contributions are `Step.automationRuns` inside the Ticket aggregate, each `working | submitted | cancelled | failed{reason}`. Approval stays on `step.status`.
- Pure functions in `models/Workflow.ts`:
  - Queries: `isReadyForApproval`, `canRunAutomation`, `planStepAutomationWork`, `findRunsToContinueOnRejection`, `findWorkingAutomationRuns`, `findWritableAutomationRun`, `findLatestAutomationRun`.
  - Transitions: `addAutomationRun`, `resumeAutomationRun`, `submitAutomationRun`, `failAutomationRun`, `cancelAutomationRuns`, `cancelWorkingAutomationRuns`, `changeStepAutomations`, `endAutomationRun`, and `completeTicketStep`.
  - Transitions that close runs return `chatIdsToRemove`, so retention is a workflow decision.
  - `findWritableAutomationRun` replaces the scope rule that was written three times.
- `buildStepAutomationViews` in `resources/Workflows.ts` replaces the 40-line view block in `getStep`. `StepView.step` omits the runs.
- Automations record `lastRunChatId`. `activateDue` and `recordRunStart` are in `models/Automation.ts`, and `describeLastRun` is in `resources/Automations.ts`. `AutomationRepository` no longer reads `chat_origins` or decodes task state.
- Schema:
  - `chat_origins` loses `trigger` and `state` and gains `is_removed_when_ended`.
  - Both JSON indexes are dropped.
  - `task_calls` becomes `step_tool_calls`, owned by `TicketRepository`.
  - `automations` gains `last_run_chat_id`.
- `WorkflowService` never branches on run state (`rg '\.state\.type'` is empty). It loads the facts, calls a rule, saves, starts, posts, stops or removes, and notifies.

### Measured

| Package              | Production | Tests                                                                                      |
| -------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `packages/contracts` | +173       | +348 (new `Automation.test.ts`, `Workflows.test.ts`, step run cases in `Workflow.test.ts`) |
| `apps/server`        | −234       | −101                                                                                       |
| Total                | −61        | +247                                                                                       |

The estimate was −210 in production; −61 misses the −100 bar. `WorkflowService.ts` is net −3 (1558 → 1555) against about −90 estimated. Its decisions moved to contracts, but it absorbed `TaskService`'s fire-and-forget step-tool consumer almost line for line (about 108 lines) and the start, continue and fail glue. `models/Workflow.ts` grew by +131. Most of the server deletion is `TaskService` itself.

Every check passed on this code: typecheck, lint, knip, formatting, contracts tests (30), server tests (130) and web tests (410). The pre-commit E2E ran against the dev app from the main checkout, so it did not exercise this code.

### Behavior changes

- The automation last-run label comes from the run chat's status: "Failed: The agent invocation failed." becomes "Failed".
- The step view shows "Cancelled" without a reason. "Approved" is a submitted run on a completed step.
- `task_settled` is removed from `Chat.Refused`. A refused continuation fails the run with the refusal's message.
- `step_attach` from a run that may no longer write stores no bytes, so no attachment is left orphaned.
- Run state is written to `tickets.steps`, so every change publishes a ticket change. `get_ticket` for workflow assistants includes run chat IDs.
- Chat storage can no longer say which step or automation started a chat.
- The schema fingerprint changes.

Kept on purpose:

- A run that ends without submitting fails with today's comment and notice.
- A failed run blocks automatic restart.
- Mark done and approval cancel unsubmitted sibling runs.
- Readiness auto-advances after field writes.
- Step tools still answer `ok: true`, and a refused call still fails the run.

### Not verified

- `WorkflowService` orchestration (start, continue, chat removal, save ordering, the cancel-ticket skip of completed steps) has no automated test, before or after.
- Removing automation run chats after `ended` is untested, because the automation tests hold the fake runner and no run ever ends.
- No real agent run was made.

### Conclusions

- Goals 1 and 2 hold. No task or chat code knows about steps, submissions or automations; every lifecycle rule is a pure, tested function; the server is glue.
- Goal 3 holds only for tests: rules moved from service tests to pure contracts tests, and the step lifecycle got its first coverage. Production shrinks by 61 lines, not about 200.
- The remaining server weight is the fire-and-forget step-tool consumer. The next slice that deletes code is request/response step tools, which removes the consumer, the ledger and the refusal-fails-run rule. Measure it on its own.
- The deferred leaks are still there:
  - `Conversation.workflowId` and its binding checks.
  - The workflow instruction and MCP-name gate in `ChatExecutions`.
  - Receipts in `ChatRepository`.
  - The MCP names in `Agent.ts`.
  - Receiver registration in `WorkflowService`.
