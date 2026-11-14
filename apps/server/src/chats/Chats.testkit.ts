import * as AutomationRepository from "../automations/AutomationRepository.ts";
import * as WorkflowRepository from "../workflows/WorkflowRepository.ts";
import * as NotificationRepository from "../workflows/NotificationRepository.ts";
import * as UserRepository from "../org/UserRepository.ts";
import { AutomationId } from "@t45/contracts/models/Automation";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { Session } from "@opencode/schema/session";
import { agents as presets } from "@t45/capabilities/agents";
import { stepOperations } from "@t45/capabilities/steps";
import { projectOperations } from "@t45/capabilities/projects";
import { workflowDrafting } from "@t45/capabilities/workflows";
import { webBrowser } from "@t45/capabilities/browser";
import { collections } from "@t45/capabilities/collections";
import { ChatId, type Refused } from "@t45/contracts/models/Chat";

import type { ChatEvent, ChatMessage } from "@t45/contracts/resources/Chats";
import type { NotFound } from "@t45/contracts/resources/errors";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as AgentRepository from "../agents/AgentRepository.ts";
import * as SkillRepository from "../agents/SkillRepository.ts";
import * as CapabilityRepository from "../capabilities/CapabilityRepository.ts";
import * as AttachmentRepository from "../attachments/AttachmentRepository.ts";
import * as CollectionRecordRepository from "../collections/CollectionRecordRepository.ts";
import * as CollectionRepository from "../collections/CollectionRepository.ts";
import * as CollectionService from "../collections/CollectionService.ts";
import * as ServerConfig from "../config.ts";
import * as CommandLogRepository from "../persistence/CommandLogRepository.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as FakeRunner from "../runner/FakeRunner.testkit.ts";
import { inputMessageId } from "./ChatIds.ts";
import * as ChatRepository from "./ChatRepository.ts";
import { ChatService, type Member } from "./ChatService.ts";
import * as TicketRepository from "../workflows/TicketRepository.ts";
import * as ProjectRepository from "../workflows/ProjectRepository.ts";

import * as WorkflowService from "../workflows/WorkflowService.ts";

export const testChatId = (n: number) =>
  ChatId.make(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);

const seedPresets = Effect.gen(function* () {
  yield* (yield* CapabilityRepository.CapabilityRepository).saveAll([
    stepOperations,
    projectOperations,
    workflowDrafting,
    webBrowser,
    collections,
  ]);
  const agents = yield* AgentRepository.AgentRepository;
  const now = yield* DateTime.now;
  for (const preset of presets) {
    yield* agents.save({
      ...preset,
      creatorUserId: null,
      isPublished: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  }
}).pipe(Effect.orDie);

const layerPersistence = Layer.effectDiscard(seedPresets).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      AutomationRepository.layer,
      ChatRepository.layer,
      UserRepository.layer,
      TicketRepository.layer,
      ProjectRepository.layer,
      WorkflowRepository.layer,
      NotificationRepository.layer,
      CommandLogRepository.layer,
      AttachmentRepository.layer,
      AgentRepository.layer,
      SkillRepository.layer,
      CapabilityRepository.layer,
      CollectionRepository.layer,
      CollectionRecordRepository.layer,
    ).pipe(
      Layer.provideMerge(Sqlite.testLayer),
      Layer.provideMerge(ServerConfig.testLayer("t3-chats-")),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

/** Chats over a fresh database. */
export const layer = WorkflowService.layer.pipe(
  Layer.provideMerge(CollectionService.layer),
  Layer.provideMerge(ChatService.layer),
  Layer.provideMerge(FakeRunner.layer),
  Layer.provideMerge(layerPersistence),
);

const AT = "2026-10-23T09:00:00.000Z";

/** An active member with `role`; returns the user id. */
export const addUser = (userId: string, role: "admin" | "member" = "member") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO users (id, role, state, email, display_name, created_at, updated_at)
      VALUES (${userId}, ${role}, 'active', ${`${userId}@example.test`}, ${userId}, ${AT}, ${AT})`;
    return userId;
  });

/** A published agent members can chat with; returns its id. */
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
    yield* sql`INSERT INTO agents (id, name, instructions, model, is_conversational,
        is_published, status, created_at, updated_at)
      VALUES (${id}, ${name}, 'Be brief.', 'opencode-go/test-model',
        ${options.chat === false ? 0 : 1}, 1, ${options.status ?? "active"}, ${AT}, ${AT})`;
    if (options.stepTools === true) {
      yield* sql`INSERT INTO agent_capabilities (agent_id, capability_id)
        VALUES (${id}, ${stepOperations.id})`;
    }
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
        ? { kind: "conversation", chatId: chat.id, ownerUserId: chat.ownerUserId, projectId: null }
        : {
            kind: "automation",
            chatId: chat.id,
            trigger:
              ticket !== null && chat.stepId !== undefined
                ? {
                    type: "step",
                    ticketId: ticket.id,
                    stepId: chat.stepId,
                    automationId: AutomationId.make(chat.id),
                    effectiveUserId: "fixture",
                  }
                : {
                    type: "manual",
                    automationId: AutomationId.make("fixture"),
                    effectiveUserId: "fixture",
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

/** The chat's execution ended: its status is no longer running. */
export const isEnded = (event: ChatEvent): event is Extract<ChatEvent, { _tag: "chat" }> =>
  event._tag === "chat" && event.chat.status !== "running";

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
