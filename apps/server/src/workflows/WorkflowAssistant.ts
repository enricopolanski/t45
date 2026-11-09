import { oversees } from "@t45/contracts/models/Workflow";
import { NotFound } from "@t45/contracts/resources/errors";
import * as Effect from "effect/Effect";
import { UserRepository } from "../org/UserRepository.ts";
import { TicketRepository } from "./TicketRepository.ts";
import { WorkflowDefinitionRepository } from "./WorkflowDefinitionRepository.ts";
import { WorkflowRepository } from "./WorkflowRepository.ts";

// New inputs and tool calls need current access; the owner retains their conversation history.
export const makeAccess = Effect.gen(function* () {
  const users = yield* UserRepository;
  const workflows = yield* WorkflowRepository;
  const definitions = yield* WorkflowDefinitionRepository;
  const tickets = yield* TicketRepository;
  return Effect.fnUntraced(function* (userId: string, workflowId: string) {
    const user = yield* users.get(userId);
    const workflow = yield* workflows.get(workflowId);
    if (user?.state !== "active" || workflow === null || workflow.isArchived)
      return yield* new NotFound();
    const actor = { id: user.id, isOrgAdmin: user.role === "admin" };
    if (
      !workflow.isPublic &&
      !oversees(actor, workflow) &&
      !(yield* tickets.hasTicketsInvolving(workflowId, userId))
    )
      return yield* new NotFound();
    const definition = yield* definitions.get(workflow.definitionId);
    if (definition === null || definition.steps.length === 0) return yield* new NotFound();
    return { actor, workflow, definition };
  });
});
