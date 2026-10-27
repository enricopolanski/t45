import * as WorkflowDefinitionRepository from "../workflows/WorkflowDefinitionRepository.ts";
import * as NotificationRepository from "../workflows/NotificationRepository.ts";
import * as UserRepository from "../org/UserRepository.ts";
import { AutomationId } from "@t45/contracts/models/Automation";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { Session } from "@opencode/client/effect";
import { Agent } from "@t45/contracts/models/Agent";
import { STEP_TOOLS_MCP } from "@t45/core/agentTools";
import { ChatId, type Refused } from "@t45/contracts/models/Chat";

import type { ChatEvent, ChatMessage } from "@t45/contracts/resources/Chats";
import type { NotFound } from "@t45/contracts/resources/errors";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as SqlClient from "effect/sql/SqlClient";

import * as AgentRepository from "../agents/AgentRepository.ts";
import * as SkillRepository from "../agents/SkillRepository.ts";
import * as AttachmentRepository from "../attachments/AttachmentRepository.ts";
import * as ServerConfig from "../config.ts";
import * as OpenCode2Client from "../opencode/OpenCode2Client.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as FakeOpenCode from "../runner/FakeOpenCode.testkit.ts";
import * as FakeRunner from "../runner/FakeRunner.testkit.ts";
import { RunnerService } from "../runner/RunnerService.ts";
import { inputMessageId } from "./ChatIds.ts";
import * as ChatRepository from "./ChatRepository.ts";
import { ChatService, layerTasks, type Member } from "./ChatService.ts";
import * as TicketRepository from "../workflows/TicketRepository.ts";
import * as WorkflowRepository from "../workflows/WorkflowRepository.ts";

import { ServerActivation } from "../serverActivation.ts";

export const testChatId = (n: number) =>
  ChatId.make(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);

/** The runner chats' VMs start on; tests script it and read what it got. */
export const runner = FakeRunner.makeFakeRunner();
/** The OpenCode servers in those VMs, which follow the runner's boots. */
export const openCode = FakeOpenCode.makeFakeOpenCode(runner);

/** Back to a healthy runner with no VMs. */
export const resetFakes = () => {
  FakeRunner.reset(runner);
  FakeOpenCode.reset(openCode);
};

