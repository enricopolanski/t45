import { WORKFLOW_INSTANCE_MCP_NAME } from "@t45/contracts/models/Agent";
import type { Attachment } from "@t45/contracts/models/Attachment";
import {
  canViewTicket,
  isInvolved,
  oversees,
  Ticket,
  WorkflowDefinition,
  type Refused,
} from "@t45/contracts/models/Workflow";
import {
  StepToolCall,
  WorkflowInstanceCall,
  WorkflowToolResponse,
} from "@t45/contracts/resources/AgentTools";
import type { Workflows } from "@t45/contracts/resources/Workflows";
import type { ChatId } from "@t45/contracts/models/Chat";
import { NotFound } from "@t45/contracts/resources/errors";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import type { Receive } from "../chats/ChatExecutions.ts";
import { AttachmentRepository } from "../attachments/AttachmentRepository.ts";
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
type ToolCall = (typeof WorkflowToolResponse.Type)["call"];
export type PreparedStepToolCall =
  | Exclude<StepToolCall, { tool: "step_attach" }>
  | (Extract<StepToolCall, { tool: "step_attach" }> & { readonly attachment: Attachment });
const decodeStepCall = Schema.decodeUnknownOption(StepToolCall);
const decodeInstanceCall = Schema.decodeUnknownOption(WorkflowInstanceCall);
const isStepCall = Schema.is(StepToolCall);
const unavailable = (call: ToolCall) =>
  isStepCall(call) ? "This step is unavailable." : "This workflow or ticket is unavailable to you.";
const sameCall = Schema.toEquivalence(WorkflowToolResponse.fields.call);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeTicket = Schema.encodeSync(Ticket);
const encodeDefinition = Schema.encodeSync(WorkflowDefinition);
const encodeResponse = Schema.encodeSync(Schema.fromJsonString(WorkflowToolResponse));

/** Applies workflow tools, records their results with the writes, and delivers one reply protocol. */
export const makeReceiver = (commands: {
  readonly applyStepTool: (
    chatId: ChatId,
    call: PreparedStepToolCall,
  ) => Effect.Effect<string, NotFound | Refused>;
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
    const files = yield* AttachmentRepository;
    const { transaction } = tickets;
    const prepareCall = Effect.fnUntraced(function* (chatId: ChatId, call: ToolCall) {
      if (call.tool === "step_attach") {
        const chat = yield* repository.get(chatId);
        const origin = yield* repository.origins.get(chatId);
        if (
          chat?.status !== "running" ||
          origin?.kind !== "automation" ||
          origin.trigger.type !== "step"
        )
          return yield* new NotFound();
        // VM reads and file storage must finish before taking the database transaction.
        const attachment = yield* Effect.gen(function* () {
          const file = yield* runner
            .readFile({
              rootId: rootSessionId(chatId),
              path: call.input.path,
              maxBytes: 25 * 1024 * 1024,
            })
            .pipe(Effect.catchTags({ RpcClientError: Effect.die }));
          return yield* files.store({
            name: file.name,
            mimeType: "application/octet-stream",
            bytes: file.content,
            uploader: chat.agentId,
          });
        }).pipe(Effect.result);
        return {
          apply: Effect.fromResult(attachment).pipe(
            Effect.flatMap((attachment) => commands.applyStepTool(chatId, { ...call, attachment })),
          ),
        };
      }
      if (isStepCall(call)) return { apply: commands.applyStepTool(chatId, call) };
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
      return {
        apply: Effect.gen(function* () {
          switch (call.tool) {
            case "get_workflow":
              return encodeJson({
                workflowId: workflow.id,
                name: workflow.name,
                blueprint: encodeDefinition(definition),
              });
            case "list_tickets": {
              const visible = yield* tickets.listForWorkflow(
                workflow,
                actor,
                call.input.query ?? "",
              );
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
        }),
      };
    });
    const readReceipt = Effect.fnUntraced(function* (chatId: ChatId, call: ToolCall) {
      const recorded = yield* repository.origins.operationReceipt(chatId, call.input.requestId);
      return recorded === null
        ? null
        : sameCall(recorded.call, call)
          ? recorded
          : {
              call,
              isError: true,
              text: "This requestId was already used for another operation; use a new ID.",
            };
    });
    const execute = Effect.fnUntraced(function* (chatId: ChatId, call: ToolCall) {
      if (call.tool === "step_attach") {
        const recorded = yield* readReceipt(chatId, call);
        if (recorded !== null) return recorded;
      }
      const prepared = call.tool === "step_attach" ? yield* prepareCall(chatId, call) : null;
      return yield* Effect.gen(function* () {
        const { apply } = prepared ?? (yield* prepareCall(chatId, call));
        const recorded = yield* readReceipt(chatId, call);
        if (recorded !== null) return recorded;
        const response = yield* transaction(apply).pipe(
          Effect.map((text) => ({ call, text, isError: false })),
          Effect.catchTags({
            WorkflowRefused: (error) =>
              Effect.succeed({ call, text: error.message, isError: true }),
            FileUnavailable: (error) =>
              Effect.succeed({ call, text: error.message, isError: true }),
            AttachmentNameError: () =>
              Effect.succeed({ call, text: "The file name is invalid.", isError: true }),
          }),
        );
        yield* repository.origins.recordOperation(chatId, response);
        return response;
      }).pipe(transaction);
    });
    return (result: Parameters<Receive>[0]) =>
      Effect.gen(function* () {
        if (result.type !== "messages") return;
        for (const message of result.messages) {
          if (message.type !== "assistant") continue;
          for (const part of message.content) {
            if (part.type !== "tool" || part.state.status !== "running") continue;
            const decoded: Option.Option<ToolCall> = part.name.startsWith(
              `${WORKFLOW_INSTANCE_MCP_NAME}_`,
            )
              ? decodeInstanceCall({
                  tool: part.name.slice(WORKFLOW_INSTANCE_MCP_NAME.length + 1),
                  input: part.state.input,
                })
              : decodeStepCall({ tool: part.name, input: part.state.input });
            if (Option.isNone(decoded)) continue;
            const call = decoded.value;
            const response = yield* execute(result.chatId, call).pipe(
              Effect.catchTags({
                NotFound: () =>
                  Effect.succeed({
                    call,
                    text: unavailable(call),
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
