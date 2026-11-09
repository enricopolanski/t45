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
      "workflows.listDefinitions": () => asViewer(() => workflows.listDefinitions),
      "workflows.getDefinition": ({ definitionId }) =>
        asViewer((id) => workflows.getDefinition(id, definitionId)),
      "workflows.listInstances": () => asViewer(workflows.listInstances),
      "workflows.listStartableInstances": () => asViewer(workflows.listStartableInstances),
      "workflows.getInstance": ({ idOrSlug }) =>
        asViewer((id) => workflows.getInstance(id, idOrSlug)),
      "workflows.getInstanceBoard": ({ idOrSlug }) =>
        asViewer((id) => workflows.getInstanceBoard(id, idOrSlug)),
      "workflows.createDefinition": (input) => asViewer(() => workflows.createDefinition(input)),
      "workflows.createInstance": (input) => asViewer((id) => workflows.createInstance(id, input)),
      "workflows.updateDefinition": (input) =>
        asViewer((id) => workflows.updateDefinition(id, input)),
      "workflows.updateInstance": (input) => asViewer((id) => workflows.updateInstance(id, input)),
      "workflows.deleteInstance": ({ workflowId }) =>
        asViewer((id) => workflows.deleteInstance(id, workflowId)),
      "workflows.getWorkflow": ({ workflowId }) =>
        Effect.flatMap(caller, (actor) => workflows.getWorkflow(actor, workflowId)),
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
