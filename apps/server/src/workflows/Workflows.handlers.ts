import { Authorization, CurrentActor, CurrentUser } from "@t45/contracts/Authorization";
import { Workflows } from "@t45/contracts/resources/Workflows";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { WorkflowService } from "./WorkflowService.ts";

const asViewer = <A, E, R>(run: (actorId: string) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(CurrentUser, (user) => run(user.userId));
const caller = Effect.map(CurrentActor, (actor) => ("userId" in actor ? actor.userId : actor));

export const layer = Workflows.middleware(Authorization).toLayer(
  Effect.gen(function* () {
    const workflows = yield* WorkflowService;
    return Workflows.of({
      "workflows.listWorkflows": () => asViewer(() => workflows.listWorkflows),
      "workflows.getWorkflow": ({ workflowId }) =>
        asViewer((id) => workflows.getWorkflow(id, workflowId)),
      "workflows.listProjects": () => asViewer(workflows.listProjects),
      "workflows.listStartableProjects": () => asViewer(workflows.listStartableProjects),
      "workflows.getProject": ({ idOrSlug }) =>
        asViewer((id) => workflows.getProject(id, idOrSlug)),
      "workflows.getProjectBoard": ({ idOrSlug }) =>
        asViewer((id) => workflows.getProjectBoard(id, idOrSlug)),
      "workflows.createWorkflow": (input) => asViewer((id) => workflows.createWorkflow(id, input)),
      "workflows.createProject": (input) => asViewer((id) => workflows.createProject(id, input)),
      "workflows.updateWorkflow": (input) => asViewer((id) => workflows.updateWorkflow(id, input)),
      "workflows.updateProject": (input) => asViewer((id) => workflows.updateProject(id, input)),
      "workflows.deleteProject": ({ projectId }) =>
        asViewer((id) => workflows.deleteProject(id, projectId)),
      "workflows.getProjectWorkflow": ({ projectId }) =>
        Effect.flatMap(caller, (actor) => workflows.getProjectWorkflow(actor, projectId)),
      "workflows.listTickets": (input) =>
        Effect.flatMap(caller, (actor) => workflows.listTickets(actor, input)),
      "workflows.getTicket": (input) =>
        Effect.flatMap(caller, (actor) => workflows.getTicket(actor, input)),
      "workflows.startTicket": (input) =>
        Effect.flatMap(caller, (actor) => workflows.startTicket(actor, input)),
      "workflows.cancelTicket": (input) => asViewer((id) => workflows.cancelTicket(id, input)),
      "workflows.reopenTicket": ({ ticketId }) =>
        asViewer((id) => workflows.reopenTicket(id, ticketId)),
      "workflows.setTicketDueDate": (input) =>
        asViewer((id) => workflows.setTicketDueDate(id, input)),
      "workflows.watchStep": ({ stepId }) =>
        Stream.unwrap(asViewer((id) => Effect.succeed(workflows.watchStep(id, stepId)))),
      "workflows.setStepField": (input) =>
        Effect.flatMap(caller, (actor) => workflows.setStepField(actor, input)),
      "workflows.markStepDone": ({ stepId }) =>
        asViewer((id) => workflows.markStepDone(id, stepId)),
      "workflows.setStepAutomations": (input) =>
        asViewer((id) => workflows.setStepAutomations(id, input)),
      "workflows.runStepAutomation": (input) =>
        asViewer((id) => workflows.runStepAutomation(id, input)),
      "workflows.stopStepAutomation": (input) =>
        asViewer((id) => workflows.stopStepAutomation(id, input)),
      "workflows.setStepAssignee": (input) =>
        asViewer((id) => workflows.setStepAssignee(id, input)),
      "workflows.blockStep": (input) => asViewer((id) => workflows.blockStep(id, input)),
      "workflows.unblockStep": ({ stepId }) => asViewer((id) => workflows.unblockStep(id, stepId)),
      "workflows.commentOnStep": (input) =>
        Effect.flatMap(caller, (actor) => workflows.commentOnStep(actor, input)),
      "workflows.attachStepFile": (input) =>
        Effect.flatMap(caller, (actor) => workflows.attachStepFile(actor, input)),
      "workflows.removeStepFile": (input) => asViewer((id) => workflows.removeStepFile(id, input)),
    });
  }),
);
