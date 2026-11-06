# Styles and rules

These rules apply when writing or reviewing T45 code.

## Architecture

Models in `packages/contracts/src/models` describe application entities such as users and agents, and represent data as it makes sense to the domain; they do not bend to make storage or transport easier.

Resources in `packages/contracts/src/resources` define endpoint capabilities: accepted payloads, responses, and errors. A response can combine several models into a view: an `Automation` may carry only `agentId`, while an `AutomationView` includes the agent's name and tools.

Keep pure business rules in models, or resources when the rule belongs to a view or payload, so every consumer uses the same rule. For example, whether removing an admin would leave an organization without one belongs in the model. Keeping these rules independent of storage, transport, and UI makes them testable; duplicating a constraint in the database is an accepted cost.

`packages/core` holds pure application behavior shared by web and server, such as parsing and formatting message references. Model invariants stay in contracts. Core depends on contracts; contracts never depend on core. UI behavior stays in web, and provider-specific formatting stays in server.

Keep OpenCode integration complexity at its boundary: the runner's `ExecutionOrchestrator.ts` controls how an execution happens, the server's `ChatExecutions.ts` decides what T45 keeps, and `TaskService.ts` and workflow hooks apply task receipts. Store and send OpenCode's own shapes, imported from `@opencode/*`; do not declare them again. The UI displays domain decisions supplied by the server.

## Persistence and transactions

Handlers (`*.handlers.ts`) read and write through repositories or services; they never import `SqlClient` or write queries. Changes to storage should not reach the code that serves requests.

A repository owns the queries, atomic writes, and collection constraints for its entity, such as a name no other row may have. Its methods take and return models. Use one repository per entity, such as `apps/server/src/agents/AgentRepository.ts` and `apps/server/src/agents/SkillRepository.ts`.

- Reads use `list`, `get`, and named filters for actual callers, such as `SkillRepository.listForAgent`.
- Writes use `save` (or `insert` and `update`) and `remove`, each atomic on its own; a write that sets a unique name refuses `name_taken` itself.

Handlers can check permissions and request dependencies, such as an offered model or existing skills, build the entity's next value, and hand it to the repository. Services coordinate operations spanning repositories and own the transaction that must commit them together. Each repository still owns its queries and atomic writes; callers use repository methods to read related entities instead of writing their own joins.

## Errors

A refusal is the domain declining a well-formed request because of the application's current state: a valid name is already taken, or removing an admin would leave the organization without one. Define refusals in the model and use them from the repository or application operation that enforces the rule.

Malformed requests are decode failures. Storage failures are defects. Keep these separate from domain refusals.

## Naming

A name carries the feature that sets the thing apart, in plain words, so a reader does not need its documentation or body to know what it does. Avoid overloaded words that leave that feature to be guessed: prefer `isNonEmptyAfterTrimming` over `isNonBlank`, since “blank” can mean empty, whitespace-only, or unset.

A boolean's name is the yes-or-no question it answers, starting with a verb such as `is`, `has`, `can`, or `should`; use `isConversational` instead of `conversational`.

## Code style

Prefer inferred types over annotations; do not use `any`.

Comments describe how a thing is used and explain important rationale that the code and its dependencies do not reveal.
