# Chat ownership separation review

Review of the proposal to remove `ChatOrigin` after the uncommitted task lifecycle refactor on `task-refactor`. Background: [implemented refactor review](task-lifecycle.refactor.review.md) and [original plan](task-lifecycle.refactor.md). This describes the inspected working tree, including its staged startup change, rather than the committed baseline. No application tests or runtime checks were run for this review.

**Recommendation: remove `ChatOrigin`, with one substantive addition: automations need a durable reference to every unfinished run.** `lastRunChatId` alone cannot replace the current per-chat cleanup flag. Conversation should own member interaction; workflows and automations should own their associations and retention decisions.

The proposal makes Chat independent of its consumers, introduces Conversation for member ownership and optional workflow scope, lets each consumer decide retention, makes question capability explicit at creation, and requires chat creation and its consumer reference to commit together. These boundaries are sound with the qualifications below.

## Inventory and responsibility

The proposed inventory named member access/listing, workflow instructions, question capability, removal after execution, and WorkflowService filtering. The actual inventory is broader.

| Area                                  | Current use and proposed home                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Origin representation and persistence | The union lives in [Chat.ts](../../packages/contracts/src/models/Chat.ts); decoding, lookup and insertion live in [ChatRepository.ts](../../apps/server/src/chats/ChatRepository.ts). Replace these with Conversation and consumer-owned associations.                                                                                                                                                                                                                               |
| Member access and list                | Ownership protects reads, streaming, sending, answering, stopping, renaming and deleting, including against administrators. List queries also compose workflow names. These belong to Conversation and its resource views. Evidence: [ChatService.ts](../../apps/server/src/chats/ChatService.ts), [ChatRepository.ts](../../apps/server/src/chats/ChatRepository.ts).                                                                                                               |
| Agent eligibility and binding         | Missing from the proposed inventory: origin selects conversational-agent versus active-agent eligibility. Creation validates workflow/tool compatibility; target selection offers authorized pairs; subsequent sends preserve the original binding; sends and answers recheck workflow access. Conversation owns conversational eligibility; workflow integration owns scoped eligibility and authorization. Evidence: [ChatService.ts](../../apps/server/src/chats/ChatService.ts). |
| Execution instructions and questions  | Both currently derive from origin in execution preparation. Move workflow context preparation outside ChatExecutions; retain a generic question capability. Evidence: [ChatExecutions.ts](../../apps/server/src/chats/ChatExecutions.ts).                                                                                                                                                                                                                                            |
| Workflow assistant authority          | Missing from the proposed inventory: owner and workflow binding establish the actor and scope of every workflow-instance tool call. This is an authorization relationship, not merely prompt context. Workflows should resolve it through Conversation and the workflow association. Evidence: [WorkflowAssistant.ts](../../apps/server/src/workflows/WorkflowAssistant.ts).                                                                                                         |
| Workflow operation receipts           | Missing from the proposed inventory: receipt lookup/storage and workflow response codecs sit under `ChatRepository.origins`. Move them to workflows, preserving `(chatId, requestId)` identity, argument-conflict detection and atomic operation/receipt writes. Evidence: [ChatRepository.ts](../../apps/server/src/chats/ChatRepository.ts), [WorkflowAssistant.ts](../../apps/server/src/workflows/WorkflowAssistant.ts).                                                         |
| Removal after execution               | Automation starts set `isRemovedWhenEnded` true; step starts set it false. Automation should decide removal on completion; Chat should continue performing disposal. Evidence: [AutomationService.ts](../../apps/server/src/automations/AutomationService.ts), [ChatService.ts](../../apps/server/src/chats/ChatService.ts).                                                                                                                                                         |
| Workflow run processing               | The origin guard applies to **ended events and chat-change forwarding**. Tool processing already finds the Ticket through its run association and checks writable scope. Remove the two guards and use that association consistently. Evidence: [WorkflowService.ts](../../apps/server/src/workflows/WorkflowService.ts).                                                                                                                                                            |
| Step tool ledger                      | Already workflow-owned through TicketRepository. `step_tool_calls` references `chats`, not `chat_origins`. Preserve it: even ignored calls are recorded so rejection cannot later replay them. Evidence: [TicketRepository.ts](../../apps/server/src/workflows/TicketRepository.ts), [WorkflowService.ts](../../apps/server/src/workflows/WorkflowService.ts).                                                                                                                       |

