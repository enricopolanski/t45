# What PR #4 has that the current branch lacks

Compared [PR #4](https://github.com/enricopolanski/t45/pull/4), `feat/add-workflow-agent` at `b0d30055c7b025563b78d3c84d8932582007de62`, with `feat/workflow-improvements` at `a7af8ff275abf80c463481ac1b01386c3888f880`. Their common ancestor is `cafe8664ffa9b6dadeafe2572a2fe1a2df9f026c`; PR #4 is still open and unmerged. These are parallel branches, so an absent feature usually was never brought over, rather than removed by the current refactor.

This inventory checks PR #4's three commits and 67 changed files against the current implementations and callers. It expands the existing [PR #4 checklist in todo.md](../../todo.md#port-from-pr-4-featadd-workflow-agent-what-pr-5-lacks), distinguishes missing behavior from different implementation choices, and includes the current-step file omission that checklist does not mention. This was a source comparison, not a live verification of PR #4; its PR description reports that its validation did not run. No application code or tests were changed.

## Inventory

| PR #4 behavior                                            | Current branch             | What remains                                                                                                 |
| --------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Two starter agents on a fresh installation                | Missing                    | Seed Workflow designer and Workflow assistant once, preserving later admin edits.                            |
| Conversations bound to a deployed workflow                | Missing                    | Workflow identity, accessible chat targets, board entry point and workflow context.                          |
| Workflow reads and writes through confirmed agent tools   | Missing                    | Five tools, member authorization, transactional request receipts and a result path back to the waiting tool. |
| Drafts without IDs, identities assigned on save           | Different design           | Decide whether to keep agent-supplied IDs or restore generated IDs. Shared validation already exists.        |
| Authorized creation of unassigned tickets                 | Missing                    | Remove the initial-assignment requirement while retaining authorization.                                     |
| Nested assignment cards and compact automation editing    | Missing                    | Collapsible hierarchy, inheritance summaries and one automation editor at a time.                            |
| Live step updates and actual execution status             | Missing                    | A step subscription and execution information beyond the task's business state.                              |
| Run, Stop and Run again on each automation                | Missing                    | Explicit commands, fresh attempts, and rerunning from pending approval.                                      |
| Saving automation configuration without running it        | Missing                    | Saving still starts new or changed entries.                                                                  |
| Finishing one automation independently of the shared step | Implemented                | `submit_task` submits only that task; shared readiness retains the completion checks.                        |
| Failing a task on a refused workflow write                | Missing                    | Refusals still enqueue another agent input.                                                                  |
| Passing the current step's file-field values to the agent | Missing                    | Inputs include earlier fields' files and loose attachments, but omit current fields' files.                  |
| Keeping task conversations internal                       | Missing                    | Admins still see task chats; workflow participants can access step chats.                                    |
| Releasing a VM when a task submits or fails               | Partly covered differently | Finished executions already release their VMs; submission itself does not request a stop.                    |

## 1. Starter agents

PR #4 adds [persistence/seed.ts](https://github.com/enricopolanski/t45/blob/b0d30055c7b025563b78d3c84d8932582007de62/apps/server/src/persistence/seed.ts) and includes its statements in initial schema creation. It supplies two conversational agents:

- **Workflow designer:** helps draft reusable blueprints and has the drafting MCP server.
- **Workflow assistant:** works with one deployed workflow, reads its current state and uses the instance tools to make requested changes as the member.

The current [Schema.ts](../../apps/server/src/persistence/Schema.ts) creates the agents table but seeds neither agent, and there is no equivalent initialization elsewhere in the application. An admin must create a drafting agent manually; creating an agent with the assistant's name alone would not supply the missing instance capabilities.

The useful behavior to carry over is creation only on a fresh database, leaving subsequent admin changes alone. The extra `seed.ts` file and PR #4's particular model choice are not requirements. The assistant seed belongs with its working capability, rather than exposing an agent whose configured tool is unavailable.

## 2. Workflow-bound conversations and their entry points

PR #4 adds a workflow target alongside the agent target throughout chat creation. Its [ChatService.ts](https://github.com/enricopolanski/t45/blob/b0d30055c7b025563b78d3c84d8932582007de62/apps/server/src/chats/ChatService.ts) fixes the conversation to one workflow, verifies access, supplies workflow context and names the chat target after that workflow. The first input stores the workflow ID; subsequent sends cannot switch it.

The UI adds a **Chat** action on a workflow board and workflow entries in the new-chat menu. New chat navigation retains the workflow when starting another conversation from an existing workflow chat. The assistant is selected through accessible workflow targets, rather than offered as a generic unbound agent.

None of this exists in the current path:

- [WorkflowBoardPage.tsx](../../apps/web/src/components/workflows/WorkflowBoardPage.tsx) offers ticket creation but no workflow chat action.
- [useNewChat.ts](../../apps/web/src/hooks/useNewChat.ts) selects from `agents.list` and navigates with only an agent ID.
- [Chats.ts](../../packages/contracts/src/resources/Chats.ts) has no `listTargets` RPC or workflow field on chat creation/summary; [Chat.ts](../../packages/contracts/src/models/Chat.ts) has no workflow binding in its input payload.
- [ChatService.ts](../../apps/server/src/chats/ChatService.ts) has no workflow conversation context or target selection.

The `Chat.workflowId` shorthand in `todo.md` is imprecise: PR #4 actually puts the binding in `InputPayload`, retrieves it from the first input, and exposes it in `ChatSummary`. That storage choice is not a prerequisite for restoring the feature. The important contract is that a member's conversation has one authoritative workflow scope, checked by the server.

## 3. Workflow instance tools and confirmed results

PR #4's [WorkflowAssistant.ts](https://github.com/enricopolanski/t45/blob/b0d30055c7b025563b78d3c84d8932582007de62/apps/server/src/workflows/WorkflowAssistant.ts) implements these operations:

| Tool            | Behavior in PR #4                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_workflow`  | Returns the bound workflow and its current blueprint, including real step and field IDs.                                                                 |
| `list_tickets`  | Returns up to 100 visible tickets, optionally filtered by title, plus the total number of matches.                                                       |
| `get_ticket`    | Returns a visible ticket from that workflow, including its steps and values.                                                                             |
| `create_ticket` | Calls the ordinary workflow command as the member and returns the saved ticket.                                                                          |
| `set_field`     | Checks that the ticket belongs to the bound workflow and that the member may change it, applies the ordinary field command and returns the saved ticket. |

The assistant reloads the active member and workflow for operations, applies ticket visibility, and does not let the agent choose another member's identity. The write tools return the actual result or refusal. They are not merely draft suggestions or step receipts that optimistically acknowledge a call inside the VM.

All five tools are absent. Current [agentTools.ts](../../packages/core/src/agentTools.ts) exposes only blueprint drafting and step tools; current [TaskService.ts](../../apps/server/src/tasks/TaskService.ts) consumes completed tools only for step-triggered tasks. A normal member conversation cannot currently query or mutate workflow state through this built-in mechanism.

PR #4 also includes two supporting behaviors that cannot be replaced by copying its tool names:

- **Request identity and saved replies.** [WorkflowToolReceipts.ts](https://github.com/enricopolanski/t45/blob/b0d30055c7b025563b78d3c84d8932582007de62/apps/server/src/chats/WorkflowToolReceipts.ts) uses a supplied UUID `requestId`, compares repeated calls, and records write results in the same transaction as their workflow effects. Access is checked before replay. Current `task_calls` deduplicates native message/part IDs for step tasks; it does not implement this member-operation contract.
- **A reply to the running tool.** [workflow-instance-tools.mjs](https://github.com/enricopolanski/t45/blob/b0d30055c7b025563b78d3c84d8932582007de62/apps/runner/image/workflow-instance-tools.mjs) waits for a JSON reply file while its OpenCode tool part remains `running`. The server observes that running part, executes the operation, then writes the reply through the old runner file channel. Current [Runner.ts](../../packages/contracts/src/resources/Runner.ts) has no standalone file-reply operation, current [mcp-stdio.ts](../../apps/server/src/agent-tools/mcp-stdio.ts) expects a synchronous tool result, and the task consumer ignores running parts.

This is the largest missing feature and the largest adaptation. Preserve confirmed results and authorization, but implement them against the current execution boundary. Do not restore the old server-owned OpenCode worker, `ChatHooks` callbacks or image packaging merely to recover the capability. Workflow decisions still belong on the server; any transport support in the runner should be independent of workflow tool names.

There is also a concrete persistence difference: PR #4 stores its replay receipts as synthetic chat messages, whereas the current execution model discards uncommitted messages on stop or failure. A port must keep an applied workflow operation's receipt durable with its effect; blindly storing it as ordinary provisional execution output would lose the property PR #4 was adding.

## 4. Draft identity generation is different, not wholly missing

PR #4's [WorkflowDraft.ts](https://github.com/enricopolanski/t45/blob/b0d30055c7b025563b78d3c84d8932582007de62/packages/contracts/src/models/WorkflowDraft.ts) describes draft content without step or field IDs. `definitionFromDraft` assigns fresh IDs recursively when the member saves it, including nested groups and substeps. The agent therefore supplies names and content, not persistence identities; separate saves get separate IDs.

The current [AgentTools.ts](../../packages/contracts/src/resources/AgentTools.ts) instead uses the definition's actual steps schema, including IDs, and [WorkflowDraftCard.tsx](../../apps/web/src/components/chat/WorkflowDraftCard.tsx) passes the draft directly to `workflows.createDefinition`. The injected tool explicitly asks the agent to provide valid IDs.

What is missing is **ID-free authoring and fresh identity assignment on save**. Shared draft validation is already present: the tool and web import the same contract. Unreadable drafts and failed saves also already show errors. Those parts of PR #4 do not need reimplementation, and keeping the current ID contract is a product/design choice rather than evidence of a broken save path.

## 5. Starting unassigned tickets

PR #4 removes the requirement that a first step already have a human assignee or automation before a ticket can start. Workflow overseers remain authorized to start it; an unrelated member does not acquire that permission, and archived workflows or definitions without steps remain refused.

Current [ticketStartRefusal](../../packages/contracts/src/models/Workflow.ts) still returns `first_step_unassigned`, and [WorkflowPeople.tsx](../../apps/web/src/components/workflows/WorkflowPeople.tsx) still shows the corresponding warning and omits the first step's clear-assignee action.

This is a small independent missing behavior. It does not depend on workflow chat tools, runner changes or a new model abstraction. PR #4's [Workflow.test.ts](https://github.com/enricopolanski/t45/blob/b0d30055c7b025563b78d3c84d8932582007de62/packages/contracts/src/models/Workflow.test.ts) records the intended authorization distinction; the current test still expects an unassigned first step to be refused even for an organization admin.

## 6. Assignment and automation editing

PR #4's [WorkflowStepPeople.tsx](https://github.com/enricopolanski/t45/blob/b0d30055c7b025563b78d3c84d8932582007de62/apps/web/src/components/workflows/WorkflowStepPeople.tsx) renders the step hierarchy as nested collapsible cards, with summaries of the assignee, responsible person, automation count and substep count. It explains unassigned first steps and inheritance from the previous or parent step. Opened cards retain unsaved automation edits when folded.

Current [WorkflowPeople.tsx](../../apps/web/src/components/workflows/WorkflowPeople.tsx) flattens the hierarchy into a permanently expanded list. Assignment inheritance itself already exists in the model; the missing part is its presentation and the first-step clearing behavior described above. PR #4 did not replace the whole `WorkflowPeople.tsx` file: it extracted the step-assignment portion, leaving workflow-level people and administration there.

PR #4 also changes [StepAutomationsEditor.tsx](https://github.com/enricopolanski/t45/blob/b0d30055c7b025563b78d3c84d8932582007de62/apps/web/src/components/work/StepAutomationsEditor.tsx): saved entries become compact rows, with one temporary add/edit form, explicit cancel, read-only display and optional run controls. The current editor still renders every automation as a form and saves the whole draft list.

These UI behaviors are absent. Restoring them does not require adopting every component split or callback prop from PR #4.

## 7. Live step updates and execution status

PR #4 adds `workflows.watchStep`, subscribes to committed ticket changes and relevant task execution changes, and renders the streamed `StepView`. Agent updates to fields, comments, attachments and task status can then appear while someone is looking at the step.

The current [StepPage.tsx](../../apps/web/src/components/work/StepPage.tsx) calls `workflows.getStep` on opening and after its own actions. It has no subscription to changes made by an agent or another browser. [TicketRepository.ts](../../apps/server/src/workflows/TicketRepository.ts) has neither PR #4's change publication nor its watch function, and [Workflows.ts](../../packages/contracts/src/resources/Workflows.ts) has no `watchStep` RPC.

PR #4 separately derives an execution status: `starting`, `processing`, `waiting`, `stopped`, `finished` or `failed`. Its [StepRuns.tsx](https://github.com/enricopolanski/t45/blob/b0d30055c7b025563b78d3c84d8932582007de62/apps/web/src/components/work/StepRuns.tsx) presents the latest attempt for each automation, including why it failed or stopped. Current `StepView.tasks` contains only the business state from [Task.ts](../../packages/contracts/src/models/Task.ts), and the UI labels every active task “Working”; stopping a chat can leave its task active, so those are not equivalent states.

The missing behavior is accurate, live execution feedback. PR #4's implementation reads old `vm`, stop-request and open-input fields that the execution refactor removed, so its `taskExecution` function and worker queries cannot be copied unchanged. Preserve the distinction between a submitted task and a running execution without restoring those old fields just for the display. PR #4 also orders task rows before using `findLast` to choose the latest attempt; the current origin query does not define that ordering.

## 8. Run, Stop and Run again, separate from configuration

PR #4 adds `runStepAutomation`, `stopStepAutomation`, a server-derived `canRunAutomations` flag and buttons for each entry. Its [WorkflowService.ts](https://github.com/enricopolanski/t45/blob/b0d30055c7b025563b78d3c84d8932582007de62/apps/server/src/workflows/WorkflowService.ts) implements these user-visible distinctions:

- Saving an entry changes configuration and cancels changed unfinished work, but does not immediately start its replacement.
- Running starts a fresh task with the latest brief and files, cancelling an unfinished attempt for that entry.
- Running is permitted while the step is actionable or awaiting approval; a rerun moves pending approval back to working. It does not reopen completed or blocked work.
- The explicit Stop command settles active attempts for that entry as cancelled. This differs from temporarily stopping tasks because their step is blocked.

Current [setStepAutomations](../../apps/server/src/workflows/WorkflowService.ts) still starts every new or changed entry after saving, and neither explicit RPC exists in [Workflows.ts](../../packages/contracts/src/resources/Workflows.ts). There are no per-entry run controls on the step page. Opening the task's chat and stopping or sending it another message is not the same operation as a fresh attempt against the latest step inputs.

These changes should travel together: removing automatic execution on save without supplying Run would remove the existing way to start a newly configured entry. PR #4 still starts default automations when a ticket enters a step; its configuration change is not a switch to making every execution manual.

## 9. `submit_task` means “my contribution is finished”

PR #4 lets an automation submit its contribution while other required fields or substeps remain unfinished. Shared approval readiness still requires the fields and substeps to be complete and every automation to have submitted.

Implemented as `submit_task`, exposed by OpenCode as `step_submit_task`: [WorkflowService.ts](../../apps/server/src/workflows/WorkflowService.ts) submits the calling task without requiring the shared step to be complete, and both the brief and [step-tools.ts](../../apps/server/src/agent-tools/step-tools.ts) describe finishing only that automation's contribution. An extraction automation can submit while a separate review or human contribution is outstanding.

The existing `refreshReadiness` keeps the shared approval guard and now also runs when fields or file fields change, a child completes, the definition changes, or a step is unblocked. Human completion and approval still require complete fields and substeps; task submission leaves the execution to finish normally.

## 10. Refused writes end the attempt

PR #4 turns a workflow refusal into a failed task outcome, with the tool and refusal reason reported on the step and the responsible person notified. It removes the path that asks the agent to try another turn after a rejected write.

The current [receipt handler](../../apps/server/src/workflows/WorkflowService.ts) still calls `tasks.continue` with `refusalPrompt(...)` and keeps the attempt active. Its existing `taskFailed` function already knows how to add the step comment and notification; the missing part is choosing that outcome when a receipt is refused.

This policy is independent of the execution retry loop removed earlier: that removal stops infrastructure failures being retried, while workflow refusals still deliberately create more inputs. PR #4's behavior would cut this continuation path. It concerns calls refused by T45's workflow application; it should not be described as making every OpenCode/MCP error automatically fail the task.

## 11. The current step's file fields reach the agent

PR #4 adds `fieldFiles(full.fields)` to `taskInput`'s attachment collection, alongside `fieldFiles(full.inputs)` and loose step attachments. The current [taskInput](../../apps/server/src/workflows/WorkflowService.ts) still collects only the latter two.

Consequently, a file uploaded into a field on the current step can appear in the brief's field data without being included in that input's attachment transfer. This matters when starting another automation after the upload or continuing work after rejection: the new input should carry the current step's documents as well as documents from earlier steps.

This is a small missing change with no new service or protocol requirement. PR #4's attachment expression can be adapted directly to the existing helper; it does not depend on adding the Run again feature first.

## 12. Task histories stay internal

PR #4 makes chat lists and public chat APIs expose only conversations owned by the member. Workflow task results and execution controls are presented through the step instead. It removes the task-chat links from the step page and the “Open” chat action after an automation is started from settings.

The current branch retains the previous behavior:

- [ChatRepository.list](../../apps/server/src/chats/ChatRepository.ts) includes triggered tasks for organization admins.
- [ChatService.permission](../../apps/server/src/chats/ChatService.ts) allows admins into automation chats and derives step-task access from ticket involvement or public visibility.
- [TaskService.send](../../apps/server/src/tasks/TaskService.ts) allows public chat sends to continue eligible tasks; [Chats.handlers.ts](../../apps/server/src/chats/Chats.handlers.ts) routes through it and settles tasks when their chat is deleted.
- [StepPage.tsx](../../apps/web/src/components/work/StepPage.tsx) still links each task to its chat, and [AutomationsSettings.tsx](../../apps/web/src/components/settings/AutomationsSettings.tsx) still offers “Open” after Run now.

This is a missing product policy, not an accidental authorization hole under today's documented policy. It is also a meaningful simplification opportunity: restricting member chat APIs to owned conversations removes task-specific permission branches and continuation/deletion plumbing. Bring the step-level status and controls over with that restriction so users retain a way to observe and control their work. Internal task histories and service commands remain; “internal” does not mean deleting the histories.

## 13. Submission releases execution resources

PR #4 requests a stop when a task becomes submitted as well as when it settles, and skips the old idle-VM grace period for inactive background tasks.

Current [TaskService.transition](../../apps/server/src/tasks/TaskService.ts) requests a stop only for `settled`. A submitted task's execution continues until OpenCode is done. However, [ExecutionOrchestrator.ts](../../apps/runner/src/ExecutionOrchestrator.ts) already saves and removes every normally finished execution's VM immediately, and settled tasks already request a stop. There is no old idle grace period to port.

The remaining difference is submission-triggered termination, including when background work would otherwise keep the execution alive. This is not a mechanical change to one condition: current [ChatExecutions.ts](../../apps/server/src/chats/ChatExecutions.ts) treats a stop as an interruption and discards the execution's output and disk changes, while the task receipt may already have committed. Decide how successful submission ends an execution under that contract before copying PR #4's `requestStop` call. Do not reintroduce `keepAlive`, asleep/awake state or idle timers.

## Already covered or superseded

| PR #4 change                                                   | Current equivalent or reason not to restore it                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tool and web share workflow draft validation                   | Already implemented through `resources/AgentTools.ts` and the injected workflow tool. Only the ID policy differs.                                                  |
| Explain unreadable drafts and save failures                    | Already implemented in `ChatTimeline.tsx` and `WorkflowDraftCard.tsx`, using the current `ErrorText`.                                                              |
| Bundle application schemas with tools for the guest            | Already implemented by the server's tool build and per-execution file injection.                                                                                   |
| Copy tools into `/opt/t45` in the runner image                 | Superseded by `/work/runtime`; new instance tools belong in the current mechanism.                                                                                 |
| Keep task states and wait for every automation before approval | Already present. What differs is when one task may submit and how its execution is shown.                                                                          |
| Release inactive VMs without waiting for an idle timeout       | The idle-VM architecture is gone. Every finished execution already removes its VM.                                                                                 |
| Old worker publication and startup hooks                       | Adapt the required behavior to `ChatExecutions` and the current service construction; the old `RunnerService` worker and `server.ts` no longer exist in that form. |
| Existing chat/runner test fixture adjustments                  | Mostly consequences of the privacy and old worker changes, not separate product features. Do not bring back removed worker scaffolding.                            |

## Coverage present only on PR #4

PR #4 adds model cases in `Task.test.ts`, `WorkflowDraft.test.ts` and `Workflow.test.ts` for execution-state presentation, generated draft identities, contribution versus shared readiness, rerun eligibility and unassigned ticket creation. The current branch has neither of the first two files and retains the older unassigned-ticket expectation in `Workflow.test.ts`. Its chat tests also retain the current task-access policy rather than PR #4's owner-only policy.

Those files document the intended behavior; their absence is not a reason to copy obsolete types or add tests during this inventory. PR #4's task-state cases depend on worker fields the current design removed, and draft-ID cases apply only if that ID policy is chosen. The existing current tool tests already exercise shared draft validation.

## Suggested order

These are proposed implementation batches, not changes already made; agreed decisions are marked explicitly. Each batch has a concrete result, the files that own it, and a short verification target. The designer seed moves to the beginning because it is independent; the assistant seed stays with the working assistant feature.

| Batch | Result                                                                                        | Depends on                                                       |
| ----- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| A     | A fresh installation has a working Workflow designer.                                         | Existing drafting capability.                                    |
| B     | Agents receive current-step documents; authorized users can start unassigned tickets.         | Nothing else in this plan.                                       |
| C     | Automation contribution, failure and approval have consistent meanings.                       | B for document completeness.                                     |
| D     | The step page updates live and shows meaningful task status.                                  | C's task semantics.                                              |
| E     | Each automation has Run, Stop and Run again; saving only changes configuration.               | B, C and D.                                                      |
| F     | Member chat APIs expose owned conversations, with task controls on steps.                     | D and E.                                                         |
| G     | Assignment hierarchy and automation editing are easier to use.                                | B; E for the run controls.                                       |
| H     | The draft-ID decision is explicit.                                                            | Independent; recommended to keep the current contract initially. |
| I     | Workflow-bound assistant chats can read and change real workflow data with confirmed results. | F; B for creating unassigned tickets.                            |

### A. Seed the Workflow designer

**Files:** `apps/server/src/persistence/Schema.ts`; reuse `WORKFLOW_DRAFTING_MCP` from `packages/core/src/agentTools.ts`.

**Agreed for now:** treat the designer as an ordinary editable starter agent, using the existing agent model and execution path. Keep its initial configuration as typed TypeScript data in `Schema.ts`, without a separate seed module.

- [x] A1. Define the designer's initial configuration as a typed TypeScript object and insert it with bound parameters after table creation, inside `setupSchema`'s existing empty-database transaction. Use the stable `workflow-designer` ID and name `Workflow designer`.
- [x] A2. Supply concise instructions: clarify the requested process, use the draft tool for the complete proposal and revisions, and explain that the member must save the blueprint and configure the deployed workflow.
- [x] A3. Configure the existing drafting MCP preset, `is_conversational = 1`, and the normal active/provider-network defaults; leave editable files and skills empty. Serialize the MCP configuration to JSON and pass it as a bound value, without embedding the data in SQL strings or manually escaping it.
- [x] A4. Choose a model offered by `agents.listModels` at implementation time, and store its explicit slug in the seed. Keep schema creation independent of provider availability; it should not fetch a model catalog or dynamically select a model while creating the database.
- [x] A5. Let the ordinary agent editor own all later changes. Seeding runs only as part of creating an empty database, so restarting does not recreate an archived agent or overwrite edited instructions, model or MCP settings. Keep seed content outside the schema fingerprint: changing a default prompt or model affects new installations without invalidating existing databases or changing their agents.

**Implementation and verification:** `Schema.ts` now supplies the designer using `opencode-go/deepseek-v4.1-flash`, verified against the [OpenCode Go catalog](https://opencode.ai/zen/go/v1/models). A disposable database check read the seeded configuration through `AgentRepository`, edited and archived it through the repository, then closed and reopened the database and confirmed the changes persisted without duplicate agents. `vp run pre-commit` passes, including the existing drafting-tool tests; no tests were added. A live browser/runner conversation producing and saving a blueprint remains unverified.

**Done when:** a fresh scratch database lists the designer, its chat can produce a savable blueprint, and restarting that same database preserves an admin's edits. Existing databases do not acquire the starter agent on restart. This needs neither a seeding service nor a separate seed file. The Workflow assistant is added in I7, once its tools work.

#### Future design: agent ownership and prepared images

The unresolved question is whether supplied agents are organization-owned recipes after initialization, or application-owned capabilities whose behavior changes with releases. The current starter-agent choice leaves that product decision open; it does not commit every future built-in agent to editable database rows.

An alternative is to ship an agent as a prepared image containing its instructions, model configuration, skills and tools, then supply the execution's prompt and context at runtime. Explore that through one shared agent definition and execution path for both supplied and user-created agents. An image could be an artifact of that definition; avoid an independent configuration system or workflow-specific behavior in the runner. Credentials and host-enforced permissions still belong to runtime setup.

Before adopting this, establish whether agents actually need different installed environments, and how ordinary agent edits would work: rebuilding an image or applying configuration at startup. The designer currently uses the shared runtime, so dedicated images would add packaging work without an established benefit. Revisit this when application-owned behavior or distinct runtime dependencies become concrete needs; it does not block A.

### B. Bring over the two small independent behavior changes

**Files:** `apps/server/src/workflows/WorkflowService.ts`, `packages/contracts/src/models/Workflow.ts`, `apps/web/src/components/workflows/WorkflowPeople.tsx` and the existing workflow model tests.

- [x] B1. Include `fieldFiles(full.fields)` in `taskInput`'s existing deduplicated attachment list. Keep the existing handling of prior-step fields, nested/repeatable fields and loose attachments.
- [x] B2. Remove the `first_step_unassigned` refusal from `ticketStartRefusal`. Retain the checks for a real first step, an active workflow and an authorized actor.
- [x] B3. Remove the obsolete warning and allow clearing the first step's default assignee in the editor. Remove `hasInitialWork` and its refusal text once their callers are gone.
- [x] B4. Update the existing test that expects an organization admin to be refused solely because the first step is unassigned; retain its other authorization assertions.

**Done when:** a new or continued task receives a file currently stored in its step's file field; an overseer can start an unassigned ticket, while an unrelated member still cannot. No runner or RPC change is needed.

### C. Separate task contribution from shared step completion

**Files:** `apps/server/src/workflows/WorkflowService.ts`, `apps/server/src/tasks/TaskService.ts`, `apps/server/src/agent-tools/step-tools.ts`; execution files only if the C4 decision requires them.

- [x] C1. Rename `step_done` to `submit_task` (`step_submit_task` in OpenCode), submitting the active task without calling `requireComplete` on the shared step. Preserve required-field and substep checks for human completion and approval readiness.
- [x] C2. Update `buildAssignmentPrompt`, `buildTaskInput`, `buildResumptionPrompt` and the step tool descriptions together: finish this automation's contribution, explain remaining work in a comment, call `step_submit_task`, and stop producing further work. Keep `step_give_up` for a contribution the agent cannot complete.
- [ ] C3. Return a failed task outcome for a workflow receipt refusal, containing the tool name and refusal reason. Reuse `taskFailed` for the comment and notification. Delete `refusalPrompt` and the refusal-driven `tasks.continue` path; retain the existing receipt ledger and attachment preparation outside the transaction.
- [x] C4. Keep the normal execution finish described below. Preserve submission as a business state even if the agent's final turn is still ending.
- [x] C5. Recompute the existing approval predicate when the remaining shared work becomes complete, including a human filling the last required field or approving the final substep after all automations submitted. Keep this in the existing workflow mutation paths. Without it, independent contribution submission can leave a complete step waiting for another unrelated event to become ready.
- [x] C6. Preserve rejection and blocking behavior: rejection continues the submitted tasks with a fresh brief; blocking pauses active work; explicit cancellation settles it. Additional receipts after a task submits remain consumed without applying more workflow writes.

**C4 decision:** keep the current normal execution finish for the first implementation: `step_submit_task` submits the task, later receipts cannot change the step, and the VM is saved and removed when OpenCode finishes. This is the smallest implementation and preserves the saved conversation and workspace for rejection. It deliberately leaves PR #4's immediate submission-triggered termination unported, including the case where background work keeps the execution alive; record that as an explicit tradeoff, not as completed parity.

If immediate termination is required, first demonstrate a generic runner finish operation that stops native work, captures final state and follows the existing disk-save/`finished` path. Exercise rejection and continuation from that disk before adopting it. Ordinary `requestStop` currently discards output and is therefore unsuitable for successful submission; adding workflow-tool detection to the runner would also put the policy in the wrong place. This alternative is a separate lifecycle change, not an extra condition hidden in `transition`.

**Done when:** with two automations and one human-required field, each automation can submit independently, the step becomes ready only when all shared work is complete, and a refused workflow write ends that attempt with a visible reason rather than another agent turn.

### D. Stream step changes and expose execution status

**Files:** `TicketRepository.ts`, `WorkflowService.ts`, `Workflows.handlers.ts`, `TaskService.ts`, `ChatRepository.ts`, `packages/contracts/src/resources/Workflows.ts` and `apps/web/src/components/work/StepPage.tsx`.

- [ ] D1. Publish ticket invalidations after committed inserts, updates and comments. Include loose attachment add/remove and task-state changes, which do not necessarily update the ticket row. Keep publication in the existing repository/service paths.
- [ ] D2. Add `workflows.watchStep` returning the existing `StepView`. Subscribe before the initial read, reread after relevant committed changes, and reuse the same ticket visibility check for subsequent reads. Coalesce invalidations because the stream sends current views, not a history of every intermediate mutation.
- [ ] D3. Include relevant existing chat-status changes so starts, stops and execution failures refresh the task presentation even when the ticket's fields are unchanged. Filter by the task's ticket identity when composing the subscription in the workflow layer; the runner need not publish workflow events.
- [ ] D4. Derive execution presentation from the persisted task state and chat status. Proposed initial labels are `running`, `stopped`, `finished` and `failed`, with a blocked step shown as paused. Submitted/succeeded tasks are finished, failed outcomes are failed, cancelled outcomes are stopped, and an active task's chat supplies running/interrupted/failed status. Avoid resurrecting VM awake/asleep fields to distinguish booting from processing; that finer distinction is not necessary for Run/Stop controls.
- [ ] D5. Define attempt ordering when querying tasks for a step, using their chat creation order with a deterministic tie-breaker, so the latest entry shown by the UI is intentional. Read statuses in the same query where practical rather than issuing a worker lookup for every task.
- [ ] D6. Replace `StepPage`'s local loading-state union and manual load cycle with the existing `apiWatch`/`useApiQuery` machinery. Keep the existing mutation error display and refresh the work/notification lists when appropriate. Preserve the behavior of marking a step's notifications read when it is viewed.
- [ ] D7. After moving the page, check callers of the public `getStep` RPC; remove it if nothing needs it, while retaining the internal view-building function used by the stream.

**Done when:** an open step shows agent-written fields, comments, files and task completion without reloading, and stopping an active execution no longer leaves the UI claiming it is working. The display may say Running throughout startup; it must not claim an unsupported distinction between starting and processing.

### E. Add explicit automation run controls

**Files:** `packages/contracts/src/resources/Workflows.ts`, `Workflows.handlers.ts`, `WorkflowService.ts`, `StepPage.tsx` and `StepAutomationsEditor.tsx`; reuse `TaskService.start` and settlement.

- [ ] E1. Add `runStepAutomation({ stepId, automationId })` and `stopStepAutomation({ stepId, automationId })` to the workflow RPCs. Use the existing actor/involvement checks and verify that the entry belongs to that step.
- [ ] E2. Implement Run in one workflow transaction: validate the agent, cancel any unfinished attempt for that entry, move an awaiting-approval step back to working, and start a fresh task using the current brief and documents. Permit actionable and awaiting-approval steps; refuse blocked/completed steps and closed tickets.
- [ ] E3. Implement Stop by settling that entry's active task as cancelled with a user-facing reason and using the existing execution stop request. Stopping one entry leaves other automations running; blocking the whole step retains its separate pause behavior.
- [ ] E4. Derive `canRunAutomations` alongside `StepView` from the same rules as the command. Show the latest attempt's status/reason and Run, Stop or Run again in the existing automation area. Use one control location rather than duplicate buttons in both a list and a second panel.
- [ ] E5. Remove the `startEntry` loop from `setStepAutomations` only when Run is available. Continue cancelling changed or removed unfinished attempts and recomputing readiness. Leave automatic entry execution in `startWork` intact when a ticket enters a step.
- [ ] E6. Remove any now-redundant task-chat controls from the automation area as part of F, after verifying that the new controls cover the ordinary workflow.

**Done when:** adding/editing an automation only saves it; Run starts one fresh attempt; Run again after a new document uses that document and revokes pending approval; Stop cancels only that attempt. Entering a step still starts its configured default automations.

### F. Make task conversations internal and remove their public plumbing

**Files:** `ChatRepository.ts`, `ChatService.ts`, `TaskService.ts`, `Chats.handlers.ts`, `StepPage.tsx`, `AutomationsSettings.tsx`, and the existing chat access tests.

- [ ] F1. Restrict the chat-list query to `owner_user_id = member.userId` and simplify chat access to an owned conversation. Remove task-trigger, ticket-visibility and admin-task branches from the public chat access path.
- [ ] F2. Route `chats.send` directly to `ChatService.send` and remove `TaskService.send`, which exists to let public chat commands continue tasks. Keep the internal task continuation method used by rejection and unblocking.
- [ ] F3. Remove task settlement from `chats.delete` once task chats cannot reach that handler. Remove the resulting unused WorkflowService/TaskService dependencies and transactional wrapper there; retain normal conversation deletion cleanup.
- [ ] F4. Remove “Open chat” from step attempts and the automation settings toast. Keep the started confirmation and the step status/results from D/E. Ordinary member conversations remain accessible only to their owner, including against other admins.
- [ ] F5. Update existing access expectations and affected fixtures for the new policy. Verify that step attachments remain readable through step permissions after task-chat access closes.

**Done when:** admin and member chat APIs both refuse task chats, the chat list contains only the viewer's conversations, and workflow participants can still observe results and run/stop attempts from their steps. General scheduled/webhook task histories remain internal, as in PR #4; adding a separate general run-history page is outside this port.

### G. Restore the assignment and automation editing improvements

**Files:** `apps/web/src/components/workflows/WorkflowPeople.tsx` and `apps/web/src/components/work/StepAutomationsEditor.tsx`; split a component file only if it improves the resulting code.

- [ ] G1. Render step assignments recursively so substeps appear beneath their parent. Put the existing pickers inside collapsible cards and show the effective/default assignee, responsible person and counts in the closed summary.
- [ ] G2. Explain the three existing defaults: first step unassigned, later top-level step inherits the previous assignee, and substep inherits the parent's assignee. Keep the model responsible for resolution.
- [ ] G3. Render saved automations as rows with name and instructions; use one local draft for add/edit and explicit Save/Cancel. Clear the draft only after a successful save, and retain it when its card is folded.
- [ ] G4. Render entries for readers as well as editors; hide editing controls according to the existing permissions. Integrate E's run actions without exposing callback options that have no caller.

**Done when:** the hierarchy and inherited assignments are clear without opening every editor, folding preserves an in-progress edit, and one automation can be edited without turning the whole list into forms.

### H. Resolve the draft-ID choice independently

**Recommendation:** keep the current shared draft/definition contract initially. A working designer and the rest of the port do not depend on changing IDs.

- [ ] H1. Record the chosen policy: keep model-supplied IDs, or require ID-free drafts. If keeping the current policy, close this parity item as intentionally different and leave the existing schema/save path in place.
- [ ] H2. Only if ID-free drafting is selected, define the draft schema from the existing field/step schemas with identities omitted, generate identities recursively when saving, and update the tool description, draft rendering and save call together. Keep normal `createDefinition` validation authoritative.
- [ ] H3. For that alternative, check nested groups/substeps and separate saves using the same draft; adapt relevant existing coverage to the chosen behavior rather than keeping two competing draft formats.

**Done when:** the tool and save path agree on who assigns IDs. This batch should not create an additional draft conversion path unless the ID-free behavior is wanted.

### I. Deliver the workflow assistant as one connected feature

This batch has four real responsibilities: bind the conversation, authorize/apply an operation, keep its receipt, and return the result to the waiting tool. Implement them in that order and expose the assistant only when the full path works. The details below are a proposed shape to validate, not an instruction to restore PR #4's module layout.

#### I1. Store the conversation's workflow identity

- [ ] Add a nullable workflow reference to the conversation origin in `Task.ts` and `chat_origins` in `Schema.ts`; populate it atomically with chat creation in `ChatRepository`/`ChatService`. This is the proposed replacement for recovering identity from the first input, which a member can cancel.
- [ ] Extend chat creation and `ChatSummary` with the workflow ID. Resolve and authorize it on the server, and refuse attempts to change the workflow or agent of an existing chat. Ordinary conversations carry no workflow scope.
- [ ] Put the assistant's stable identity and MCP name alongside the existing agent capability constants where callers need them. Derive the acting member from the conversation origin for every operation.

#### I2. Implement the five authorized operations

- [ ] Add shared tool-input schemas for `get_workflow`, `list_tickets`, `get_ticket`, `create_ticket` and `set_field` alongside the existing tool contracts. Reuse normal workflow input fields and native result models wherever they already fit.
- [ ] Implement the operations in the server workflow layer using existing repositories and commands. Reload the active member, workflow visibility and target ticket scope per call; use `startTicket` and `setStepField` for writes so the ordinary rules remain authoritative.
- [ ] Match PR #4's bounded ticket listing and optional title search. Return the saved ticket for successful writes and the existing refusal message for rejected ones. These operations do not grant approval, arbitrary workflow editing or cross-workflow access.

#### I3. Persist write receipts with their effects

- [ ] Add a small durable operation-receipt table keyed by conversation and `requestId`, containing the normalized call and result. Keep it independent of provisional `chat_messages`; provide the necessary read/insert operations in the existing persistence layer.
- [ ] For `create_ticket` and `set_field`, check access, compare a repeated request with its saved call, and apply a new call plus its saved result in one SQL transaction. An identical request reuses the result; a different call under the same ID is refused. Read operations can read current data again.
- [ ] Send the result to the runner after that transaction commits. A lost delivery must not roll back or repeat a successful write; retrying the same request should retrieve the saved result. This does not claim to solve an agent choosing a different request ID when replaying an entire failed input.

#### I4. Return results through a generic file operation

- [ ] Add the injected instance-tool entry under `apps/server/src/agent-tools`, and include it in `apps/server/vite.config.ts`, the MCP presets and built-in tool detection. Run it from `/work/runtime` using the current asset injection.
- [ ] Allow the existing stdio helper to await a tool result. Let the instance tool wait for its reply file under an execution-local directory such as `.t45/replies`, using filesystem notification and an initial read rather than polling. Check the call identity in the response before accepting it.
- [ ] Prototype one generic runner `writeFiles({ rootId, files })` RPC backed by the active execution's existing file writer. Its purpose is to deliver data without also enqueuing a new chat input; current `send` always prompts OpenCode. Keep workflow/request parsing on the server and in the injected tool, not in `ExecutionOrchestrator`.
- [ ] Observe running instance-tool parts from the native messages already returned by executions, apply I2/I3, and write the correlated response file. Completed step-tool receipts retain their existing path.
- [ ] Compose the two consumers at the existing server registration point: workflow-bound conversation calls go to workflow operation handling, and task results go to task handling. Keep one registered execution consumer, reuse the current execution fiber for cancellation, and avoid a second Deferred-based hook-registration cycle. A candidate is exposing task result handling as an ordinary method and composing it in the workflow layer that currently registers `tasks.consume`.
- [ ] Demonstrate the whole request/result path before expanding it: one running `get_workflow` call becomes completed with actual data, and one `create_ticket` retry returns the same saved ticket. Check that the response write does not depend on the next iteration of the stream consumer that is currently awaiting it.

The extra runner operation is a proposal for a missing capability, not a compatibility endpoint. If the prototype needs another command queue, per-call reply registry in the runner or workflow-specific runner state, reconsider it before adoption. The existing active-execution lookup and file writer should be sufficient for the transport.

#### I5. Add authorized chat targets and context

- [ ] Add `chats.listTargets` returning ordinary conversational agents plus accessible workflow targets for the available assistant. Reuse the same workflow-access policy as I2; do not list an unbound assistant as a generic chat target.
- [ ] Supply the workflow identity/name and concise operating instructions to the new conversation, and have the assistant obtain the current definition through `get_workflow`. Keep the authoritative binding in the origin, not in editable prompt text.
- [ ] Recheck workflow access for sends and tool operations, and for workflow-bound chat reads as required by the PR #4 policy. Keep those checks in the server's chat/workflow layer.

#### I6. Wire the existing chat UI

- [ ] Update `useNewChat`, the chat route, `ChatView` and `sendChatMessage` to carry the selected workflow on the first send. Preserve that target when starting another chat from the current one.
- [ ] Use authorized targets in the new-chat menu, show the workflow's name, and add the board's Chat action. If the workflow is unavailable for chat, show that result instead of opening a different agent as a fallback.
- [ ] Reuse the existing native tool rows and error presentation for operation results. Add UI only where the existing rendering cannot communicate the result.

#### I7. Seed and verify the Workflow assistant

- [ ] Add its initial row beside A's designer row, with a stable ID, editable model/instructions, the instance MCP preset and conversational access through workflow targets. Its instructions require current IDs from read tools and success claims only after a confirmed result.
- [ ] Verify an ordinary member flow from a workflow board: read the workflow, find a visible ticket, create a permitted ticket and update a permitted field. Verify a refusal with the ordinary member permissions and a repeat of the same write request ID.
- [ ] Verify that restarting preserves edited starter agents and that the built injected tools run without host `node_modules` or T45 code in the image.

**Done when:** a fresh installation can open the assistant from an accessible workflow and receive confirmed reads/writes, while the runner remains concerned only with executions and files.

### Verification and cleanup for each batch

Use the existing focused suites for affected behavior, update existing expectations where a policy changes, and run `vpr pre-commit` before treating implementation as ready. Exercise the ordinary browser/VM flows listed under each batch against disposable state; do not reset an existing development database to test schema changes. This plan does not authorize adding new tests, restoring removed runner fakes or adding polling-based checks.

Remove the corresponding entries from the parity checklist only after the behavior is delivered or an intentional difference is decided. Rewrite the relevant existing internals documentation for changed access/task/execution rules, keeping implementation todos here. The source of the missing behavior is PR #4, but its old file layout is not the target: use the existing modules where they fit, and preserve the separation between server workflow policy and runner execution.
