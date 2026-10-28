import { Authorization, CurrentUser } from "@t45/contracts/Authorization";
import { Workflows } from "@t45/contracts/resources/Workflows";
import * as Effect from "effect/Effect";

import { WorkflowService } from "./WorkflowService.ts";

const asViewer = <A, E, R>(run: (actorId: string) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(CurrentUser, (currentUser) => run(currentUser.userId));

export const layer = Workflows.middleware(Authorization).toLayer(
  Effect.gen(function* () {
    const workflows = yield* WorkflowService;
    return Workflows.of({
      "workflows.listDefinitions": () => workflows.listDefinitions,
      "workflows.getDefinition": ({ definitionId }) =>
        asViewer((id) => workflows.getDefinition(id, definitionId)),
      "workflows.listInstances": () => asViewer(workflows.listInstances),
      "workflows.listStartableInstances": () => asViewer(workflows.listStartableInstances),
      "workflows.getInstance": ({ idOrSlug }) =>
        asViewer((id) => workflows.getInstance(id, idOrSlug)),
      "workflows.getInstanceBoard": ({ idOrSlug }) =>
        asViewer((id) => workflows.getInstanceBoard(id, idOrSlug)),
      "workflows.createDefinition": (input) => workflows.createDefinition(input),
      "workflows.createInstance": (input) => asViewer((id) => workflows.createInstance(id, input)),
      "workflows.updateDefinition": (input) =>
        asViewer((id) => workflows.updateDefinition(id, input)),
      "workflows.updateInstance": (input) => asViewer((id) => workflows.updateInstance(id, input)),
      "workflows.deleteInstance": ({ workflowId }) =>
        asViewer((id) => workflows.deleteInstance(id, workflowId)),
      "workflows.startTicket": (input) => asViewer((id) => workflows.startTicket(id, input)),
      "workflows.cancelTicket": (input) => asViewer((id) => workflows.cancelTicket(id, input)),
      "workflows.reopenTicket": ({ ticketId }) =>
        asViewer((id) => workflows.reopenTicket(id, ticketId)),
      "workflows.setTicketDueDate": (input) =>
        asViewer((id) => workflows.setTicketDueDate(id, input)),
      "workflows.getStep": ({ stepId }) => asViewer((id) => workflows.getStep(id, stepId)),
      "workflows.setStepField": (input) => asViewer((id) => workflows.setStepField(id, input)),
      "workflows.markStepDone": ({ stepId }) =>
        asViewer((id) => workflows.markStepDone(id, stepId)),
      "workflows.approveStep": ({ stepId }) => asViewer((id) => workflows.approveStep(id, stepId)),
      "workflows.rejectStep": (input) => asViewer((id) => workflows.rejectStep(id, input)),
      "workflows.setStepAutomations": (input) =>
        asViewer((id) => workflows.setStepAutomations(id, input)),
      "workflows.setStepAssignee": (input) =>
        asViewer((id) => workflows.setStepAssignee(id, input)),
      "workflows.blockStep": (input) => asViewer((id) => workflows.blockStep(id, input)),
      "workflows.unblockStep": ({ stepId }) => asViewer((id) => workflows.unblockStep(id, stepId)),
      "workflows.commentOnStep": (input) => asViewer((id) => workflows.commentOnStep(id, input)),
      "workflows.attachStepFile": (input) => asViewer((id) => workflows.attachStepFile(id, input)),
      "workflows.removeStepFile": (input) => asViewer((id) => workflows.removeStepFile(id, input)),
    });
  }),
);
