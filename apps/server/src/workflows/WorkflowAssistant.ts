import { WORKFLOW_INSTANCE_MCP_NAME } from "@t45/contracts/models/Agent";
import {
  canViewTicket,
  isInvolved,
  oversees,
  Ticket,
  WorkflowDefinition,
  type Refused,
} from "@t45/contracts/models/Workflow";
import {
  WorkflowInstanceCall,
  WorkflowInstanceResponse,
} from "@t45/contracts/resources/AgentTools";
import type { Workflows } from "@t45/contracts/resources/Workflows";
import { NotFound } from "@t45/contracts/resources/errors";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import type { Receive } from "../chats/ChatExecutions.ts";
import { ChatRepository } from "../chats/ChatRepository.ts";
import { rootSessionId } from "../chats/ChatIds.ts";
import { UserRepository } from "../org/UserRepository.ts";
import { RunnerService } from "../runner/RunnerService.ts";
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

type Payload<Tag extends string> = Rpc.Payload<
  Rpc.ExtractTag<RpcGroup.Rpcs<typeof Workflows>, `workflows.${Tag}`>
>;
const decodeCall = Schema.decodeUnknownOption(WorkflowInstanceCall);
const sameCall = Schema.toEquivalence(WorkflowInstanceCall);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeTicket = Schema.encodeSync(Ticket);
const encodeDefinition = Schema.encodeSync(WorkflowDefinition);
const encodeResponse = Schema.encodeSync(Schema.fromJsonString(WorkflowInstanceResponse));

/** Applies instance tools through the same commands people use, then replies without prompting the agent. */
export const makeReceiver = (commands: {
  readonly startTicket: (
    actorId: string,
    input: Payload<"startTicket">,
  ) => Effect.Effect<{ readonly ticketId: string }, NotFound | Refused>;
  readonly setStepField: (
    actorId: string,
    input: Payload<"setStepField">,
  ) => Effect.Effect<void, NotFound | Refused>;
}) =>
  Effect.gen(function* () {
    const load = yield* makeAccess;
    const tickets = yield* TicketRepository;
    const repository = yield* ChatRepository;
    const runner = yield* RunnerService;
    const { transaction } = tickets;
    const execute = Effect.fnUntraced(function* (
      chatId: Parameters<Receive>[0]["chatId"],
      call: WorkflowInstanceCall,
    ) {
      const origin = yield* repository.origins.get(chatId);
      if (origin?.kind !== "conversation" || origin.workflowId === null)
        return yield* new NotFound();
      const { actor, workflow, definition } = yield* load(origin.ownerUserId, origin.workflowId);
      let target: Ticket | null = null;
      if (call.tool === "get_ticket" || call.tool === "set_field") {
        target = yield* call.tool === "get_ticket"
          ? tickets.get(call.input.ticketId)
          : tickets.getByStepId(call.input.stepId);
        if (
          target === null ||
          target.workflowId !== workflow.id ||
          !canViewTicket(actor, workflow, target) ||
          (call.tool === "set_field" && !isInvolved(actor, workflow, target))
        )
          return yield* new NotFound();
      }
      const recorded = yield* repository.origins.operationReceipt(chatId, call.input.requestId);
      if (recorded !== null)
        return sameCall(recorded.call, call)
          ? recorded
          : {
              call,
              isError: true,
              text: "This requestId was already used for another operation; use a new ID.",
            };
      const apply = Effect.gen(function* () {
        switch (call.tool) {
          case "get_workflow":
            return encodeJson({
              workflowId: workflow.id,
              name: workflow.name,
              blueprint: encodeDefinition(definition),
            });
          case "list_tickets": {
            const visible = yield* tickets.listForWorkflow(workflow, actor, call.input.query ?? "");
            return encodeJson({
              total: visible.total,
              tickets: visible.tickets.map((ticket) => {
                const encoded = encodeTicket(ticket);
                return {
                  id: ticket.id,
                  title: ticket.title,
                  status: encoded.status,
                  steps: encoded.steps.map(({ id, stepDefinitionId, status }) => ({
                    id,
                    stepDefinitionId,
                    status,
                  })),
                };
              }),
            });
          }
          case "get_ticket":
            return encodeJson(encodeTicket(target!));
          case "create_ticket": {
            const { requestId: _requestId, ...input } = call.input;
            const { ticketId } = yield* commands.startTicket(actor.id, {
              workflowId: workflow.id,
              ...input,
            });
            return encodeJson(encodeTicket((yield* tickets.get(ticketId))!));
          }
          case "set_field": {
            const { requestId: _requestId, ...input } = call.input;
            yield* commands.setStepField(actor.id, input);
            return encodeJson(encodeTicket((yield* tickets.get(target!.id))!));
          }
        }
      });
      const response = yield* transaction(apply).pipe(
        Effect.map((text) => ({ call, text, isError: false })),
        Effect.catchTags({
          WorkflowRefused: (error) => Effect.succeed({ call, text: error.message, isError: true }),
          NotFound: () =>
            Effect.succeed({
              call,
              text: "This workflow or ticket is unavailable to you.",
              isError: true,
            }),
        }),
      );
      yield* repository.origins.recordOperation(chatId, response);
      return response;
    }, transaction);
    return (result: Parameters<Receive>[0]) =>
      Effect.gen(function* () {
        if (result.type !== "messages") return;
        for (const message of result.messages) {
          if (message.type !== "assistant") continue;
          for (const part of message.content) {
            if (
              part.type !== "tool" ||
              part.state.status !== "running" ||
              !part.name.startsWith(`${WORKFLOW_INSTANCE_MCP_NAME}_`)
            )
              continue;
            const decoded = decodeCall({
              tool: part.name.slice(WORKFLOW_INSTANCE_MCP_NAME.length + 1),
              input: part.state.input,
            });
            if (Option.isNone(decoded)) continue;
            const call = decoded.value;
            const response = yield* execute(result.chatId, call).pipe(
              Effect.catchTags({
                NotFound: () =>
                  Effect.succeed({
                    call,
                    text: "This workflow or ticket is unavailable to you.",
                    isError: true,
                  }),
              }),
            );
            // The transaction has committed before delivery, so a lost VM cannot undo or repeat the write.
            yield* runner
              .writeFiles({
                rootId: rootSessionId(result.chatId),
                files: {
                  [`.t45/replies/${call.input.requestId}.json`]: new TextEncoder().encode(
                    encodeResponse(response),
                  ),
                },
              })
              .pipe(Effect.orDie);
          }
        }
      });
  });
