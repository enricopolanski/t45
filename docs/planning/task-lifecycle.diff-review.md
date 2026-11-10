# Task lifecycle diff review

Reviewed on 2026-11-08 against `1e659512337f9a4aa27c5b6882e1fdd1e8e70f61`. This covers the complete 32-file staged diff, including its tests and experiment report. The captured binary patch has SHA-256 `aba00d61b35b06e8ea91153ace27376a7124510995d876b7357fc9e63077e140`. I read the operating rules, started with the changed models, and traced their consumers, persistence, transactions, execution callbacks, and views. Tests ran in a detached worktree containing that exact patch; all 30 non-deleted reviewed files were compared byte for byte with the shared checkout afterward.

## Verdict

Keep the direction. Removing the workflow-shaped task model and `TaskService` is a real improvement: submission, cancellation, readiness, and the association with a step now belong to workflows. The change reduces production code by 61 lines and removes a service layer rather than replacing it with another one.

I found one reproducible performance regression: resolving a task chat to its workflow now scans every ticket's JSON run history, including closed tickets. I would address that before merging. I did not reproduce a functional regression in the exercised paths. That conclusion covers the checks below, not real LLM execution or every possible interleaving.

The architectural improvement is partial. Generic chat execution still depends on workflow repositories and on receiver registration by `WorkflowService`. The new experiment report acknowledges those dependencies later, but its unconditional claim that no chat code knows about workflows is inaccurate. Several further simplifications are available without introducing a framework or changing the MCP protocol in this slice.

## 1. Confirmed regression: historical tickets enter the execution hot path

