# Styles and rules

These rules apply when writing or reviewing T45 code and follow our [design principles](./design-principles.md).

## Applying the rules

Start code investigations with the relevant models in `packages/contracts/src/models`: read their data types, states, relationships, and business rules before tracing services, repositories, tools, or UI. Check which concepts each model is made to know about and whether it should own them. A field, union variant, or state can introduce a boundary leak before any service dependency makes it visible.

Treat the current code as evidence of existing behavior, not proof that its design follows these rules. Existing names, schemas, dependencies, and passing tests can preserve a mistaken boundary. Evaluate the implementation against the principles before extending or extracting it.

Identify which domain concept owns a decision before choosing its module or API. A rule being pure does not make it a rule of the model that currently carries its data. Keep a consumer's requirements with that consumer; promoting them into a shared contract can strengthen the coupling being removed.

Distinguish required product behavior and guarantees from implementation choices. Preserve authorization, atomicity, and deduplication while correcting misplaced responsibilities. Describe intentional behavior changes explicitly; preserving behavior does not require preserving the current dependency graph, state representation, or API.

## Stay within agreed scope

Do not add behaviors, edge cases, acceptance scenarios, or supporting infrastructure that have not been agreed and included in the plan. A plausible concern is not a requirement. Apply this rule when planning, implementing, reviewing, and writing tests. Make routine implementation choices within the agreed scope; if a discovered issue requires additional product behavior or guarantees, explain the concrete need and agree the scope change before adding it.

For example, a request to preserve automation transcripts, skip notifications when there is no assignee, and notify on manual stop does not authorize a streaming-history archive, crash-recovery redesign, new transcript UI, reassignment policies, or notifications for additional cancellation paths. Avoid expanding those three requirements into an elaborate scenario suite and new test infrastructure. Plan and verify the requested behavior without inventing additional obligations.

## Merging pull requests

Squash pull requests into one commit on the target branch by default; use another merge strategy only when explicitly requested.

## Merging pull requests

Squash pull requests into one commit on the target branch by default; use another merge strategy only when explicitly requested.

## Architecture

Models in `packages/contracts/src/models` describe application entities such as users and agents, and represent data as it makes sense to the domain; they do not bend to make storage or transport easier.

Resources in `packages/contracts/src/resources` define endpoint capabilities: accepted payloads, responses, and errors. A response can combine several models into a view: an `Automation` may carry only `agentId`, while an `AutomationView` includes the agent's name and tools.

Keep pure business rules in models, or resources when the rule belongs to a view or payload, so every consumer uses the same rule. For example, whether removing an admin would leave an organization without one belongs in the model. Keeping these rules independent of storage, transport, and UI makes them testable; duplicating a constraint in the database is an accepted cost.

`packages/core` holds pure application behavior shared by web and server, such as parsing and formatting message references. Model invariants stay in contracts. Core depends on contracts; contracts never depend on core. UI behavior stays in web, and provider-specific formatting stays in server.

Keep OpenCode integration complexity at its boundary: the runner's `ExecutionOrchestrator.ts` controls how an execution happens, and the server's `ChatExecutions.ts` decides what T45 keeps. Store and send OpenCode's own shapes, imported from `@opencode/*`; do not declare them again. The UI displays domain decisions supplied by the server.

Automations execute in chats; their origin is a separate join. Workflow MCP tools apply workflow operations and return their actual results. Execution ending does not complete a step: the workflow owns step completion. Retain automation transcripts when execution ends or is stopped.

## Persistence and transactions

Handlers (`*.handlers.ts`) read and write through repositories or services; they never import `SqlClient` or write queries. Changes to storage should not reach the code that serves requests.

A repository owns the queries, atomic writes, and collection constraints for its entity, such as a name no other row may have. Its methods take and return models. Use one repository per entity, such as `apps/server/src/agents/AgentRepository.ts` and `apps/server/src/agents/SkillRepository.ts`.

- Reads use `list`, `get`, and named filters for actual callers, such as `SkillRepository.listForAgent`.
- Writes use `save` (or `insert` and `update`) and `remove`, each atomic on its own; a write that sets a unique name refuses `name_taken` itself.