In [Schema.ts](../../apps/server/src/persistence/Schema.ts), **`workflow_operation_receipts` is the only remaining table referencing `chat_origins`**. Repoint it to the durable chat identity when moving its repository. Automation's latest-run pointer, step-tool ledger, sessions, inputs and attachment holds already reference `chats`. The origin's `workflow_id` deliberately has no workflow foreign key, preserving scope after workflow deletion.

### Attachments

Attachments contain a related distinction, but **do not read origin**. `AttachmentRepository.bindToChat` uses `from: userId | null`:

- Files already held by that chat can be reused.
- New member bindings require that member's unheld, non-step upload.
- `from === null` permits step-held files, including sharing between chats.
- Duplicate IDs, missing files and size mismatches refuse.

Keep attachment integrity and hold/release rules in attachments; keep member-upload authority and workflow-file selection with their callers. Absence of a Conversation must not become attachment authority. Attachment downloads separately allow ticket-authorized access to step files, without granting transcript access. Evidence: [AttachmentRepository.ts](../../apps/server/src/attachments/AttachmentRepository.ts), [attachment HTTP routes](../../apps/server/src/attachments/http.ts).

### Contracts and web

The web consumes ownership indirectly through these resources and views:

- Binding, targets and summaries: [resources/Chats.ts](../../packages/contracts/src/resources/Chats.ts), [AgentChatsPage.tsx](../../apps/web/src/components/chats/AgentChatsPage.tsx), [ChatView.tsx](../../apps/web/src/components/ChatView.tsx), [useNewChat.ts](../../apps/web/src/hooks/useNewChat.ts), [sendChatMessage.ts](../../apps/web/src/components/chat/sendChatMessage.ts), [chat route](../../apps/web/src/routes/chats.$chatId.tsx), and [WorkflowBoardPage.tsx](../../apps/web/src/components/workflows/WorkflowBoardPage.tsx).
- Step runs: [StepView and buildStepAutomationViews](../../packages/contracts/src/resources/Workflows.ts) omit `automationRuns` from the member-facing step and expose status/actions; [StepPage.tsx](../../apps/web/src/components/work/StepPage.tsx) shows status/run/stop. The adjusted [workLogic.ts](../../apps/web/src/components/work/workLogic.ts) consumes the view's step type.
- Automation runs: [Automation](../../packages/contracts/src/models/Automation.ts) references its latest chat; [AutomationSummary](../../packages/contracts/src/resources/Automations.ts) exposes that ID, but [AutomationsSettings.tsx](../../apps/web/src/components/settings/AutomationsSettings.tsx) displays only status/time. [Automations.handlers.ts](../../apps/server/src/automations/Automations.handlers.ts) composes that summary from automation and chat facts.

**Neither run UI opens a run chat.** Both run commands return void. There are no web consumers of `automationRuns` or `lastRunChatId`; chat navigation comes from the personal list, a new conversation or the current chat/subagent. Workflow assistant `get_ticket` does expose run IDs through the full Ticket, but those IDs confer no access.

### Tests and fixtures

Direct origin consumers are [Chats.testkit.ts](../../apps/server/src/chats/Chats.testkit.ts) and [AutomationService.test.ts](../../apps/server/src/automations/AutomationService.test.ts). The latter reads origin kind and directly joins `chat_origins` using null ownership.

Ownership/task fixtures and assertions also occur in [ChatService.test.ts](../../apps/server/src/chats/ChatService.test.ts), [Chats.handlers.test.ts](../../apps/server/src/chats/Chats.handlers.test.ts), [ChatExecutions.test.ts](../../apps/server/src/chats/ChatExecutions.test.ts), [AttachmentRepository.test.ts](../../apps/server/src/attachments/AttachmentRepository.test.ts), and [attachment http.test.ts](../../apps/server/src/attachments/http.test.ts).

