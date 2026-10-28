import * as SqlClient from "effect/sql/SqlClient";
import type { ChatHooks } from "../chats/ChatHooks.ts";
import { AbsolutePath, Form, Location, Session, SessionMessage } from "@opencode/client/effect";
import type { OpenCodeEvent } from "@opencode/protocol/groups/event";
import {
  type ChatId,
  type Refused,
  type Input,
  InputId,
  titleOf,
} from "@t45/contracts/models/Chat";
import { InputMetadata } from "@t45/contracts/resources/Chats";
import { type RunConfig, RunnerHttpApi } from "@t45/contracts/resources/RunnerVms";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";
import { HttpClientRequest } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";

import * as AgentRepository from "../agents/AgentRepository.ts";
import * as SkillRepository from "../agents/SkillRepository.ts";
import * as AttachmentRepository from "../attachments/AttachmentRepository.ts";
import { inputMessageId, isNoteOf, noteMessageId, rootSessionId } from "../chats/ChatIds.ts";
import { ChatEvents } from "../chats/ChatEvents.ts";
import * as ChatRepository from "../chats/ChatRepository.ts";
import * as OpenCode2Client from "../opencode/OpenCode2Client.ts";
import { forkParked } from "../serverActivation.ts";
import * as PromptService from "./PromptService.ts";

class RunnerUnavailableError extends Schema.TaggedError<RunnerUnavailableError>()(
  "RunnerUnavailableError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "The runner did not answer.";
  }
}

const makeConnection = Effect.gen(function* () {
  const url = (yield* Config.String("RUNNER_URL").pipe(Config.withDefault(""))).trim();
  const token = yield* Config.Redacted("RUNNER_TOKEN").pipe(Config.withDefault(Redacted.make("")));
  if (url === "" || Redacted.value(token).trim() === "") {
    return yield* Effect.die("RUNNER_URL and RUNNER_TOKEN are required: chats go to that runner.");
  }
  const httpClient = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) => HttpClientRequest.bearerToken(request, token)),
  );
  const baseUrl = url.replace(/\/+$/u, "");
  const client = yield* HttpApiClient.group(RunnerHttpApi, {
    httpClient,
    group: "runner",
    baseUrl,
  });
  /** Anything but the endpoint's own refusals means the runner didn't answer usefully. */
  const unavailable = (operation: string) => {
    const fail = (cause: unknown) => Effect.fail(new RunnerUnavailableError({ operation, cause }));
    return {
      HttpClientError: fail,
      SchemaError: fail,
      RunnerUnauthorizedError: fail,
      TimeoutError: fail,
    };
  };

  return {
    inventory: client
      .inventory()
      .pipe(Effect.timeout("10 seconds"), Effect.catchTags(unavailable("inventory"))),
    models: client.models().pipe(
      Effect.map((page) => page.models),
      Effect.timeout("20 seconds"),
      Effect.catchTags(unavailable("models")),
    ),
    // Making a VM pulls the image the first time, and a VM waits for its agent's MCP servers, so
    // starting one may take a while.
    ensureChat: (input: { readonly chatId: string; readonly chat: RunConfig }) =>
      client
        .ensureChat({ params: { vmId: input.chatId }, payload: input.chat })
        .pipe(Effect.timeout("3 minutes"), Effect.catchTags(unavailable("ensureChat"))),
    getChatWorkspace: (chatId: string) =>
      client
        .getChatWorkspace({ params: { vmId: chatId } })
        .pipe(Effect.timeout("2 minutes"), Effect.catchTags(unavailable("getChatWorkspace"))),
    putChatWorkspace: (input: { readonly chatId: string; readonly content: Uint8Array }) =>
      client
        .putChatWorkspace({ params: { vmId: input.chatId }, payload: input.content })
        .pipe(
          Effect.timeout("2 minutes"),
          Effect.asVoid,
          Effect.catchTags(unavailable("putChatWorkspace")),
        ),
    putChatFile: (input: {
      readonly chatId: string;
      readonly path: string;
      readonly content: Uint8Array;
    }) =>
      client
        .putChatFile({
          params: { vmId: input.chatId },
          query: { path: input.path },
          payload: input.content,
        })
        .pipe(
          Effect.timeout("2 minutes"),
          Effect.asVoid,
          Effect.catchTags(unavailable("putChatFile")),
        ),
    removeChat: (chatId: string) =>
      client
        .removeChat({ params: { vmId: chatId } })
        .pipe(
          Effect.timeout("60 seconds"),
          Effect.asVoid,
          Effect.catchTags(unavailable("removeChat")),
        ),
    chatServer: (chatId: string) => ({
      url: `${baseUrl}/chats/${encodeURIComponent(chatId)}/opencode`,
      password: Redacted.value(token),
    }),
  };
});

/**
 * The worker of each awake chat, the one fiber that talks to the chat's VM. It starts a VM from the
 * agent's current setup, restores the chat into every new boot, delivers the inputs members sent,
 * captures what OpenCode writes into T45's copy of the chat, saves the agent's workspace after each
 * turn, and removes the VM once the chat has been idle and saved for a while. Sends, scheduled
 * tasks, webhooks and workflow steps only save inputs and wake it; work on the VM itself, such as
 * answering a question, runs on it as a job, in order with its own.
 *
 * Capture reads only what changed: OpenCode's events mark what to read again, and a pass every
 * 150 ms (at once when a step or execution ends) pages each marked session forward from where
 * capture stood and re-reads its unfinished messages. Nothing OpenCode settled is ever dropped
 * from T45's copy; only unfinished messages of a VM that went away become `lost`.
 */

type OpenCodeClient = OpenCode2Client.OpenCode2Api["client"];

