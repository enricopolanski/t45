# Prompt: clean up domain boundaries

Clean up the boundaries between `packages/contracts`, `packages/core`, `apps/server`, `apps/web`, and `apps/runner`, implementing the changes rather than stopping at an audit. Read `AGENTS.md`, `docs/operations/styles-and-rules.md`, and `docs/operations/design-principles.md` first, continue on the current branch, and preserve unrelated working-tree and staged changes.

## Design principle

Contracts introduce the application's business concepts and define their pure rules. A business concept is an entity, a meaningful state, a capability, or a rule about what users and agents may do; its meaning survives a change of database, runtime, or UI. Applications load the facts, apply those rules, perform effects, and present the results. Declaring a state's name in a schema is insufficient if its meaning is independently invented by consumers.

Model rules belong in `packages/contracts/src/models`; rules specific to a request or response view can live beside that resource in `packages/contracts/src/resources`. Shared application parsing and formatting can live in `packages/core`, which depends on contracts. Database access, transactions, runtime resources, and UI interaction state remain in their applications. Local types that compose existing concepts do not automatically need promotion into contracts, and OpenCode's native concepts retain their existing definitions in its dependencies.

For example, whether an unfinished step task counts as failed is a domain decision; recording that outcome in SQL is server work. Whether a person can approve a step is a domain decision; opening an approval dialog is UI work. OpenCode read cursors and VM cleanup are runner implementation details.

## Findings to verify and address

Treat these as starting points to verify against the current tree, not instructions to move code blindly. Follow their callers and reuse existing contract rules before introducing new functions.

1. **Task lifecycle:** `packages/contracts/src/models/Task.ts` declares task states and outcomes, but `apps/server/src/tasks/TaskService.ts` defines important semantics in `receive`, `prepareInput`, and `transition`. In particular, a normal execution ending can succeed for a scheduled task while an active step task ending without submission fails. Express the pure outcome and transition decisions in the task model; keep persistence, chat removal, and workflow effects in the server. Preserve the distinction between submitting work, finishing an execution, and settling a task.

2. **Workflow transitions:** `apps/server/src/workflows/WorkflowService.ts` mixes orchestration with rules for completing, approving, rejecting, resuming, and rerunning work. For example, `markStepDone` completes immediately when the actor is the responsible person and otherwise requests approval. Review these decisions alongside the existing rules in `packages/contracts/src/models/Workflow.ts`; consolidate the missing pure rules there without building a generic state machine or returning a new language of commands for the server to interpret. Keep transaction boundaries and side effects in the service.

3. **Automation views:** `WorkflowService.getStep` combines task, chat, and step state into labels and run/stop capabilities; `apps/server/src/automations/AutomationRepository.ts` separately derives the last scheduled run's label. Move pure derivations beside the relevant contract views in `resources/Workflows.ts` and `resources/Automations.ts`, reusing model rules where appropriate. Preserve meaningful differences such as approved step work versus successful scheduled work. An unrestricted `statusLabel` does not define these rules, but fixing ownership does not require inventing another status enum or persisted entity.

4. **Step capabilities:** `apps/web/src/components/work/workLogic.ts` defines `stepActions` by mirroring server checks, while `StepView` does not carry those capabilities. Its calculation lacks the workflow-involvement check enforced by the server. Define the shared decisions in contracts, compute the view using the authenticated actor and current workflow facts, and let `StepPage` consume the resulting capabilities. Commands must still enforce the same rules against current server state. Public visibility must not imply permission to modify work. Include the related editability checks in `StepPage`, rather than leaving a second decision behind under another name.

5. **Field completeness:** `workLogic.missingFields` independently decides what counts as filled, while the workflow model has `fieldsComplete` and `stepCompletionRefusal`. Establish one definition of completeness and derive the missing-field information needed by the UI from it. Keep display formatting in the frontend. Preserve nested and repeatable group behavior and distinguish field completeness from the additional requirement that child steps be complete.

6. **Webhook prompt templates:** `apps/server/src/automations/webhook.ts` defines user-authored placeholders such as `{{body}}` and `{{query.name}}`, while the automation contract only describes a prompt string. Introduce the template's meaning and supported inputs in the automation contract, then place pure rendering according to the contracts/core responsibilities above. Preserve existing substitution, missing-value, and redaction behavior. Keep request reading and cryptographic verification in the server; do not move Node dependencies into shared code or expand the template language.

7. **Runner check:** inspect `ExecutionOrchestrator.ts` and `SandboxManager.ts` for genuine business decisions missing from contracts, but expect most of their local concepts to remain local. Execution requests, updates, and actions already have contracts. Keep OpenCode synchronization and VM lifetime behind the runner API, and keep workflow tools, approvals, and task outcomes out of the runner. Make no runner changes merely to make its implementation types public.

## Implementation constraints

- Prefer existing modules and small functions with concrete callers; remove replaced checks and obsolete helpers as part of each change.
- Aim for fewer independent decisions, smaller application code, and smaller APIs overall; do not create a policy framework, generic transition engine, callback registry, or pass-through service layer.
- Preserve current behavior except for demonstrated inconsistencies between shared rules and their consumers, such as offering actions the server refuses; identify each intentional correction explicitly.
- Preserve authorization, task/execution lifecycle distinctions, receipt deduplication, and transaction ordering; extracting a pure decision must not move an effect outside the transaction that protects it.
- Do not add speculative edge-case handling, retries, compatibility shims, or unrelated cleanup.
- Name functions with verbs and booleans as precise questions; prefer inferred types and reuse canonical domain and OpenCode shapes.
- Do not add new tests; adapt existing tests when necessary and use them to verify the affected behavior.

## Completion and validation

Work through the findings in coherent increments, checking the actual consumers after each extraction. Run the relevant existing tests while iterating and `vp run pre-commit` after implementation. Follow the browser-verification instructions for any user-visible changes, especially step permissions. Report checks that could not run without claiming they passed.

Finish with a concise account of which rules now have one owner, which implementation details deliberately stayed local, any intentional behavior corrections, and the validation performed. Report the change in files, exported APIs, and code size, explaining any growth that was necessary to remove duplicated decisions. Do not commit or push unless separately requested, and leave this planning prompt out of commits.
