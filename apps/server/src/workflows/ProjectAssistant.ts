import { NotFound } from "@t45/contracts/resources/errors";
import * as Effect from "effect/Effect";
import { UserRepository } from "../org/UserRepository.ts";
import { ProjectRepository } from "./ProjectRepository.ts";

// New inputs and tool calls need current access; the owner retains their conversation history.
export const makeAccess = Effect.gen(function* () {
  const users = yield* UserRepository;
  const projects = yield* ProjectRepository;
  /**
   * Finds a project for one of its people: an active member of a step of its workflow. `steps`
   * holds those steps' definition ids.
   */
  const load = Effect.fnUntraced(function* (userId: string, projectId: string) {
    const user = yield* users.get(userId);
    const project = yield* projects.get(projectId);
    if (
      user?.state !== "active" ||
      project === null ||
      project.isArchived ||
      project.workflowVersionId === null
    )
      return yield* new NotFound();
    const steps = new Set(yield* projects.members.stepIdsOf(projectId, userId));
    if (steps.size === 0) return yield* new NotFound();
    return { actor: { id: user.id, isOrgAdmin: user.role === "admin" }, project, steps };
  });
  /** The projects whose board `userId` opens: unarchived, adopted, with a step they work on. */
  const list = Effect.fnUntraced(function* (userId: string) {
    const memberOf = new Set(
      (yield* projects.members.listForUser(userId)).map((member) => member.projectId),
    );
    return (yield* projects.list).filter(
      (project) =>
        !project.isArchived && project.workflowVersionId !== null && memberOf.has(project.id),
    );
  });
  return { load, list };
});
