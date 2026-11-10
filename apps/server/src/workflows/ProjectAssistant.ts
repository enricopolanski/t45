import { oversees, type WorkflowActor } from "@t45/contracts/models/Workflow";
import { NotFound } from "@t45/contracts/resources/errors";
import * as Effect from "effect/Effect";
import { UserRepository } from "../org/UserRepository.ts";
import { TicketRepository } from "./TicketRepository.ts";
import { WorkflowRepository } from "./WorkflowRepository.ts";
import { ProjectRepository } from "./ProjectRepository.ts";

// New inputs and tool calls need current access; the owner retains their conversation history.
export const makeAccess = Effect.gen(function* () {
  const users = yield* UserRepository;
  const projects = yield* ProjectRepository;
  const workflows = yield* WorkflowRepository;
  const tickets = yield* TicketRepository;
  const load = Effect.fnUntraced(function* (userId: string, projectId: string) {
    const user = yield* users.get(userId);
    const project = yield* projects.get(projectId);
    if (user?.state !== "active" || project === null || project.isArchived)
      return yield* new NotFound();
    const actor = { id: user.id, isOrgAdmin: user.role === "admin" };
    if (
      !project.isPublic &&
      !oversees(actor, project) &&
      !(yield* tickets.hasTicketsInvolving(projectId, userId))
    )
      return yield* new NotFound();
    const workflow = yield* workflows.get(project.workflowId);
    if (workflow === null || workflow.steps.length === 0) return yield* new NotFound();
    return { actor, project, workflow };
  });
  const list = Effect.fnUntraced(function* (actor: WorkflowActor) {
    const usableWorkflowIds = new Set(
      (yield* workflows.list)
        .filter((workflow) => workflow.steps.length > 0)
        .map((workflow) => workflow.id),
    );
    const involved = new Set(yield* tickets.projectIdsInvolving(actor.id));
    return (yield* projects.list).filter(
      (project) =>
        !project.isArchived &&
        usableWorkflowIds.has(project.workflowId) &&
        (project.isPublic || oversees(actor, project) || involved.has(project.id)),
    );
  });
  return { load, list };
});