**Priority: P2.** [TicketRepository.ts:86](../../apps/server/src/workflows/TicketRepository.ts#L86) adds `getByAutomationRunChatId`, implemented as a correlated `json_each` search through `tickets.steps[*].automationRuns[*]`. It has neither a ticket-status filter nor an indexed lookup by chat ID.

This is called for execution completion in [WorkflowService.ts:1366](../../apps/server/src/workflows/WorkflowService.ts#L1366), completed step-tool messages at line 1385, and forwarded chat changes at line 1488. The latter two task-status paths also search for global automation chats that have no workflow association. A completed tool part can recur in later versions of an assistant message, so the tool-message path performs this search before discovering that every call was already recorded.

Previously, `TaskService` identified the producer through a primary-key lookup of `chat_origins`; global automation tasks did not search tickets. For workflow work, ticket reads used the stored ticket ID. Moving the association to its proper owner should preserve an efficient way to resolve it.

### Executed reproduction

The disposable check used the actual `TicketRepository`, SQLite layer, and current schema. It inserted 5,000 closed tickets, each with five steps and ten runs per step: 250,000 historical run records. It then averaged ten lookups for a chat absent from all those runs, as happens for a global automation chat.

| Condition                                                                    | Average per lookup |
| ---------------------------------------------------------------------------- | -----------------: |
| One live test ticket, before adding history                                  |           0.026 ms |
| Current repository query with the closed history                             |          128.35 ms |
| Experimental query restricted to open tickets, with a matching partial index |           0.015 ms |

`EXPLAIN QUERY PLAN` confirmed `SCAN t`, followed by a correlated subquery and scans of both JSON virtual tables. This is a synthetic history benchmark, not a production latency measurement. It establishes that unrelated closed history adds substantial work to routine execution processing. It does not establish an exact delay for every event or a production throughput limit.

### Smallest useful correction

All three current callers can disregard closed tickets: their mutations require an open ticket, and completed/cancelled run labels no longer depend on later chat status changes. Restrict this lookup accordingly and support that restriction with an index. Keep resolving the association on the workflow side. The benchmark exercised that query/index approach without changing the production implementation.

Also check recorded tool-call keys before loading the ticket, and return immediately when none are pending. That avoids repeating the workflow lookup and transaction for already-consumed tool parts. Preserve recording of newly dropped calls on a still-reusable context; those must not become eligible when a submission is later rejected.

A workflow-owned indexed run relation is another option if searches among open tickets become expensive. It is not necessary to introduce it merely to fix the measured closed-history case. Do not put the workflow trigger back on chats, add a second in-memory association owner, or introduce a generic event registry.

## 2. The attachment improvement has a narrower guarantee

**Classification: inherited implementation limitation and an inaccurate new report claim, not a newly introduced functional regression.** [The experiment report](./task-lifecycle.refactor.review.md#behavior-changes) says a non-writable run leaves no orphan attachment. The new guard does prevent storage when the run is already non-writable at the start of preparation. That case passed.

However, [WorkflowService.ts:1387](../../apps/server/src/workflows/WorkflowService.ts#L1387) captures writability once and prepares all attachments before applying the batch. A batch containing `step_submit_task` followed by `step_attach` therefore stores the attachment while the initial snapshot is writable. Submission then closes writes, and the attachment call is skipped at line 1418. The stored upload remains unclaimed.

The disposable reproduction emitted exported bytes and one native assistant message containing those two completed calls in order. It left exactly one attachment row with `step_id IS NULL`. By comparison, sending the attachment in a later message after submission left zero rows. A valid attach before submission was claimed by the step and remained available after approval.

The old `TaskService.saved` and workflow preparation hook also prepared attachments before applying calls, so this batch behavior predates the diff. The upload is eligible for the existing sweep after 24 hours; this is not evidence of a permanent storage leak. Narrow the report's claim. If cleanup is addressed here, release prepared uploads that are not claimed, accounting for duplicate-call and scope-change races as well as submission within a batch. No new MCP transport is required to state or correct this guarantee.

## 3. Boundary assessment against the operating rules

| Area                     | Assessment                                                                                                                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start from models        | The fundamental leak is removed: no task trigger carries a step, ticket, or global automation ID, and `Task.ts` is deleted.                                                                                                                                             |
| Give decisions one owner | Step contribution state and eligibility are workflow-owned. Global automation activation and last-start recording are automation-owned. Execution status remains on chats.                                                                                              |
| Pure rules in contracts  | Readiness, run planning, write scope, run transitions, due activation, and labels now have reusable pure functions. The new tests exercise meaningful combinations of facts rather than dependency behavior.                                                            |
| Resource views           | `buildStepAutomationViews` derives labels and run/stop offers together. `StepView` excludes run history from its step payload; the frontend type adjustment is consistent with that projection.                                                                         |
| Persistence boundaries   | `AutomationRepository` no longer derives workflow-shaped task outcomes. Handlers compose repository results without SQL. The step-call ledger belongs to `TicketRepository`. The new reverse lookup needs the correction above.                                         |
| Transactions             | Starts remain inside the caller's transaction, with execution delivery after commit. Submission/readiness and call deduplication still commit together. A forced ticket-save failure rolled back the newly created chat and ticket without launching another execution. |
| Clean database baseline  | The schema is changed in place, without migrations or compatibility branches. The fingerprint changes as required. Existing development databases need to be moved aside; they must not be silently upgraded or deleted.                                                |
| Runtime isolation        | Not achieved. Chat creation and execution still require workflow dependencies, and execution waits for a receiver registered by `WorkflowService`. These are inherited dependencies, not reasons to reject the narrower model cleanup.                                  |
| Scope and infrastructure | No package dependency, installation prerequisite, runner transport, or build-task dependency changes. No new build ordering or setup problem was found in this diff. Fresh-machine setup was not revalidated.                                                           |

The remaining dependencies are concrete: [ChatService.ts:149](../../apps/server/src/chats/ChatService.ts#L149) obtains workflow, definition, and ticket repositories; [ChatExecutions.ts:71](../../apps/server/src/chats/ChatExecutions.ts#L71) obtains `WorkflowRepository`, builds workflow instructions, and recognizes built-in workflow MCP names; [ChatExecutions.ts:265](../../apps/server/src/chats/ChatExecutions.ts#L265) waits on its receiver; [WorkflowService.ts:1477](../../apps/server/src/workflows/WorkflowService.ts#L1477) supplies that receiver. Deleting `TaskService` does not by itself make unattended execution usable without workflow wiring.

The ownership of the new workflow run state is appropriate. A normal execution ending without a submission can remain a workflow failure without becoming a failure state understood by the generic execution engine. Likewise, workflow approval need not become another persisted chat outcome. That distinction is preserved.

## 4. Code surface and further simplification

### Measured surface

| Area      | Production lines | Test/support lines |
| --------- | ---------------: | -----------------: |
| Contracts |             +173 |               +348 |
| Server    |             −234 |               −101 |
| Web       |                0 |                  0 |
| Total     |          **−61** |           **+247** |

These are added-minus-removed source lines against the captured baseline, excluding documentation and disposable review files. Production has 606 added and 667 removed lines. Two production files disappear: `Task.ts` and `TaskService.ts`. `WorkflowService.ts` only shrinks from 1,558 to 1,555 lines because it absorbs the completed-tool consumer and orchestration that were in the removed service.

The contract runtime export count grows by 13: twenty declarations added and seven removed, counting exported values/classes/functions and excluding type-only exports and tests. That is not inherently wrong—shared domain rules need an API—but the refactor reduces server layers more than it reduces the number of operations a maintainer must understand. The new pure functions improve ownership; their number alone does not prove a deep module.

### Concrete follow-ups, in order

1. **Bound the workflow lookup and skip already-consumed batches.** This fixes the measured regression using the existing repository and ledger. It should precede cosmetic line reduction.
2. **Keep approved-run closure inside the workflow model.** `completeTicketStep` leaves approved runs as `submitted`; `cancelTicket` must therefore know to skip completed steps at [WorkflowService.ts:858](../../apps/server/src/workflows/WorkflowService.ts#L858). The combination of step status and run state is a domain rule. Let the relevant model operation preserve approved work so callers do not independently maintain that exception. This does not require another persisted `approved` state.
3. **Make the execution-end operation complete its domain decision.** `endAutomationRun` currently finds a run and supplies a reason; the server then calls `failAutomationRun` separately through `failEntryRun`. Either name it as a query or let it return the changed domain value together with the reason. Prefer an operation that owns the complete transition over a chain of small public helpers callers must order correctly. Do not replace them with a generic dispatcher or a language of effect commands.
4. **Make saving the aggregate an explicit responsibility.** `startWork` now saves, while `startTicket`, definition reconciliation, unblock, and surrounding operations also save. `markStepDone` cancels working runs before calling a completion operation that also handles working-run cancellation. The tests found these paths correct, but the extra flushes and split responsibilities make them harder to follow. Consolidate redundant writes/cancellation where the enclosing transaction can save the final aggregate once. Preserve after-commit delivery and atomic refusal handling.
5. **Fetch only the chat facts the view uses.** `getStep` reads chat statuses for every historical run, although the view displays only the latest per configured entry. Use the existing latest-run rule to select those IDs before the repository query. Keep history required by run-planning behavior; removing older failure records would currently change the rule that only-cancelled history can restart automatically.

Keep the completed-part consumer local to workflows for this slice. Extracting another service for its approximately hundred lines would move the coordination rather than remove it. Request/response tools can be evaluated separately if actual responses justify the protocol work.

## 5. Corrections to the experiment report

The report should describe model-level decoupling rather than claim complete runtime independence. Its deferred-leak list already contains the evidence needed to make that distinction.

The forecast that request/response step tools remove the ledger is also incomplete. They can remove the completed-part application mechanism, but lost replies and retried mutations still require durable deduplication unless another mechanism provides the same guarantee. [WorkflowAssistant.ts:103](../../apps/server/src/workflows/WorkflowAssistant.ts#L103) already demonstrates request/response operations with stored receipts. Replacing one ledger with another is not a net deletion that can be assumed in advance.

The report also says the cleanup prompt's no-new-tests constraint was an inaccuracy. [The source cleanup document](./boundaries-cleanup.md#implementation-constraints) explicitly contains “Do not add new tests.” The general rule to test business logic in models does not itself require adding a new test file or cancel that task-specific constraint. Record any separately authorized scope change instead of claiming the constraint did not exist. This review's additional checks are disposable and have not been added to the shared source tree.

The reported loss of failure detail in global automation labels and cancellation reasons is intentional and documented, not an undisclosed regression. Likewise, continuing to answer step tools optimistically and treating a later refusal as a failed contribution is inherited behavior; this diff does not make MCP replies authoritative.

## 6. Executed verification

The review worktree is `/tmp/t45-diff-review.rIrKHj/checkout`. Dependency preparation reused the existing pnpm store and installed runtime assets. This was not a clean-machine installation test.

| Check                                                           | Result                                                                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `vp check`                                                      | Formatting and lint passed.                                                                                                                 |
| `vp run --no-cache typecheck`                                   | All eight workspace typechecks passed.                                                                                                      |
| `vp run --no-cache knip`                                        | Passed.                                                                                                                                     |
| `vp run --no-cache --filter @t45/contracts test`                | 30 tests passed.                                                                                                                            |
| `vp run --no-cache --filter t45 test`                           | Fresh server/MCP bundle built; 130 tests passed.                                                                                            |
| `vp run --no-cache --filter @t45/web test`                      | 410 tests passed.                                                                                                                           |
| `vp run --no-cache --filter @t3tools/oxlint-plugin-t3code test` | 82 tests passed.                                                                                                                            |
| Existing Playwright application-load spec                       | One test passed against this worktree's app.                                                                                                |
| Disposable lifecycle review                                     | Fourteen checks passed: twelve behavior/atomicity checks, one reproduction of the inherited unclaimed-upload case, and one query benchmark. |
| Patch integrity                                                 | Shared and isolated reviewed files matched; diff whitespace check passed.                                                                   |

The first server-suite run hit sandbox `EPERM` restrictions in existing child-process tests. Repeating the suite with child-process support passed all 130 tests. Those initial failures were environmental, not evidence of application regressions.

The disposable lifecycle checks used the existing SQLite implementation and fake runner contract. They waited for chat events, taken inputs, runner completion, or committed repository state; no sleeps or polling were used. They exercised:

- Two independent contributions, submission, saved-disk continuation after rejection, and approval removing the execution chats.
- A normal end without submission producing a workflow failure/comment and removing the chat.
- Block/unblock retaining a context, and Run again creating a new context.
- Ticket cancellation/reopening with fresh contexts, while approved historical work remains completed through later definition changes.
- A shared definition gaining a required field while awaiting approval, returning its submitted context to work and then becoming ready again.
- Completed-call deduplication and ignored writes after submission.
- A disabled global automation's Run now, last-run association, successful/failed completion, and chat cleanup with status retained on the tombstone.
- Valid exported attachment storage/claiming, no storage when already non-writable, and the remaining same-batch unclaimed upload.
- A forced database failure during new-ticket saving, leaving neither a new ticket nor a new chat or launched execution.
- Changing one automation entry cancelling only that entry, with a fresh replacement context.

The smoke check used the drive-browser guidance and pinned repository Playwright. The reviewed server ran on port 13774 with disposable state; the reviewed Vite development web server ran on 5734 because 5733 was occupied. A temporary Playwright configuration changed only the base URL and artifact destination; the spec and fixtures were unchanged. The runner URL was a non-serving local endpoint: this smoke check did not invoke an agent. It tested this diff's app, not the app running from the main checkout. Both review servers were stopped afterward; the shared development processes were left alone.

The literal root `pre-commit` command was not run as one invocation, since its development-server prerequisite is fixed to port 5733. Its checks were run individually as recorded above. No real microVM/LLM execution, fresh-system dependency installation, or exhaustive concurrency exploration was performed. The committed browser suite remains a smoke check; it does not provide permanent workflow lifecycle integration coverage.

Disposable test source, logs, and benchmark data remain under `/tmp/t45-diff-review.rIrKHj/`. To rerun the lifecycle probe, copy `TaskLifecycle.review.test.ts` from that directory into the isolated worktree's `apps/server/src/workflows/`, then run `vp test run src/workflows/TaskLifecycle.review.test.ts` from `apps/server`. Keep it outside the shared checkout and out of commits. No application code, existing documentation, staged changes, or test files in the shared checkout were modified by this review; this report is its only addition.