const layerPersistence = Layer.mergeAll(
  ChatRepository.layer,
  UserRepository.layer,
  TicketRepository.layer,
  WorkflowRepository.layer,
  WorkflowDefinitionRepository.layer,
  NotificationRepository.layer,
  AttachmentRepository.layer,
  AgentRepository.layer,
  SkillRepository.layer,
).pipe(
  Layer.provideMerge(Sqlite.layerTest),
  Layer.provideMerge(ServerConfig.layerTest({ prefix: "t3-chats-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** Chats over a fresh database. */
export const stepHooks = {
  canAccess: () => Effect.succeed(null),
  canRun: () => Effect.succeed(true),
  prepare: () => Effect.succeed(null),
  changed: () => Effect.void,
};
export const layerBase = layerTasks.pipe(
  Layer.provideMerge(ChatService.layer),
  Layer.provideMerge(FakeRunner.layer(runner)),
  Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, FakeOpenCode.httpClient(openCode))),
  // The fake VMs' streams send no heartbeats, so a test can move the clock past any silence.
  Layer.provideMerge(Layer.succeed(OpenCode2Client.SilentStreamTimeout, Duration.infinity)),
  Layer.provideMerge(layerPersistence),
);

export const layer = layerBase.pipe(
  Layer.tap((context) =>
    Effect.flatMap(ChatService, (chats) => chats.start(stepHooks)).pipe(Effect.provide(context)),
  ),
);

/** Chat commands over the same fixture, with background execution parked. */
export const layerStore = layer.pipe(Layer.provide(Layer.succeed(ServerActivation, Effect.never)));

/** A worker receipt after earlier delivery/stop work; starts no VM and changes no chat. */
export const caughtUp = (chatId: ChatId) =>
  Effect.flatMap(RunnerService, (runner) => runner.run(chatId, () => Effect.void)).pipe(
    Effect.asVoid,
  );

const AT = "2026-10-23T09:00:00.000Z";

const encodeMcpServers = Schema.encodeSync(Schema.fromJsonString(Agent.fields.mcpServers));

/** An active member with `role`; returns the user id. */
export const addUser = (userId: string, role: "admin" | "member" = "member") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO users (id, role, state, email, display_name, created_at, updated_at)
      VALUES (${userId}, ${role}, 'active', ${`${userId}@example.test`}, ${userId}, ${AT}, ${AT})`;
    return userId;
  });

/** An agent members can chat with, made by `createdBy`; returns its id. */
export const addAgent = (
  name: string,
  options: {
    readonly chat?: boolean;
    readonly status?: "active" | "archived";
    readonly stepTools?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = `agent-${name.toLowerCase()}`;
    const mcpServers =
      options.stepTools === true ? { [STEP_TOOLS_MCP.name]: STEP_TOOLS_MCP.server } : {};
    yield* sql`INSERT INTO agents (id, name, instructions, model, mcp_servers, is_conversational,
        status, created_at, updated_at)
      VALUES (${id}, ${name}, 'Be brief.', 'opencode-go/test-model', ${encodeMcpServers(mcpServers)},
        ${options.chat === false ? 0 : 1}, ${options.status ?? "active"}, ${AT}, ${AT})`;
    return id;
  });

export const seedChat = (chat: {
  readonly id: ChatId;
  readonly ownerUserId: string | null;
  readonly agentId: string;
  readonly stepId?: string;
}) =>
  Effect.gen(function* () {
    yield* (yield* ChatRepository.ChatRepository).insert({
      id: chat.id,
      agentId: chat.agentId,
      title: chat.id,
      at: AT,
    });
    const origins = (yield* ChatRepository.ChatRepository).origins;
    const ticket =
      chat.stepId === undefined
        ? null
        : yield* (yield* TicketRepository.TicketRepository).getByStepId(chat.stepId);
    yield* origins.insert(
      chat.ownerUserId !== null
        ? { kind: "conversation", chatId: chat.id, ownerUserId: chat.ownerUserId }
        : {
            kind: "task",
            chatId: chat.id,
            state: { type: "active" },
            trigger:
              ticket !== null && chat.stepId !== undefined
                ? {
                    type: "step",
                    ticketId: ticket.id,
                    stepId: chat.stepId,
                    automationId: chat.id,
                  }
                : {
                    type: "automation",
                    automationId: AutomationId.make("fixture"),
                  },
          },
    );
    return chat.id;
  });

/** Follows a chat's events from its snapshot on; `next` reads them. */
export const follow = (chatId: ChatId, member: Member, sessionId?: Session.ID) =>
  Effect.gen(function* () {
    const chats = yield* ChatService;
    return yield* chats
      .open({ chatId, ...(sessionId === undefined ? {} : { sessionId }) }, member)
      .pipe(Stream.toQueue({ capacity: "unbounded" }));
  });

/** The next event that matches `predicate`, skipping the rest. */
export const next = <A extends ChatEvent, E>(
  events: Queue.Dequeue<ChatEvent, E>,
  predicate: (event: ChatEvent) => event is A,
) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(events).pipe(Effect.orDie);
      if (predicate(event)) return event;
    }
  });

/** Snapshots and messages events showing the message `id`, and, when given, in `state`. */
export const showing =
  (id: string, state?: ChatMessage["state"]) =>
  (event: ChatEvent): event is Extract<ChatEvent, { _tag: "snapshot" | "messages" }> =>
    (event._tag === "snapshot" || event._tag === "messages") &&
    event.messages.some(
      (each) => each.message.id === id && (state === undefined || each.state === state),
    );

export const isSnapshot = (event: ChatEvent): event is Extract<ChatEvent, { _tag: "snapshot" }> =>
  event._tag === "snapshot";

export const texts = (event: { readonly messages: ReadonlyArray<ChatMessage> }) =>
  event.messages.flatMap((each) =>
    each.message.type === "assistant"
      ? each.message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );

export const deliver = <E>(
  events: Queue.Dequeue<ChatEvent, E>,
  input: { readonly chatId: ChatId; readonly inputId: string; readonly text: string },
  member: Member,
) =>
  Effect.gen(function* () {
    yield* (yield* ChatService).send({ ...input, attachments: [] }, member);
    return yield* next(events, showing(inputMessageId(input.chatId, input.inputId), "settled"));
  });

export const failureOf = (error: Refused | NotFound) =>
  error._tag === "ChatRefused" ? error.reason : error._tag;