Handlers can check permissions and request dependencies, such as an offered model or existing skills, build the entity's next value, and hand it to the repository. Services coordinate operations spanning repositories and own the transaction that must commit them together. Each repository still owns its queries and atomic writes; callers use repository methods to read related entities instead of writing their own joins.

## Errors

A refusal is the domain declining a well-formed request because of the application's current state: a valid name is already taken, or removing an admin would leave the organization without one. Define refusals in the model and use them from the repository or application operation that enforces the rule.

Malformed requests are decode failures. Storage failures are defects. Keep these separate from domain refusals.

## Build tasks and caches

Declare prerequisites between packages in the task graph. Build scripts must not invoke other build tasks outside that graph. Ordering must remain correct through direct package commands and recursive workspace commands.

Define which artifacts each task owns. Treat cleanup and cache restoration as writes: deleting a parent directory affects every descendant. Order conflicting accesses and declare cache outputs explicitly when tasks share an output tree. Include environment values that change artifacts in cache inputs.

When changing build dependencies or artifact ownership, verify cold execution, warm execution, and a changed package with cached dependencies. Inspect task summaries to confirm which tasks ran, how many times, and their ordering. A passing run alone does not establish that the graph is correct.

## Setup and verification

The documented setup command installs the pinned development tools and their required runtime assets and system dependencies. Required checks consume those prerequisites without downloading them or silently skipping coverage. Setup failures must propagate and explain what is missing.

When changing setup or introducing prerequisites, verify the documented commands in a disposable environment without installed workspace dependencies, build outputs, application state, or tool-specific caches. Exercise system-package installation with the documented privileges. Repeat setup verification when upgrading tools that select external runtime assets.

Limit verification claims to the conditions exercised. Distinguish installation from an installation dry run, executed checks from cached results, and default configuration from local overrides. State any unverified part of setup explicitly.

## Naming

Name a thing after the domain concept it is. Don't name it after a workflow it takes part in, after who uses it, or after when it runs. Data that describes, configures or selects a concept takes that concept's name. Adding a noun to a workflow word doesn't fix the name: `signInMethod` and `signInConfig` still name the workflow.

- An identity provider such as Clerk issues identity tokens. The server component that checks them doesn't provide identities, so it's the `IdentityTokenValidator`, not `IdentityProvider`. Only the operation that starts a session is `signIn`.
- The validator that development builds use trusts whatever email it receives, so it's `layerEmailTrusting`, not `layerDev` or `layerLocal`. In Effect code, `testLayer` means a test double, so never give that name to a layer that production code selects.

Use one name for one concept across contracts, server, web, scripts, flags, env vars, files and docs. When the same thing has two names, such as "test" and "local" for the provider above, pick the better one and rename the other everywhere. A poor existing name is a reason to rename it, not to match it.

Reserve verbs for operations. A function or method name starts with a verb that says what it does: `makeFixture()`, not `fixture()`, and `makeInvalidIdentityToken(message)`, not `invalid(message)`. Values, types, modules and flags are nouns.

A name carries the feature that sets the thing apart, in plain words, so a reader does not need its documentation or body to know what it does. Avoid overloaded words that leave that feature to be guessed: prefer `isNonEmptyAfterTrimming` over `isNonBlank`, since “blank” can mean empty, whitespace-only, or unset. Prefer `keyPair` over `keys` for a key pair, and `privateKeyPath` over `keyPath` when other keys are nearby.

A boolean's name is the yes-or-no question it answers, starting with a verb such as `is`, `has`, `can`, or `should`; use `isConversational` instead of `conversational`.

## Code style

Prefer inferred types over annotations; do not use `any`.

Comments describe how a thing is used and explain important rationale that the code and its dependencies do not reveal.

Reuse established UI primitives and the nearest equivalent implementation before introducing new markup or conventions. Keep helper inputs limited to variation required by actual callers.

Every refactor starts by asking whether the existing code is still needed. Check its callers and the behavior it provides before moving it, extracting it, or adding an abstraction around it. Delete redundant logic and dependencies when existing capabilities already provide the required behavior.

After a refactor, remove obsolete fields and configuration, and check that module names, comments, fixtures, and test titles describe the resulting behavior.