/** What a job gets: the chat's running VM. */
export interface ChatVm {
  readonly api: OpenCode2Client.OpenCode2Api;
  /** The chat's root session. */
  readonly root: Session.ID;
  /** The chat's sessions in the VM, its root first. */
  readonly sessions: ReadonlyArray<Session.ID>;
  /** Puts files sent to the chat under the VM's `attachments/`. */
  readonly putFiles: (
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, RunnerUnavailableError>;
  readonly withdraw: (
    input: Input,
  ) => Effect.Effect<void, Effect.Error<ReturnType<OpenCodeClient["session"]["inbox"]["cancel"]>>>;
}

/** A job waited longer for the chat's VM than its caller does. */
class JobTimeoutError extends Schema.TaggedError<JobTimeoutError>()("JobTimeoutError", {}) {
  override get message(): string {
    return "The chat's sandbox did not answer in time.";
  }
}

/** The chat's VM no longer holds its root session, so the chat is restored into it again. */
class RootMissingError extends Schema.TaggedError<RootMissingError>()("RootMissingError", {}) {}

/** The event stream ended, or never said it was connected. */
class StreamEndedError extends Schema.TaggedError<StreamEndedError>()("StreamEndedError", {}) {}

/** Batches events this long before reading what they changed. */
const CAPTURE_BATCH = "150 millis";
/** A chat with nothing to do keeps its VM this long. */
const IDLE_MILLIS = 5 * 60_000;
/** An unanswered question keeps a chat's VM this long, then it is cancelled. */
const QUESTION_MILLIS = 30 * 60_000;
/** How long a busy chat waits before it looks at sleeping again. */
const RECHECK_MILLIS = 60_000;
const CONNECT_TIMEOUT = "60 seconds";
const JOB_TIMEOUT = "3 minutes";
/** Messages per page when capture reads a session. */
const CAPTURE_PAGE = 200;
/** Saves the runner refuses in a row before the chat gives up on them, as on one too large. */
const SAVE_REFUSALS = 3;

type Reports = Map<string, { readonly parent: string; readonly child: string; received: boolean }>;

type Message =
  | { readonly _tag: "wake" }
  | {
      readonly _tag: "job";
      readonly boot: boolean;
      readonly run: (vm: ChatVm) => Effect.Effect<void>;
      /** Answers the job's caller that no VM runs. */
      readonly skip: Effect.Effect<void>;
    }
  | { readonly _tag: "events"; readonly cycle: number; urgent: boolean }
  | { readonly _tag: "ended"; readonly cycle: number };

/** What events marked to read again. */
interface Marks {
  full: boolean;
  tree: boolean;
  forms: boolean;
  activity: boolean;
  turnEnded: boolean;
  readonly messages: Set<string>;
  readonly touched: Map<string, Set<string>>;
  readonly info: Set<string>;
}

const noMarks = (full: boolean): Marks => ({
  full,
  tree: full,
  forms: full,
  activity: full,
  turnEnded: false,
  messages: new Set(),
  touched: new Map(),
  info: new Set(),
});

const encodeInputMetadata = Schema.encodeSync(InputMetadata);

/** Events that end a step or a turn, or ask a question, which capture reads at once. */
const isUrgent = (type: string) =>
  type === "session.step.ended" ||
  type === "session.step.failed" ||
  type === "session.inbox.delivered" ||
  type === "form.created" ||
  type.startsWith("session.execution.");

/** Marks what an event may have changed; false for events that change nothing T45 keeps. */
const mark = (marks: Marks, event: OpenCodeEvent): boolean => {
  const type = event.type;
  if (type.startsWith("form.")) {
    marks.forms = true;
    return true;
  }
  if (type.startsWith("shell.")) {
    marks.activity = true;
    return true;
  }
  if (!type.startsWith("session.")) return false;
  if (!("sessionID" in event.data) || typeof event.data.sessionID !== "string") return false;
  const sessionId = event.data.sessionID;
  switch (type) {
    case "session.created":
    case "session.deleted":
      marks.tree = true;
      return true;
    case "session.inbox.enqueued":
    case "session.inbox.cancelled":
    case "session.inbox.delivery.changed":
    case "session.tool.input.started":
    case "session.tool.input.delta":
    case "session.tool.input.ended":
    case "session.tool.progress":
    case "session.compaction.delta":
    case "session.step.streamed":
    case "session.viewed":
      return false;
    case "session.renamed":
    case "session.metadata.updated":
    case "session.permissions":
    case "session.usage.updated":
    case "session.moved":
      marks.info.add(sessionId);
      return true;
  }
  marks.messages.add(sessionId);
  const touched =
    ("assistantMessageID" in event.data ? event.data.assistantMessageID : undefined) ??
    ("inboxID" in event.data ? event.data.inboxID : undefined);
  if (typeof touched === "string") {
    const ids = marks.touched.get(sessionId) ?? new Set();
    ids.add(touched);
    marks.touched.set(sessionId, ids);
  }
  if (type.startsWith("session.execution.")) {
    marks.info.add(sessionId);
    marks.activity = true;
    if (type !== "session.execution.started") marks.turnEnded = true;
  }
  if (type === "session.agent.selected" || type === "session.model.selected") {
    marks.info.add(sessionId);
  }
  return true;
};

/**
 * Whether a request found the VM's server out of reach: no connection, or a 502 to 504 from the
 * runner saying the VM doesn't answer. OpenCode's client wraps such a failure in a `ClientError`,
 * and reports such a status as a body it couldn't decode.
 */
const outOfReach = (error: unknown): boolean => {
  const failure =
    Predicate.isTagged(error, "ClientError") && "cause" in error ? error.cause : error;
  if (!HttpClientError.isHttpClientError(failure)) return false;
  const reason = failure.reason;
  if (reason._tag === "TransportError") return true;
  const status = "response" in reason ? reason.response.status : 0;
  return status >= 502 && status <= 504;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ChatRepository.ChatRepository;
  const hooksReady = yield* Deferred.make<ChatHooks>();
  const changes = yield* ChatEvents;
  const runner = yield* makeConnection;
  const agents = yield* AgentRepository.AgentRepository;
  const skillRepository = yield* SkillRepository.SkillRepository;
  const files = yield* AttachmentRepository.AttachmentRepository;
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const layerScope = yield* Effect.scope;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  interface Entry {
    readonly mailbox: Queue.Queue<Message>;
    readonly fiber: Fiber.Fiber<void, unknown>;
  }
  const registry = yield* SynchronizedRef.make<ReadonlyMap<string, Entry>>(new Map());
  /** The registry without the worker reading `mailbox`; a newer worker of the chat stays. */
  const without = (
    entries: ReadonlyMap<string, Entry>,
    chatId: ChatId,
    mailbox: Queue.Queue<Message>,
  ) => {
    if (entries.get(chatId)?.mailbox !== mailbox) return entries;
    const next = new Map(entries);
    next.delete(chatId);
    return next;
  };
  // Held while an input goes to a chat's VM, from reading it until the ledger says so.
  const deliveries = yield* RcMap.make({ lookup: () => Semaphore.make(1) });
  const whileNotDelivering = <A, E, R>(chatId: string, effect: Effect.Effect<A, E, R>) =>
    RcMap.get(deliveries, chatId).pipe(
      Effect.flatMap((lock) => lock.withPermit(effect)),
      Effect.scoped,
    );
  let cycles = 0;

  /** Puts a sent file under the VM's `attachments/`; one the server or VM can't take is skipped. */
  const putFile = (chatId: ChatId, attachmentId: string) =>
    Effect.gen(function* () {
      const source = files.path(attachmentId);
      if (source === null) return;
      const content = yield* fileSystem.readFile(source);
      yield* runner.putChatFile({
        chatId,
        path: `${OpenCode2Client.ATTACHMENTS_FOLDER}/${attachmentId}`,
        content,
      });
    }).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          Effect.logWarning("A chat's attachment is missing on the server", {
            attachmentId,
            cause: error,
          }),
        RunnerRefusedError: (error) =>
          Effect.logWarning("The runner refused a chat's attachment", {
            attachmentId,
            reason: error.reason,
          }),
      }),
    );

  const publish = (chatId: ChatId, kind: "chat" | "sessions" | "inputs" | "questions") =>
    changes.publish({ kind, chatId });
  const setVm = (chatId: ChatId, vm: "awake" | "asleep") =>
    repository.setVm(chatId, vm).pipe(Effect.tap(() => publish(chatId, "chat")));

  const recoverTask = (chatId: ChatId) =>
    Effect.gen(function* () {
      const chat = yield* repository.get(chatId);
      if (chat === null) return;
      const hooks = yield* Deferred.await(hooksReady);
      if (chat.status !== "running" && chat.status !== "waiting")
        yield* hooks.ended(chatId, chat.status);
    });

  const setFailed = (chatId: ChatId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const chat = yield* repository.get(chatId);
          if (chat === null) return;
          const changed = yield* repository.setSummary(chatId, {
            status: "failed",
            lastActivityAt: DateTime.formatIso(chat.lastActivityAt),
          });
          if (changed) {
            yield* sql.afterCommit(publish(chatId, "chat"));
            yield* (yield* Deferred.await(hooksReady)).ended(chatId, "failed");
          }
        }),
      )
      .pipe(Effect.orDie);

  const clearRunning = (chatId: ChatId) =>
    Effect.gen(function* () {
      const chat = yield* repository.get(chatId);
      if (chat === null || chat.status !== "running") return;
      if (yield* repository.hasOpenInputs(chatId)) return;
      const changed = yield* repository.setSummary(chatId, {
        status: null,
        lastActivityAt: DateTime.formatIso(chat.lastActivityAt),
      });
      if (changed) yield* publish(chatId, "chat");
    });

  /**
   * Takes an input back from the chat's VM: out of OpenCode's inbox, then cancelled in the
   * ledger. Cancelling one OpenCode already delivered does nothing, so that one stays the
   * agent's: it is materialized, and capture brings its message in order.
   */
  const withdraw = (client: OpenCodeClient, chatId: ChatId, input: Input) =>
    Effect.gen(function* () {
      const root = rootSessionId(chatId);
      const id = inputMessageId(chatId, input.inputId);
      yield* client.session.inbox.cancel({ sessionID: root, inboxID: id });
      const delivered = yield* client.session.message
        .get({ sessionID: root, messageID: id })
        .pipe(
          Effect.as(true),
          Effect.catchTags({ MessageNotFoundError: () => Effect.succeed(false) }),
        );
      yield* repository.moveInput(
        chatId,
        input.inputId,
        ["waiting", "admitted"],
        delivered ? "materialized" : "cancelled",
      );
    });

  const interruptAll = (vm: ChatVm) =>
    Effect.gen(function* () {
      const running = yield* vm.api.client.session.active();
      for (const sessionID of vm.sessions) {
        if (!(sessionID in running)) continue;
        yield* vm.api.client.session
          .interrupt({ sessionID })
          .pipe(Effect.catchTags({ SessionNotFoundError: () => Effect.void }));
      }
      const shells = yield* vm.api.client.shell.list({
        location: { directory: OpenCode2Client.WORK_DIRECTORY },
      });
      for (const shell of shells.data) {
        if (shell.status !== "running") continue;
        yield* vm.api.client.shell.remove({
          id: shell.id,
          location: { directory: OpenCode2Client.WORK_DIRECTORY },
        });
      }
    });

  const consumeStop = (chatId: ChatId, vm: ChatVm | "absent" | "unreachable") =>
    Effect.gen(function* () {
      let stop = yield* repository.stopRequest(chatId);
      if (stop === null) return;
      while (stop !== null) {
        yield* whileNotDelivering(
          chatId,
          repository.cancelInputs(chatId, stop.through, ["waiting"]),
        );
        if (typeof vm !== "string") {
          // Queued inputs leave OpenCode first, so the end of what runs can't start one.
          for (const input of yield* repository.openInputs(chatId)) {
            if (input.ordinal > stop.through) continue;
            yield* vm
              .withdraw(input)
              .pipe(Effect.catchTags({ SessionNotFoundError: () => new RootMissingError() }));
          }
          yield* interruptAll(vm);
        } else if (vm === "unreachable") {
          return yield* publish(chatId, "inputs");
        } else {
          // No VM holds them, so no restore will send them again once they are cancelled here.
          yield* repository.cancelInputs(chatId, stop.through, ["admitted"]);
        }
        const executed: ChatRepository.StopRequest = stop;
        stop = (yield* repository.clearStop(chatId, executed))
          ? null
          : yield* repository.stopRequest(chatId);
      }
      yield* publish(chatId, "inputs");
    });

  /**
   * One VM boot of a chat, from starting it until the chat sleeps or the VM goes away. `ready`
   * runs once the chat is restored and caught up.
   */
  const awake = Effect.fnUntraced(function* (
    chatId: ChatId,
    mailbox: Queue.Queue<Message>,
    ready: Effect.Effect<void>,
    reports: Reports,
  ) {
    const hooks = yield* Deferred.await(hooksReady);
    const cycle = (cycles += 1);
    const chat = yield* repository.workerRow(chatId);
    if (chat === null) return "gone" as const;
    const agent = yield* agents.get(chat.agentId);
    if (agent === null) {
      yield* Effect.logWarning("A chat's agent is gone, so its VM can't start", { chatId });
      yield* setFailed(chatId);
      return "gone" as const;
    }
    const root = rootSessionId(chatId);
    const skills = yield* skillRepository.listForAgent(agent.id);
    const context = hooks.instructions === undefined ? "" : yield* hooks.instructions(chatId);
    const setup = {
      agent: {
        ...Struct.pick(agent, ["instructions", "files", "mcpServers", "permissions"]),
        instructions: [agent.instructions, context].filter(Boolean).join("\n\n"),
        skills: Object.fromEntries(
          skills.map((skill) => [
            skill.name,
            Struct.pick(skill, ["name", "description", "content", "files"]),
          ]),
        ),
      },
    } satisfies RunConfig;
    const { bootId } = yield* runner.ensureChat({ chatId, chat: setup });
    if (chat.bootId !== bootId) reports.clear();
    if ((yield* repository.workerRow(chatId)) === null) {
      yield* runner.removeChat(chatId);
      return "gone" as const;
    }
    const endpoint = runner.chatServer(chatId);
    const api = yield* OpenCode2Client.connect({
      baseUrl: endpoint.url,
      password: endpoint.password,
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    const client = api.client;

    // The stream only marks what to read again and forwards streamed text, so it never falls
    // behind; it starts before anything is read, so nothing that changes after is missed.
    const marks = { current: noMarks(false) };
    // Marks accumulate while a job or capture runs; one notification is enough to read them.
    let captureNotification: Extract<Message, { readonly _tag: "events" }> | undefined;
    const connected = yield* Deferred.make<void, StreamEndedError>();
    const events = yield* api.events;
    yield* events.pipe(
      Stream.runForEach((event) => {
        if (event.type === "server.connected") return Deferred.succeed(connected, undefined);
        if (event.type === "session.text.delta" || event.type === "session.reasoning.delta") {
          return changes.publish({
            chatId,
            kind: "delta",
            sessionId: event.data.sessionID,
            messageId: event.data.assistantMessageID,
            ordinal: event.data.ordinal,
            part: event.type === "session.text.delta" ? "text" : "reasoning",
            delta: event.data.delta,
          });
        }
        if (!mark(marks.current, event)) return Effect.void;
        if (captureNotification !== undefined) {
          captureNotification.urgent ||= isUrgent(event.type);
          return Effect.void;
        }
        captureNotification = { _tag: "events", cycle, urgent: isUrgent(event.type) };
        return Queue.offer(mailbox, captureNotification);
      }),
      Effect.exit,
      Effect.tap((exit) =>
        Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
          ? Effect.logInfo("A chat's event stream ended", { chatId, cause: exit.cause })
          : Effect.void,
      ),
      Effect.andThen(Deferred.fail(connected, new StreamEndedError())),
      Effect.andThen(Queue.offer(mailbox, { _tag: "ended", cycle })),
      Effect.forkScoped,
    );
    yield* Deferred.await(connected).pipe(
      Effect.timeoutOrElse({
        duration: CONNECT_TIMEOUT,
        orElse: () => new StreamEndedError(),
      }),
    );

    // The chat's sessions the VM holds, by id, with their title.
    const present = new Map<string, string>();
    let active = new Set<string>();
    const awaitingReports = () =>
      [...reports.values()].some((report) => !report.received && !active.has(report.child));
    const readFile = (path: string) => api.readFile(path).pipe(Effect.orElseSucceed(() => null));
    const captured = (sessionId: string, messages: ReadonlyArray<SessionMessage.Info>) =>
      Effect.gen(function* () {
        for (const message of messages) {
          if (message.type === "assistant") {
            for (const part of message.content) {
              if (
                part.type !== "tool" ||
                part.name !== "subagent" ||
                part.state.status !== "completed" ||
                part.state.metadata?.["status"] !== "running"
              )
                continue;
              const child = part.state.metadata["sessionID"];
              const key = `${message.id}/${part.id}`;
              if (typeof child === "string" && !reports.has(key))
                reports.set(key, { parent: sessionId, child, received: false });
            }
          } else if (message.type === "synthetic" && message.metadata?.["source"] === "subagent") {
            for (const report of reports.values())
              if (report.parent === sessionId && report.child === message.metadata["childID"])
                report.received = true;
          }
        }
        yield* hooks.saved(chatId, messages, readFile, (requestId, text) =>
          runner
            .putChatFile({
              chatId,
              path: `${OpenCode2Client.ATTACHMENTS_FOLDER}/${requestId}.json`,
              content: new TextEncoder().encode(text),
            })
            .pipe(Effect.orDie),
        );
      });
    let shellsRunning = false;
    // A turn ended since the workspace was saved; a new boot saves once before it sleeps.
    let workspaceDirty = true;
    let refusedSaves = 0;
    let lastActivity = yield* Clock.currentTimeMillis;

    /** Lets go of a subagent's session the VM no longer holds; what it left unfinished is lost. */
    const forget = (sessionId: string) =>
      Effect.gen(function* () {
        present.delete(sessionId);
        active.delete(sessionId);
        const lost = yield* repository.loseSession(chatId, sessionId);
        for (const report of reports.values())
          if (report.child === sessionId || report.parent === sessionId) report.received = true;
        if (lost.length > 0) {
          yield* changes.publish({ chatId, kind: "messages", sessionId, messageIds: lost });
        }
      });

    /**
     * Answers `instead` for a session the VM no longer holds, as when the agent removed it: a
     * subagent's is let go, and without its root the chat is restored into the VM again.
     */
    const missing = <A>(sessionId: string, instead: A) =>
      Effect.gen(function* () {
        if (sessionId === root) return yield* new RootMissingError();
        yield* forget(sessionId);
        return instead;
      });

    const vm = (): ChatVm => ({
      api,
      root,
      sessions: [...present.keys()].map((id) => Session.ID.make(id)),
      putFiles: (attachmentIds) =>
        Effect.forEach(attachmentIds, (id) => putFile(chatId, id), { discard: true }),
      withdraw: (input) => withdraw(client, chatId, input),
    });

    /** Keeps a session the VM holds; true when members see something new about it. */
    const record = (info: Session.Info, stored?: Map<string, ChatRepository.SessionRow>) =>
      Effect.gen(function* () {
        const title = info.title ?? "";
        const row = {
          sessionId: info.id,
          parentSessionId: info.id === root ? null : (info.parentID ?? null),
          info,
        };
        yield* repository.putSession(chatId, row);
        stored?.set(info.id, { ...row, tailCursor: stored.get(info.id)?.tailCursor ?? null });
        const known = present.get(info.id);
        present.set(info.id, title);
        return known !== title;
      });

    const getSession = (sessionId: string) =>
      client.session
        .get({ sessionID: Session.ID.make(sessionId) })
        .pipe(Effect.asSome, Effect.catchTags({ SessionNotFoundError: () => Effect.succeedNone }));

    /** Reads the VM's sessions and keeps the chat's: its root and what descends from it. */
    const readTree = (stored: Map<string, ChatRepository.SessionRow>) =>
      Effect.gen(function* () {
        const all = yield* OpenCode2Client.listSessions(client).pipe(Stream.runCollect);
        if (!all.some((info) => info.id === root)) return yield* new RootMissingError();
        const held = [
          ...all.filter((info) => info.id === root),
          ...OpenCode2Client.sessionsUnder(root, all),
        ];
        let changed = false;
        for (const info of held) changed = (yield* record(info, stored)) || changed;
        // A session it kept that the VM no longer holds was removed there, maybe while T45 was away.
        const heldIds = new Set<string>(held.map((info) => info.id));
        for (const sessionId of stored.keys()) {
          if (heldIds.has(sessionId)) continue;
          yield* forget(sessionId);
          stored.delete(sessionId);
        }
        if (changed) yield* publish(chatId, "sessions");
      });

    /** Pages a session forward from where capture stood, then re-reads what may have changed. */
    const captureSession = (
      sessionId: string,
      touched: ReadonlySet<string>,
      stored: ChatRepository.SessionRow | undefined,
    ) =>
      Effect.gen(function* () {
        const sessionID = Session.ID.make(sessionId);
        const written = new Set<string>();
        let inputsChanged = false;
        const keep = (
          saved: ChatRepository.Captured,
          messages: ReadonlyArray<SessionMessage.Info>,
        ) =>
          Effect.gen(function* () {
            for (const id of saved.messageIds) written.add(id);
            inputsChanged = inputsChanged || saved.inputsChanged;
            yield* captured(
              sessionId,
              messages.filter((message) => saved.messageIds.includes(message.id)),
            );
          });
        let cursor = stored?.tailCursor ?? undefined;
        while (true) {
          const page = yield* client.message.list(
            cursor === undefined
              ? { sessionID, order: "asc", limit: CAPTURE_PAGE }
              : { sessionID, cursor, limit: CAPTURE_PAGE },
          );
          if (page.data.length > 0) {
            yield* keep(
              yield* repository.capture(chatId, sessionId, page.data, page.cursor.next),
              page.data,
            );
          }
          if (page.data.length < CAPTURE_PAGE || page.cursor.next === undefined) break;
          cursor = page.cursor.next;
        }
        const again = new Set([
          ...(yield* repository.liveMessageIds(chatId, sessionId)),
          ...touched,
        ]);
        for (const id of again) {
          if ((yield* repository.message(chatId, sessionId, id)) === null) continue;
          const message = yield* client.session.message
            .get({ sessionID, messageID: SessionMessage.ID.make(id) })
            .pipe(
              Effect.asSome,
              Effect.catchTags({ MessageNotFoundError: () => Effect.succeedNone }),
            );
          if (Option.isSome(message)) {
            yield* keep(yield* repository.capture(chatId, sessionId, [message.value]), [
              message.value,
            ]);
          }
        }
        // An input leaves the pending ones before it shows as a message, so it never shows twice.
        if (inputsChanged) yield* publish(chatId, "inputs");
        if (written.size > 0) {
          yield* changes.publish({
            chatId,
            kind: "messages",
            sessionId,
            messageIds: [...written],
          });
        }
      }).pipe(Effect.catchTags({ SessionNotFoundError: () => missing(sessionId, undefined) }));

    const readForms = Effect.gen(function* () {
      const forms: Array<Form.Info> = [];
      for (const sessionId of present.keys()) {
        const listed = yield* client.session.form
          .list({ sessionID: sessionId })
          .pipe(Effect.catchTags({ SessionNotFoundError: () => missing(sessionId, []) }));
        forms.push(...listed);
      }
      if (yield* repository.setQuestions(chatId, forms, yield* nowIso)) {
        yield* publish(chatId, "questions");
      }
    });

    const readActivity = Effect.gen(function* () {
      const running = yield* client.session.active();
      active = new Set(Object.keys(running).filter((id) => present.has(id)));
      const shells = yield* client.shell.list({
        location: { directory: OpenCode2Client.WORK_DIRECTORY },
      });
      shellsRunning = shells.data.some((shell) => shell.status === "running");
    });

    /** What the chat list shows: what the chat is doing and when its latest message came. */
    const summarize = (rootRow: ChatRepository.SessionRow | undefined) =>
      Effect.gen(function* () {
        const questions = yield* repository.questions(chatId);
        const open = yield* repository.openInputs(chatId);
        const outcome = rootRow?.info.outcome;
        const latest = yield* repository.latestTurn(chatId, root);
        const lastActivityAt = latest === null ? null : DateTime.formatIso(latest.time.created);
        const lost = yield* repository.lastTurnLost(chatId, root);
        const status =
          questions.length > 0
            ? ("waiting" as const)
            : open.length > 0 || active.size > 0 || shellsRunning || awaitingReports()
              ? ("running" as const)
              : outcome === "failed"
                ? ("failed" as const)
                : lost || outcome === "interrupted"
                  ? ("interrupted" as const)
                  : null;
        if (yield* repository.setSummary(chatId, { status, lastActivityAt }))
          yield* publish(chatId, "chat");
        if (status !== "running" && status !== "waiting") yield* hooks.ended(chatId, status);
      });

    /**
     * Tells the agent and members that /work isn't saved. T45 keeps the note at once, so members
     * see it and a restore carries it; the agent reads it at its next turn, since posting it
     * starts none.
     */
    const noteUnsaved = Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      const note = PromptService.workspaceNote({
        id: noteMessageId(chatId, "workspace", String(at)),
        at: DateTime.makeUnsafe(at),
        operation: "save",
      });
      yield* repository.capture(chatId, root, [note]);
      yield* changes.publish({
        chatId,
        kind: "messages",
        sessionId: root,
        messageIds: [note.id],
      });
      yield* client.session
        .synthetic({
          id: note.id,
          text: note.text,
          description: note.description,
          sessionID: root,
          metadata: note.metadata,
          delivery: "steer",
          resume: false,
        })
        .pipe(
          // T45 keeps the note either way, and a restore carries it into the VM.
          Effect.catch((error) =>
            error._tag === "SessionNotFoundError"
              ? new RootMissingError()
              : Effect.logWarning("A chat's VM didn't take T45's note", {
                  chatId,
                  cause: error,
                }),
          ),
        );
    });

    /**
     * Saves the agent's /work; true once saved, or once given up on after `SAVE_REFUSALS` refusals
     * in a row. A save that failed otherwise is tried again before the chat sleeps.
     */
    const saveWorkspace = Effect.gen(function* () {
      const content = yield* runner.getChatWorkspace(chatId);
      refusedSaves = 0;
      if (content.byteLength > 0) yield* repository.saveWorkspace(chatId, content);
      return true;
    }).pipe(
      Effect.catchTags({
        RunnerUnavailableError: (error) =>
          Effect.logWarning("Saving a chat's workspace failed", { chatId, cause: error }).pipe(
            Effect.as(false),
          ),
        RunnerRefusedError: (error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("The runner could not save a chat's workspace", {
              chatId,
              reason: error.reason,
            });
            refusedSaves += 1;
            if (refusedSaves < SAVE_REFUSALS) return false;
            // Refused every time: given up, so the chat can sleep; the last good one stays.
            if (yield* repository.markWorkspaceUnsaved(chatId)) {
              yield* noteUnsaved;
            }
            return true;
          }),
      }),
    );

    /** Reads what the marks say changed, then updates the chat's summary. */
    const reconcile = (marked: Marks) =>
      Effect.gen(function* () {
        const stored = new Map(
          (yield* repository.sessions(chatId)).map((row) => [row.sessionId, row]),
        );
        if (marked.full || marked.tree) yield* readTree(stored);
        for (const sessionId of marked.info) {
          if (!present.has(sessionId) || marked.full || marked.tree) continue;
          const info = yield* getSession(sessionId);
          if (Option.isNone(info)) {
            yield* missing(sessionId, undefined);
            stored.delete(sessionId);
            continue;
          }
          if (yield* record(info.value, stored)) yield* publish(chatId, "sessions");
        }
        const sessions = marked.full ? [...present.keys()] : [...marked.messages];
        for (const sessionId of sessions) {
          if (!present.has(sessionId)) continue;
          yield* captureSession(
            sessionId,
            marked.touched.get(sessionId) ?? new Set(),
            stored.get(sessionId),
          );
        }
        if (marked.full || marked.forms) yield* readForms;
        if (marked.full || marked.activity) yield* readActivity;
        if (marked.turnEnded) workspaceDirty = true;
        if (marked.turnEnded && active.size === 0 && !shellsRunning) {
          workspaceDirty = !(yield* saveWorkspace);
        }
        yield* summarize(stored.get(root));
      });

    /**
     * Cancels an input OpenCode refused, which every later delivery would only repeat, and tells
     * members with a note T45 keeps; false, as it never reached the agent.
     */
    const refuseInput = (input: Input, reason: string) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("OpenCode refused a chat's input", {
          chatId,
          inputId: input.inputId,
          reason,
        });
        yield* repository.moveInput(chatId, input.inputId, ["waiting", "admitted"], "cancelled");
        const id = noteMessageId(chatId, "refused", input.inputId);
        yield* repository.capture(chatId, root, [
          PromptService.refusedInputNote({
            id,
            text: input.payload.text,
            reason,
            at: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
          }),
        ]);
        yield* publish(chatId, "inputs");
        yield* changes.publish({ chatId, kind: "messages", sessionId: root, messageIds: [id] });
        return false;
      });

    /** Sends the chat's inputs OpenCode doesn't hold yet, in order, as the member sent them. */
    const deliver = (everything: boolean) =>
      Effect.gen(function* () {
        for (const input of yield* repository.openInputs(chatId)) {
          if (input.state === "admitted" && !everything) continue;
          if (!everything) {
            yield* Effect.forEach(input.payload.attachments, (file) => putFile(chatId, file.id), {
              discard: true,
            });
          }
          yield* whileNotDelivering(
            chatId,
            Effect.gen(function* () {
              // A member may have cancelled it since it was read.
              const current = yield* repository.input(chatId, input.inputId);
              if (current?.state !== "waiting" && current?.state !== "admitted") return;
              const stop = yield* repository.stopRequest(chatId);
              if (stop !== null && input.ordinal <= stop.through) {
                yield* repository.moveInput(
                  chatId,
                  input.inputId,
                  ["waiting", "admitted"],
                  "cancelled",
                );
                return yield* publish(chatId, "inputs");
              }
              const admitted = yield* client.session
                .prompt({
                  sessionID: root,
                  id: inputMessageId(chatId, input.inputId),
                  text: PromptService.format(input.payload),
                  metadata: encodeInputMetadata({ t45: input.payload }),
                  delivery: "queue",
                })
                .pipe(
                  Effect.as(true),
                  Effect.catchTags({
                    SessionNotFoundError: () => new RootMissingError(),
                    InvalidRequestError: (error) => refuseInput(input, error.message),
                    ConflictError: (error) => refuseInput(input, error.message),
                  }),
                );
              if (admitted) {
                yield* repository.moveInput(chatId, input.inputId, ["waiting"], "admitted");
              }
            }),
          );
        }
      });

    const location = Location.PublicRef.make({
      directory: AbsolutePath.make(OpenCode2Client.WORK_DIRECTORY),
    });
    const model = OpenCode2Client.modelRef(agent.model);
    const permissions = OpenCode2Client.sessionRules(yield* hooks.policy(chatId));
    const createRoot = client.session.create({
      id: root,
      title: titleOf(chat),
      ...(model === undefined ? {} : { model }),
      location,
      permissions,
    });

    const resumeLostTurn = sql
      .withTransaction(
        Effect.gen(function* () {
          if (
            !(yield* hooks.policy(chatId)).recover ||
            !(yield* repository.lastTurnLost(chatId, root))
          )
            return;
          if (yield* repository.hasOpenInputs(chatId)) return;
          if ((yield* repository.stopRequest(chatId)) !== null) return;
          const latest = yield* repository.latestInput(chatId);
          if (latest?.payload.text === PromptService.resumePrompt) return;
          yield* repository.addInput(chatId, {
            inputId: InputId.make(`t45-resume-${(latest?.ordinal ?? -1) + 1}`),
            payload: { text: PromptService.resumePrompt, attachments: [] },
            at: DateTime.formatIso(yield* DateTime.now),
          });
          yield* publish(chatId, "inputs");
        }),
      )
      .pipe(Effect.orDie);

    /**
     * Puts the chat into a new boot: its files, its workspace, and its sessions, parents first,
     * the root's ending with a note on what the VM that went away was in the middle of.
     */
    const restore = Effect.gen(function* () {
      const workspace = yield* repository.readWorkspace(chatId);
      const gone = yield* repository.loseVm(chatId, ({ lost, questions }) =>
        Effect.gen(function* () {
          return PromptService.restoreNote({
            id: noteMessageId(chatId, "restore", bootId),
            at: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
            root,
            lost,
            questions,
            workspaceRestored: workspace !== null,
          });
        }),
      );
      yield* resumeLostTurn;
      const shown = [
        ...gone.lost.map((each) => ({ sessionId: each.sessionId, messageId: each.message.id })),
        ...(gone.note === null ? [] : [{ sessionId: root, messageId: gone.note.id }]),
      ];
      for (const sessionId of new Set(shown.map((each) => each.sessionId))) {
        yield* changes.publish({
          chatId,
          kind: "messages",
          sessionId,
          messageIds: shown
            .filter((each) => each.sessionId === sessionId)
            .map((each) => each.messageId),
        });
      }
      if (gone.questions.length > 0) yield* publish(chatId, "questions");
      yield* Effect.forEach(yield* files.boundTo(chatId), (id) => putFile(chatId, id), {
        discard: true,
      });
      if (workspace !== null) {
        yield* runner.putChatWorkspace({ chatId, content: workspace }).pipe(
          Effect.catchTags({
            RunnerRefusedError: (error) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("The runner refused a chat's workspace", {
                  chatId,
                  reason: error.reason,
                });
                // Kept before the root's import, which carries it, and after any note on what was
                // lost, which said /work came back.
                const id = noteMessageId(chatId, "workspace", `unpack.${bootId}`);
                yield* repository.capture(chatId, root, [
                  PromptService.workspaceNote({
                    id,
                    operation: "restore",
                    at: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
                  }),
                ]);
                yield* changes.publish({
                  chatId,
                  kind: "messages",
                  sessionId: root,
                  messageIds: [id],
                });
              }),
          }),
        );
      }
      const mirrored = yield* repository.sessions(chatId);
      if (mirrored.length === 0) {
        yield* record(yield* createRoot);
        return yield* publish(chatId, "sessions");
      }
      // Parents before their children, as import needs.
      const tree = mirrored.map((session) => ({
        ...session,
        id: session.sessionId,
        parentID: session.parentSessionId,
      }));
      for (const session of [
        ...tree.filter((session) => session.id === root),
        ...OpenCode2Client.sessionsUnder(root, tree),
      ]) {
        const isRoot = session.sessionId === root;
        const info = session.info;
        // The root's ends with the note on what the VM that went away was doing, if anything.
        const messages = yield* repository.settled(chatId, session.sessionId);
        const imported = yield* client.session
          .import({
            info: {
              ...info,
              permissions,
              ...(isRoot
                ? { title: titleOf(chat), ...(model === undefined ? {} : { model }) }
                : {}),
            },
            messages,
            location,
          })
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              // Already there; out of reach, which fails the boot; or refused, which a retry
              // would only repeat.
              error._tag === "ConflictError"
                ? Effect.succeed(true)
                : outOfReach(error)
                  ? Effect.fail(error)
                  : Effect.logError("Restoring a chat's session failed", {
                      chatId,
                      sessionId: session.sessionId,
                      cause: error,
                    }).pipe(Effect.as(false)),
            ),
          );
        const held = yield* getSession(session.sessionId);
        if (Option.isSome(held)) {
          yield* record(held.value);
        } else if (isRoot && !imported) {
          // The root is the chat: without its history it still goes on from here.
          yield* record(yield* createRoot);
        }
      }
      yield* repository.resetTails(chatId);
      yield* publish(chatId, "sessions");
    });

    const newBoot = chat.bootId !== bootId;
    if (newBoot) yield* restore;
    // The VM may hold inputs T45 restarted before recording as sent; capture marks them
    // materialized first, since sending one again makes OpenCode run an empty turn.
    yield* reconcile(noMarks(true));
    yield* consumeStop(chat.id, newBoot ? "absent" : vm());
    yield* deliver(newBoot);
    yield* repository.setBoot(chatId, bootId);
    marks.current = noMarks(false);
    yield* reconcile(noMarks(true));
    yield* ready;

    /** Null once the chat can sleep; otherwise when to look again. */
    const trySleep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if ((yield* hooks.policy(chatId)).keepAlive && now - lastActivity < IDLE_MILLIS)
        return lastActivity + IDLE_MILLIS;
      marks.current = noMarks(false);
      yield* reconcile(noMarks(true));
      // A question keeps its session active and what was sent behind it waiting, so it goes first.
      const questions = yield* repository.questions(chatId);
      if (questions.length > 0) {
        const askedAt = questions.map((question) =>
          DateTime.toEpochMillis(DateTime.makeUnsafe(question.askedAt)),
        );
        if (askedAt.every((at) => at + QUESTION_MILLIS > now)) {
          return Math.min(...askedAt) + QUESTION_MILLIS;
        }
        // Nobody answered in time: the questions go, so the chat can sleep.
        for (const [index, question] of questions.entries()) {
          if ((askedAt[index] ?? now) + QUESTION_MILLIS > now) continue;
          yield* client.session.form
            .cancel({
              sessionID: question.sessionId,
              formID: question.form.id,
              message: "Nobody answered in time.",
            })
            .pipe(
              Effect.catchTags({
                FormNotFoundError: () => Effect.void,
                FormAlreadySettledError: () => Effect.void,
                SessionNotFoundError: () => missing(question.sessionId, undefined),
              }),
            );
        }
        lastActivity = now;
        yield* reconcile({ ...noMarks(false), forms: true, activity: true });
        return now + IDLE_MILLIS;
      }
      if ((yield* repository.openInputs(chatId)).length > 0) return now + RECHECK_MILLIS;
      if (active.size > 0 || shellsRunning) return now + RECHECK_MILLIS;
      for (const sessionId of present.keys()) {
        const inbox = yield* client.session.inbox
          .list({ sessionID: Session.ID.make(sessionId) })
          .pipe(Effect.catchTags({ SessionNotFoundError: () => missing(sessionId, []) }));
        // T45's own note waits for the agent's next turn, and T45 keeps it besides.
        if (inbox.some((item) => !isNoteOf(chatId, "workspace", item.id))) {
          return now + RECHECK_MILLIS;
        }
      }
      if (yield* repository.hasLive(chatId)) return now + RECHECK_MILLIS;
      if (awaitingReports()) return now + RECHECK_MILLIS;
      if (workspaceDirty) {
        workspaceDirty = !(yield* saveWorkspace);
        if (workspaceDirty) return now + RECHECK_MILLIS;
      }
      return null;
    });

    let nextCheck = lastActivity + IDLE_MILLIS;
    while (true) {
      const wait = Math.max(0, nextCheck - (yield* Clock.currentTimeMillis));
      const first = yield* Queue.take(mailbox).pipe(Effect.timeoutOption(wait));
      if (Option.isNone(first)) {
        const next = yield* trySleep;
        if (next === null) {
          // Asleep before its stream ends, so the end isn't taken for a lost VM.
          yield* setVm(chatId, "asleep");
          return "asleep" as const;
        }
        nextCheck = next;
        continue;
      }
      if (first.value._tag === "events" && first.value.cycle === cycle && !first.value.urgent) {
        yield* Effect.sleep(CAPTURE_BATCH);
      }
      const batch = [first.value, ...(yield* Queue.clear(mailbox))];
      if (batch.some((each) => each === captureNotification)) captureNotification = undefined;
      const jobs = batch.flatMap((each) => (each._tag === "job" ? [each] : []));
      let started = 0;
      const woken = batch.some((each) => each._tag === "wake");
      // Jobs this boot couldn't start go back to the mailbox, for the next boot or to hear that
      // no VM runs, so none is left waiting.
      yield* Effect.gen(function* () {
        if (batch.some((each) => each._tag === "ended" && each.cycle === cycle)) {
          return yield* new StreamEndedError();
        }
        lastActivity = yield* Clock.currentTimeMillis;
        nextCheck = lastActivity + IDLE_MILLIS;
        if (woken) {
          if ((yield* repository.stopRequest(chatId)) !== null)
            for (const report of reports.values()) report.received = true;
          yield* consumeStop(chat.id, vm());
          yield* deliver(false);
        }
        for (const job of jobs) {
          started += 1;
          yield* job.run(vm());
        }
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : Queue.offerAll(mailbox, jobs.slice(started)),
        ),
      );
      const marked = marks.current;
      marks.current = noMarks(false);
      if (woken || jobs.length > 0) {
        marked.forms = true;
        marked.activity = true;
        marked.messages.add(root);
      }
      yield* reconcile(marked);
      if (!(yield* hooks.policy(chatId)).keepAlive) nextCheck = yield* Clock.currentTimeMillis;
    }
  });

  /**
   * Whether the worker may end, from its mailbox alone: a job that boots, or a wake, keeps it, with
   * its jobs in order. Otherwise jobs left hear that no VM runs.
   */
  const finish = (chatId: ChatId, mailbox: Queue.Queue<Message>) =>
    SynchronizedRef.modifyEffect(registry, (entries) =>
      Effect.gen(function* () {
        const waiting = yield* Queue.clear(mailbox);
        const jobs = waiting.flatMap((each) => (each._tag === "job" ? [each] : []));
        if (jobs.some((job) => job.boot)) {
          yield* Queue.offerAll(mailbox, jobs);
          return ["boot", entries] as const;
        }
        if (waiting.some((each) => each._tag === "wake")) {
          yield* Queue.offerAll(mailbox, jobs);
          return ["recheck", entries] as const;
        }
        for (const job of jobs) yield* job.skip;
        return ["done", without(entries, chatId, mailbox)] as const;
      }),
    );

  const runWorker = (
    chatId: ChatId,
    mailbox: Queue.Queue<Message>,
    retryFailed: boolean,
    recover: boolean,
  ) =>
    Effect.gen(function* () {
      const reports: Reports = new Map();
      let failures = 0;
      let mayRetryFailed = retryFailed;
      let recovering = recover;
      // The runner or the VM's server was out of reach, which a later try gets past.
      const unreachable = (cause: unknown) =>
        Effect.logWarning("A chat's VM couldn't be reached; trying again", {
          chatId,
          cause,
        }).pipe(Effect.as("retry" as const));
      while (true) {
        const chat = yield* repository.workerRow(chatId);
        if (chat === null) return;
        yield* consumeStop(chat.id, chat.vm === "awake" ? "unreachable" : "absent");
        const isOwed =
          chat.vm === "awake" ||
          ((mayRetryFailed || chat.status !== "failed") &&
            (yield* repository.hasOpenInputs(chatId)));
        mayRetryFailed = false;
        if (!isOwed) {
          if (recovering) yield* recoverTask(chatId);
          recovering = false;
          yield* clearRunning(chatId);
          const next = yield* finish(chatId, mailbox);
          if (next === "done") return;
          if (next === "recheck") continue;
        }
        if (chat.vm !== "awake") yield* setVm(chatId, "awake");
        const outcome = yield* awake(
          chatId,
          mailbox,
          Effect.sync(() => {
            failures = 0;
            recovering = false;
          }),
          reports,
        ).pipe(
          Effect.scoped,
          Effect.catchTags({
            RunnerUnavailableError: unreachable,
            StreamEndedError: unreachable,
            HttpClientError: (error) => (outOfReach(error) ? unreachable(error) : error),
            ClientError: (error) => (outOfReach(error) ? unreachable(error) : error),
            RootMissingError: () =>
              Effect.logInfo("A chat's VM no longer holds its root session; restoring the chat", {
                chatId,
              }).pipe(
                Effect.andThen(repository.setBoot(chatId, null)),
                Effect.as("retry" as const),
              ),
          }),
          // Anything else, such as a refused VM or a stored message that no longer decodes, would
          // fail the same way again.
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logError("A chat's VM failed; it waits for the chat's next message", {
                chatId,
                cause,
              }).pipe(Effect.as("failed" as const)),
          ),
        );
        if (outcome === "gone") {
          yield* setVm(chatId, "asleep");
          continue;
        }
        if (outcome === "failed") {
          yield* setVm(chatId, "asleep");
          yield* setFailed(chatId);
          // What came in so far would fail the same way; a message sent from here on tries again.
          for (const each of yield* Queue.clear(mailbox)) if (each._tag === "job") yield* each.skip;
          continue;
        }
        if (outcome === "asleep") {
          yield* runner.removeChat(chatId).pipe(
            Effect.catchTags({
              RunnerUnavailableError: (error) =>
                Effect.logWarning("Removing a sleeping chat's VM failed", {
                  chatId,
                  cause: error,
                }),
            }),
          );
          continue;
        }
        // A dropped connection tries again at once; a VM out of reach, less and less often.
        failures += 1;
        if (failures > 1) {
          yield* Effect.sleep(`${Math.min(30, 2 ** Math.min(failures - 2, 5))} seconds`);
        }
      }
    }).pipe(
      // Forked workers report to nobody, so one that dies says so here.
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("A chat's worker stopped", { chatId, cause }),
      ),
      Effect.ensuring(
        // Under the registry's lock, so nothing is offered to the mailbox once it is cleared.
        SynchronizedRef.updateEffect(registry, (entries) =>
          Effect.gen(function* () {
            for (const each of yield* Queue.clear(mailbox)) {
              if (each._tag === "job") yield* each.skip;
            }
            return without(entries, chatId, mailbox);
          }),
        ),
      ),
    );

  const startWorker = (
    chatId: ChatId,
    entries: ReadonlyMap<string, Entry>,
    message: Message,
    retryFailed: boolean,
    recover = false,
  ) =>
    Effect.gen(function* () {
      const mailbox = yield* Queue.unbounded<Message>();
      yield* Queue.offer(mailbox, message);
      const fiber = yield* runWorker(chatId, mailbox, retryFailed, recover).pipe(
        Effect.forkIn(layerScope),
      );
      return [true, new Map(entries).set(chatId, { mailbox, fiber })] as const;
    });

  /** Offers `message` to the chat's worker, starting one when `start`; false when none runs. */
  const offer = (chatId: ChatId, message: Message, start: boolean, retryFailed = false) =>
    SynchronizedRef.modifyEffect(registry, (entries) =>
      Effect.gen(function* () {
        const entry = entries.get(chatId);
        if (entry !== undefined) {
          yield* Queue.offer(entry.mailbox, message);
          return [true, entries] as const;
        }
        if (!start) return [false, entries] as const;
        return yield* startWorker(chatId, entries, message, retryFailed);
      }),
    );

  const offerIfIdle = (chatId: ChatId, retryFailed: boolean, recover = false) =>
    SynchronizedRef.modifyEffect(registry, (entries) =>
      entries.has(chatId)
        ? Effect.succeed([false, entries] as const)
        : startWorker(chatId, entries, { _tag: "wake" }, retryFailed, recover),
    );

  const sweep = (includeFailed: boolean) =>
    Effect.gen(function* () {
      for (const chat of yield* repository.needingWorker(includeFailed)) {
        if (chat.hasStop) yield* offer(chat.id, { _tag: "wake" }, true, includeFailed);
        else yield* offerIfIdle(chat.id, includeFailed);
      }
    });

  const run = <A>(
    chatId: ChatId,
    job: (vm: ChatVm) => Effect.Effect<A, Refused>,
    options?: { readonly boot?: boolean },
  ) =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<Option.Option<A>, Refused | JobTimeoutError>();
      return yield* Effect.gen(function* () {
        const boot = options?.boot === true;
        const offered = yield* offer(
          chatId,
          {
            _tag: "job",
            boot,
            // A worker stopped mid-job, as for a deleted chat, answers that no VM runs.
            run: (vm) =>
              Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  // A caller that gave up hears nothing more, so its job never runs after that.
                  if (yield* Deferred.isDone(done)) return;
                  const exit = yield* restore(
                    job(vm).pipe(Effect.asSome, Effect.raceFirst(Deferred.await(done))),
                  ).pipe(Effect.exit);
                  yield* Deferred.done(
                    done,
                    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
                      ? Exit.succeed(Option.none())
                      : exit,
                  );
                }),
              ),
            skip: Deferred.succeed(done, Option.none()).pipe(Effect.asVoid),
          },
          boot,
        );
        if (!offered) return Option.none<A>();
        return yield* Deferred.await(done).pipe(
          Effect.timeoutOrElse({
            duration: JOB_TIMEOUT,
            // Whichever settles the job first wins: its outcome, or this giving up on it.
            orElse: () =>
              Deferred.fail(done, new JobTimeoutError()).pipe(Effect.andThen(Deferred.await(done))),
          }),
        );
      }).pipe(
        // The worker owns the job's fiber; ending its caller must also settle the job.
        Effect.ensuring(Deferred.succeed(done, Option.none())),
      );
    });

  const sweepLogged = sweep(false).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Sweeping chats for lost wakes failed", { cause }),
    ),
  );
  const posted = yield* changes.subscribe((change) => change.kind === "posted");
  yield* forkParked(
    Stream.runForEach(posted, (change) =>
      change.kind === "missed" ? sweepLogged : offer(change.chatId, { _tag: "wake" }, true),
    ),
  );
  yield* forkParked(sweepLogged.pipe(Effect.delay("30 seconds"), Effect.forever));

  return {
    inventory: runner.inventory,
    models: runner.models,
    removeChat: runner.removeChat,
    wake: (chatId: ChatId) => offer(chatId, { _tag: "wake" }, true).pipe(Effect.asVoid),
    run,
    whileNotDelivering,
    cancelWaiting: (chatId: ChatId) =>
      Effect.gen(function* () {
        const stop = yield* repository.stopRequest(chatId);
        if (stop === null) return;
        const cancelled = yield* whileNotDelivering(
          chatId,
          repository.cancelInputs(chatId, stop.through, ["waiting"]),
        );
        if (cancelled) yield* publish(chatId, "inputs");
      }),
    stop: (chatId: ChatId) =>
      SynchronizedRef.get(registry).pipe(
        Effect.flatMap((entries) => {
          const entry = entries.get(chatId);
          return entry === undefined ? Effect.void : Fiber.interrupt(entry.fiber);
        }),
      ),
    start: (hooks: ChatHooks, recover: ReadonlyArray<ChatId>) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(hooksReady, hooks);
        for (const chatId of recover) yield* offerIfIdle(chatId, true, true);
        const keep = new Set<string>(
          (yield* repository.needingWorker(true)).map((chat) => chat.id),
        );
        // A chat VM no awake chat holds is left over, as after a database wipe.
        const inventory = yield* runner.inventory.pipe(
          Effect.asSome,
          Effect.catchTags({
            RunnerUnavailableError: (error) =>
              Effect.logWarning(
                "Listing the runner's VMs failed; leftovers wait for its backstop",
                {
                  cause: error,
                },
              ).pipe(Effect.andThen(Effect.succeedNone)),
          }),
        );
        if (Option.isSome(inventory)) {
          for (const each of inventory.value.vms) {
            if (keep.has(each.vmId)) continue;
            yield* runner.removeChat(each.vmId).pipe(
              Effect.catchTags({
                RunnerUnavailableError: (error) =>
                  Effect.logWarning("Removing a leftover chat VM failed", {
                    vm: each.vmId,
                    cause: error,
                  }),
              }),
            );
          }
        }
        yield* sweep(true);
      }),
  };
});

export class RunnerService extends Context.Service<RunnerService, Effect.Success<typeof make>>()(
  "t45/runner/RunnerService",
) {
  static get layer() {
    return layer;
  }
}

const layer = Layer.effect(RunnerService, make);