Indirect setup/view dependencies include [Attachments.testkit.ts](../../apps/server/src/attachments/Attachments.testkit.ts), [webhook.test.ts](../../apps/server/src/automations/webhook.test.ts), contracts' [domain.test.ts](../../packages/contracts/src/domain.test.ts), [Automation.test.ts](../../packages/contracts/src/models/Automation.test.ts), [Workflow.test.ts](../../packages/contracts/src/models/Workflow.test.ts), [Workflows.test.ts](../../packages/contracts/src/resources/Workflows.test.ts), and web's [chats.testkit.ts](../../apps/web/src/state/chats.testkit.ts) and [useNewChat.test.ts](../../apps/web/src/hooks/useNewChat.test.ts). No contracts tests directly read `ChatOrigin`.

## Conversation and workflow scope

Conversation should be a separate aggregate in a contracts Conversation model and a server `conversations` module, referencing User and Chat. It should not be nested inside User, Ticket or Workflow.

Prefer a **workflow-owned association between Conversation and Workflow** over `Conversation.workflowId`. The distinction already has behavioral significance: private history survives workflow access loss or deletion, while new input and workflow commands require current authority. Preserve the historical workflow ID; deleting its workflow must not silently turn the conversation into an unbound one. This association needs no independent identity or additional aggregate. Evidence: [WorkflowAssistant.ts](../../apps/server/src/workflows/WorkflowAssistant.ts), [Schema.ts](../../apps/server/src/persistence/Schema.ts).

An optional workflow reference on Conversation is defensible, but the separate association gives workflow-specific authorization, assistant selection and context preparation one owner.

## Execution preparation and questions

Supply workflow instructions for **each execution**. Application composition should supply execution preparation that resolves the current association and asks workflow integration to produce additional instructions. ChatExecutions receives generic prepared instructions, without querying workflows.

Persist the association, rather than a rendered workflow instruction. A creation-only instruction would change today's behavior: preparation currently rereads the workflow for each execution. An ephemeral start callback also cannot support recovered executions.

Removing the workflow lookup alone is insufficient to make ChatExecutions workflow-independent: its MCP-name gate for bundled tool assets must also move to integration preparation. Evidence: [ChatExecutions.ts](../../apps/server/src/chats/ChatExecutions.ts).

Questions are an execution capability whose policy belongs to the caller. A durable chat execution setting is reasonable because continuations and recovery must reproduce it. Conversation creation enables it; current unattended callers disable it. It should not independently grant permission to answer.

Today the runner installs an explicit `question` permission denial for unattended executions. T45 has no fallback routing to the step's responsible person. A question written as ordinary prose is just output; if a writable step run then ends without submission, the workflow records failure. Evidence: [ExecutionOrchestrator.ts](../../apps/runner/src/ExecutionOrchestrator.ts), [endAutomationRun](../../packages/contracts/src/models/Workflow.ts).

## Retention and execution completion

Automation cleanup needs more than the latest pointer. Scheduled, Run now and webhook paths can start a fresh run while another remains active. Every accepted start overwrites `lastRunChatId`. Consequently, the older execution's eventual `ended` event cannot be attributed using that pointer. This is supported existing behavior, not a speculative race. Evidence: [AutomationService.ts](../../apps/server/src/automations/AutomationService.ts).

Add automation-owned `AutomationRun { automationId, chatId }` associations for runs awaiting disposal. Keep `lastRunChatId` for the current summary. Permanent run history is unnecessary.

Application startup should register **one composed execution receiver**, invoking workflow and automation handlers. Do not register a second receiver against the existing Deferred or use the lossy UI change feed for authoritative cleanup. Completion currently updates runtime status and awaits the receiver within one transaction; preserve that ordering before unblocking recovered work. Evidence: [ChatExecutions.ts](../../apps/server/src/chats/ChatExecutions.ts), [WorkflowService.ts](../../apps/server/src/workflows/WorkflowService.ts), [bin.ts](../../apps/server/src/bin.ts).

Automation removes its run chat on normal or failed completion. Workflow retains submitted chats for rejection/resumption and removes them according to its existing completion, failure and cancellation rules. Blocking/stopping retains context for continuation. Chat owns the mechanics: stopping execution, releasing holds, deleting transcript/disk and retaining a tombstone. That tombstone still supplies automation's latest status. Evidence: [ChatService.ts](../../apps/server/src/chats/ChatService.ts), [ChatRepository.ts](../../apps/server/src/chats/ChatRepository.ts), [Automations.handlers.ts](../../apps/server/src/automations/Automations.handlers.ts).

