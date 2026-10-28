import { WORKFLOW_ASSISTANT_ID } from "@t45/contracts/models/Agent";
import {
  canViewTicket,
  isInvolved,
  oversees,
  Step,
  Ticket,
  WorkflowDefinition,
} from "@t45/contracts/models/Workflow";
import { NotFound } from "@t45/contracts/resources/errors";
import { NonNegativeInt, StringId, TrimmedNonEmptyString } from "@t45/contracts/models/primitives";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { WorkflowChatHooks } from "../chats/WorkflowChatHooks.ts";
import { UserRepository } from "../org/UserRepository.ts";
import { TicketRepository } from "./TicketRepository.ts";
import { WorkflowDefinitionRepository } from "./WorkflowDefinitionRepository.ts";
import { WorkflowRepository } from "./WorkflowRepository.ts";
import { WorkflowService } from "./WorkflowService.ts";

const encodeTicket = Schema.encodeSync(Schema.fromJsonString(Ticket));
const encodeDefinition = Schema.encodeSync(Schema.fromJsonString(WorkflowDefinition));
const encodeWorkflow = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      workflowId: StringId,
      name: TrimmedNonEmptyString,
      blueprint: WorkflowDefinition,
    }),
  ),
);
const encodeList = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      total: NonNegativeInt,
      tickets: Schema.Array(
        Schema.Struct({
          id: Ticket.fields.id,
          title: Ticket.fields.title,
          status: Ticket.fields.status,
          steps: Schema.Array(
            Schema.Struct({
              id: Step.fields.id,
              stepDefinitionId: Step.fields.stepDefinitionId,
              status: Step.fields.status,
            }),
          ),
        }),
      ),
    }),
  ),
);

export const make = Effect.gen(function* () {
  const users = yield* UserRepository;
  const instances = yield* WorkflowRepository;
  const definitions = yield* WorkflowDefinitionRepository;
  const tickets = yield* TicketRepository;
  const workflows = yield* WorkflowService;

  const actorOf = (userId: string) =>
    users
      .get(userId)
      .pipe(
        Effect.flatMap((user) =>
          user === null || user.state !== "active"
            ? new NotFound()
            : Effect.succeed({ id: user.id, isOrgAdmin: user.role === "admin" }),
        ),
      );

  const load = Effect.fnUntraced(function* (userId: string, workflowId: string) {
    const actor = yield* actorOf(userId);
    const workflow = yield* instances.get(workflowId);
    if (workflow === null || workflow.isArchived) return yield* new NotFound();
    if (!workflow.isPublic && !oversees(actor, workflow)) {
      if (!(yield* tickets.hasTicketsInvolving(workflowId, userId))) return yield* new NotFound();
    }
    const definition = yield* definitions.get(workflow.definitionId);
    if (definition === null || definition.steps.length === 0) return yield* new NotFound();
    return { actor, workflow, definition };
  });

  const visibleTicket = Effect.fnUntraced(function* (
    userId: string,
    workflowId: string,
    ticketId: string,
  ) {
    const context = yield* load(userId, workflowId);
    const ticket = yield* tickets.get(ticketId);
    if (
      ticket === null ||
      ticket.workflowId !== workflowId ||
      !canViewTicket(context.actor, context.workflow, ticket)
    )
      return yield* new NotFound();
    return { ...context, ticket };
  });

  return {
    targets: (userId) =>
      Effect.gen(function* () {
        const visible = yield* Effect.filter(yield* instances.list, (workflow) =>
          load(userId, workflow.id).pipe(Effect.isSuccess),
        );
        return visible.map((workflow) => ({
          agentId: WORKFLOW_ASSISTANT_ID,
          name: workflow.name,
          workflowId: workflow.id,
        }));
      }),
    name: (userId, workflowId) =>
      load(userId, workflowId).pipe(Effect.map(({ workflow }) => workflow.name)),
    context: (userId, workflowId) =>
      load(userId, workflowId).pipe(
        Effect.map(
          ({ workflow, definition }) =>
            `You interact with the workflow instance ${workflow.id}, named ${workflow.name}. Its current blueprint is:\n${encodeDefinition(definition)}`,
        ),
      ),
    execute: (userId, workflowId, call) =>
      Effect.gen(function* () {
        const context = yield* load(userId, workflowId);
        switch (call.tool) {
          case "get_workflow":
            return encodeWorkflow({
              workflowId,
              name: context.workflow.name,
              blueprint: context.definition,
            });
          case "list_tickets": {
            const query = call.input.query?.trim().toLowerCase() ?? "";
            const visible = (yield* tickets.listForWorkflow(workflowId)).filter(
              (ticket) =>
                canViewTicket(context.actor, context.workflow, ticket) &&
                (query === "" || ticket.title.toLowerCase().includes(query)),
            );
            return encodeList({
              total: visible.length,
              tickets: visible.slice(0, 100).map((ticket) => ({
                id: ticket.id,
                title: ticket.title,
                status: ticket.status,
                steps: ticket.steps.map((step) => ({
                  id: step.id,
                  stepDefinitionId: step.stepDefinitionId,
                  status: step.status,
                })),
              })),
            });
          }
          case "get_ticket": {
            const { ticket } = yield* visibleTicket(userId, workflowId, call.input.ticketId);
            return encodeTicket(ticket);
          }
          case "create_ticket": {
            const result = yield* workflows.startTicket(userId, { workflowId, ...call.input });
            const ticket = yield* tickets.getByStepId(result.stepId);
            if (ticket === null) return yield* new NotFound();
            return encodeTicket(ticket);
          }
          case "set_field": {
            const ticket = yield* tickets.getByStepId(call.input.stepId);
            if (ticket === null) return yield* new NotFound();
            const visible = yield* visibleTicket(userId, workflowId, ticket.id);
            if (!isInvolved(visible.actor, visible.workflow, ticket)) return yield* new NotFound();
            yield* workflows.setStepField(userId, call.input);
            const updated = yield* tickets.get(ticket.id);
            if (updated === null) return yield* new NotFound();
            return encodeTicket(updated);
          }
        }
      }),
  } satisfies WorkflowChatHooks;
});
