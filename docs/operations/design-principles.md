# Design principles

These principles describe the intended design; the current implementation may violate them. Read the code to understand its behavior, then assess its responsibilities and dependencies against the principles. Existing structure is not a reason to preserve a boundary that puts knowledge with the wrong owner.

## 1. Make modules deep

A deep module, in Ousterhout’s sense, hides substantial complexity behind a small, useful API. Callers describe their intent without assembling the implementation themselves. Judge depth by how many concepts and ordering rules callers can forget.

A larger implementation file can be a good trade when it removes that burden from every caller.

**Example: starting an agent execution.**

- **Bad:** the server ensures a VM exists, restores its workspace, connects to OpenCode, waits for readiness, subscribes to events, saves the workspace, and removes the VM, coordinating cleanup when any step fails.
- **Good:** the server consumes `runner.execute(request)` and sends actions through `send`, `answer`, `dismiss`, and `cancel`; the execution implementation owns readiness, synchronization, and scoped cleanup.

## 2. Keep knowledge behind its boundary

A module boundary separates the capabilities and guarantees other code may rely on from the implementation decisions the module keeps private. A boundary leaks when using a module requires knowing or coordinating those internal decisions. Choose boundaries that let each side change its implementation without forcing unrelated changes on the other.

**Example: transporting files between the runner and the server.** The runner owns sandbox execution and file transport; the server owns what those files mean to a workflow.

- **Bad:** the runner recognizes `step_attach` and decides which workflow field receives a file.
- **Good:** sandboxed agents can produce files through a shared convention, the runner transports those files, and the workflow MCP integration decides which workflow fields or attachments receive them.

Adding a workflow tool should therefore leave the runner and generic task code unchanged. Sharing a data type can still be part of the contract: T45 imports OpenCode's canonical shapes while keeping its protocol and lifecycle mechanics in the runner.

## 3. Give each decision and state one owner

Ownership means one place defines a decision or controls a piece of state and its transitions. Other modules request changes or consume the result. Keep related rules with that owner so different consumers cannot independently interpret the same facts and disagree.

**Example: deciding an automation’s status and available actions.**

- **Bad:** `StepPage` combines task state, chat status, and step status to infer “Paused” or “Failed,” while the server separately decides which actions are available.
- **Good:** the server derives the automation’s status and available actions together, and the UI displays that view.

For executions, the runner owns OpenCode synchronization and its read cursors; `ChatExecutions` owns what T45 persists. Both handle execution updates, but each owns a different decision.

## 4. Remove coordination, not just lines

Coordination is the agreement pieces of code must maintain about call order, shared state, and resource lifetimes. A separation earns its place when it hides more complexity than this agreement introduces. Simplification removes concepts, duplicated rules, or coordination while preserving required behavior; moving the same machinery elsewhere does not achieve that.

**Example: synchronizing OpenCode output during an execution.**

- **Bad:** a separate `Capture` exposes `observe`, `marked`, `all`, and `idle`, leaving the orchestrator to know when to call each and how they interact.
- **Good:** keep that synchronization inside `ExecutionOrchestrator`, with private helpers where they clarify the algorithm, and expose execution operations to callers.

Here, renaming handlers to commands or moving locks into another map preserves the burden. Using the SDK’s event stream and Effect’s resource scopes can remove machinery we otherwise maintain ourselves.

The execution must still wait for tools before starting a turn and deliver files before messages reference them. Automatically restarting a failed execution offers no equivalent guarantee when external tool effects cannot be rolled back.

## 5. Name functions for their actions

Every function name should start with a verb describing its action and identify its object precisely enough to understand the call. Choose the verb from the behavior; mechanically adding `get` or `handle` leaves the reader guessing.

**Examples: workflow helpers.**

| Bad function name | Better name                    | What the name tells us                   |
| ----------------- | ------------------------------ | ---------------------------------------- |
| `brief`           | `buildTaskInput`               | Assembles the task’s input.              |
| `fieldTrees`      | `buildCurrentStepFieldViews`   | Builds field views for the current step. |
| `carriedFields`   | `buildPreviousStepsFieldViews` | Builds field views from earlier steps.   |
| `taskContext`     | `formatTaskContext`            | Formats context for a prompt.            |

Names of data and entities remain nouns: `taskInput` can hold the result of `buildTaskInput`, and a module such as `ExecutionOrchestrator` names its responsibility.

## 6. Name booleans as questions

Every boolean variable and predicate should answer a specific yes-or-no question, using verbs such as `is`, `has`, `can`, or `should`. Make clear whether it describes current state, capability, or an action that needs doing.

**Examples: configuration and synchronization flags.**

| Bad boolean name | Better name             | Question answered                     |
| ---------------- | ----------------------- | ------------------------------------- |
| `conversational` | `isConversational`      | Is this agent conversational?         |
| `files`          | `hasFiles`              | Are any files present?                |
| `tree`           | `shouldReadSessionList` | Does the session list need rereading? |
| `forms`          | `shouldReadQuestions`   | Do the questions need rereading?      |

`isRunning`, `canRun`, and `shouldRun` describe different facts; choose the one the value actually establishes, and keep a collection named `files` distinct from the boolean `hasFiles`.