## Authorization

Conversation-only member access preserves current behavior. For reading a live transcript, “this member owns its Conversation” is sufficient today. Bound input, answers and workflow commands additionally require current workflow access. Stop, delete and private-history access should retain their existing distinctions.

There is no existing step-run transcript access path to preserve. Tests explicitly deny task chats to members and administrators. Workflow tools expose run IDs inside Tickets, but possession of an ID grants no access. Ticket authorization does grant access to step files. Evidence: [Chats.handlers.test.ts](../../apps/server/src/chats/Chats.handlers.test.ts), [WorkflowAssistant.ts](../../apps/server/src/workflows/WorkflowAssistant.ts), [attachment HTTP routes](../../apps/server/src/attachments/http.ts).

## Atomic creation and reachability

Creation is already transactional in production paths:

- Member send saves chat, origin and first input together.
- Workflow creation saves chat and `Step.automationRuns` together through the enclosing ticket transaction.
- Scheduled, manual and webhook automation starts save chat and latest pointer together; scheduled advancement shares that transaction.
- Execution delivery happens after commit.

Evidence: [ChatService.ts](../../apps/server/src/chats/ChatService.ts), [WorkflowService.ts](../../apps/server/src/workflows/WorkflowService.ts), [AutomationService.ts](../../apps/server/src/automations/AutomationService.ts), [AutomationRepository.ts](../../apps/server/src/automations/AutomationRepository.ts).

No production creation path was found missing its initial consumer reference. The standalone internal `startTask` API does permit that, and tests use it independently. The substantive gap is **retaining** ownership after automation's latest pointer changes. The proposed invariant should cover every live or retained chat; intentionally retained ID tombstones need not remain in a user-facing collection.

## Strongest case for retaining ownership on Chat

The strongest case is a durable, central authority. One record currently coordinates private access, interactive execution and cleanup even after an automation overwrites its latest reference. Removing it distributes responsibilities and makes transaction boundaries and startup wiring more consequential.

That argument survives as a requirement for explicit lifecycle ownership and durable associations. It does not justify the origin union: that union combines member identity, workflow authority and retention while still failing to identify the automation responsible for a run.

## Recommended entity model

| Entity or association                  | References                                                           | Rule owner                                                                     |
| -------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Chat                                   | Agent; owns inputs, transcript, runtime state and execution settings | Chats: execution, recovery, deduplication and disposal mechanics               |
| Conversation aggregate                 | User, unique Chat                                                    | Conversations: personal access, list, member interaction and deletion decision |
| Workflow-conversation association      | Conversation, historical workflow ID                                 | Workflows: scope, current authority, assistant eligibility and context         |
| Ticket aggregate / step runs           | Run chats                                                            | Workflows: contribution state, writable scope, continuation and retention      |
| Automation aggregate / unfinished runs | Every unfinished run chat; latest chat separately                    | Automations: activation, scheduling, run attribution and disposal decision     |
| Attachments and workflow receipts      | Their existing chat/step identities                                  | Attachments: holds and integrity; workflows: operation deduplication           |

Each live chat has one lifecycle-owning consumer. Merely referencing a chat—for example in a summary—does not confer deletion authority.

Remove the origin model/table/index/check, origin repository API, chat-side retention flag/hook, origin-kind guards and workflow-specific execution preparation. Add Conversation, the workflow association, unfinished automation-run associations, durable question configuration and application-level receiver/preparation wiring. Move member operations and workflow receipts to their owners. Edit `Schema.ts` in place, without migrations or compatibility code.

The real risks are losing older automation runs, weakening workflow authority into prompt-only scope, dropping receipts or the step ledger, deleting submitted contexts needed for rejection, losing configuration during recovery, and breaking latest-run summaries by hard-deleting tombstones. Keep the governing rules and invariant tests in contracts models/resources; use frontend E2Es for observable authorization and interaction behavior. No new server tests are warranted.
