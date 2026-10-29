import { SessionMessage } from "@opencode/client/effect";
import {
  WorkflowInstanceCall,
  WorkflowInstanceInputs,
  WorkflowInstanceReply,
  WorkflowInstanceResponse,
} from "@t45/contracts/resources/WorkflowInstanceTools";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { ChatHooks } from "./ChatHooks.ts";
import { ChatEvents } from "./ChatEvents.ts";
import { noteMessageId, rootSessionId } from "./ChatIds.ts";
import { ChatRepository } from "./ChatRepository.ts";
import type { WorkflowChatHooks } from "./WorkflowChatHooks.ts";

const Receipt = Schema.Struct({
  t45: Schema.Struct({
    note: Schema.Literal("workflow"),
    call: WorkflowInstanceCall,
    reply: WorkflowInstanceReply,
  }),
});
const decodeNote = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionMessage.Info));
const readReceipt = Schema.decodeUnknownOption(Receipt);
const encodeReceipt = Schema.encodeEffect(Receipt);
const encodeResponse = Schema.encodeEffect(Schema.fromJsonString(WorkflowInstanceResponse));
const sameCall = Schema.toEquivalence(WorkflowInstanceCall);
const decodeRequestId = Schema.decodeUnknownOption(WorkflowInstanceInputs.get_workflow);
const decodeCall = Schema.decodeUnknownOption(WorkflowInstanceCall);

/** A running MCP call waits for a file reply. Writes and their replay receipts commit together. */
export const make = (hooksReady: Effect.Effect<WorkflowChatHooks | null>) =>
  Effect.gen(function* () {
    const repository = yield* ChatRepository;
    const changes = yield* ChatEvents;
    const sql = yield* SqlClient.SqlClient;
    const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql.withTransaction(effect).pipe(Effect.catchTags({ SqlError: Effect.die }));

    const saved: ChatHooks["saved"] = (chatId, messages, _read, deliver) =>
      Effect.gen(function* () {
        if (deliver === undefined) return;
        const workflowId = yield* repository.workflowId(chatId);
        const origin = yield* repository.origins.get(chatId);
        const hooks = yield* hooksReady;
        if (workflowId === null || origin?.kind !== "conversation" || hooks === null) return;
        for (const message of messages) {
          if (message.type !== "assistant") continue;
          for (const part of message.content) {
            if (
              part.type !== "tool" ||
              part.state.status !== "running" ||
              !part.name.startsWith("workflow_")
            )
              continue;
            const request = decodeRequestId(part.state.input);
            if (Option.isNone(request)) continue;
            const { requestId } = request.value;
            const call = decodeCall({
              tool: part.name.slice("workflow_".length),
              input: part.state.input,
            });
            const result = yield* transaction(
              Effect.gen(function* () {
                // Authorization precedes replay so a cached read cannot bypass revoked visibility.
                yield* hooks.name(origin.ownerUserId, workflowId);
                if (Option.isNone(call))
                  return {
                    isError: true,
                    text: "Invalid tool arguments. Use the tool schema and actual IDs from get_workflow and get_ticket.",
                  };
                const id = noteMessageId(chatId, "workflow", requestId);
                const cached = yield* repository.message(chatId, rootSessionId(chatId), id);
                if (cached !== null) {
                  const note = yield* decodeNote(cached.json).pipe(Effect.orDie);
                  const receipt =
                    note.type === "synthetic" ? readReceipt(note.metadata) : Option.none();
                  if (Option.isSome(receipt) && sameCall(receipt.value.t45.call, call.value))
                    return receipt.value.t45.reply;
                  return {
                    isError: true,
                    text: "That requestId was already used for another operation. Use a new UUID.",
                  };
                }
                const reply = yield* hooks.execute(origin.ownerUserId, workflowId, call.value).pipe(
                  Effect.map((text) => ({ isError: false, text })),
                  Effect.catchTags({
                    WorkflowRefused: (error) =>
                      Effect.succeed({ isError: true, text: error.message }),
                    NotFound: () =>
                      Effect.succeed({
                        isError: true,
                        text: "That workflow, ticket, or step is not available to you.",
                      }),
                  }),
                );
                if (call.value.tool !== "create_ticket" && call.value.tool !== "set_field")
                  return reply;
                const metadata = yield* encodeReceipt({
                  t45: { note: "workflow", call: call.value, reply },
                }).pipe(Effect.orDie);
                const stored = yield* repository.capture(chatId, rootSessionId(chatId), [
                  {
                    id,
                    type: "synthetic",
                    time: { created: yield* DateTime.now },
                    text: `${part.name}: ${reply.isError ? reply.text : "Completed"}`,
                    metadata,
                  },
                ]);
                yield* sql.afterCommit(
                  changes.publish({
                    kind: "messages",
                    chatId,
                    sessionId: rootSessionId(chatId),
                    messageIds: stored.messageIds,
                  }),
                );
                return reply;
              }),
            ).pipe(
              Effect.catchTags({
                NotFound: () =>
                  Effect.succeed({
                    isError: true,
                    text: "This workflow is no longer available to you.",
                  }),
              }),
            );
            const response = yield* encodeResponse({
              ...result,
              ...(Option.isSome(call) ? { call: call.value } : {}),
            }).pipe(Effect.orDie);
            yield* deliver(requestId, response);
          }
        }
      });
    return saved;
  });
