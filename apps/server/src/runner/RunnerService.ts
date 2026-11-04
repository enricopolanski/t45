/**
 * Runs chats' executions.
 * An execution starts a new VM from the chat's agent, puts back /work and imports the conversation
 * as the last finished execution left them, sends the inputs the agent hasn't taken, and streams and
 * stores what OpenCode writes. Once OpenCode is done, including background work, it saves /work,
 * commits what it wrote and removes the VM. An execution that doesn't finish (stopped, failed, or
 * its VM lost) has what it wrote discarded, so the next one sends its inputs again; a lost VM starts
 * the next one at once.
 * Nothing waits on a VM but its execution: sends save inputs and signal it, and a running one
 * delivers what it didn't send yet. Answers, dismissals and cancels use the running VM directly.
 */
import { AbsolutePath, Form, Location, Session, SessionMessage } from "@opencode/client/effect";
import type { OpenCodeEvent } from "@opencode/protocol/groups/event";
import { hasT45Tools } from "@t45/core/agentTools";
import { type ChatId, type InputId, titleOf } from "@t45/contracts/models/Chat";
import { InputMetadata } from "@t45/contracts/resources/Chats";
import { type RunConfig, RunnerHttpApi } from "@t45/contracts/resources/RunnerVms";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { HttpClientRequest } from "effect/http";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as RcMap from "effect/RcMap";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";

import * as AgentRepository from "../agents/AgentRepository.ts";
import * as SkillRepository from "../agents/SkillRepository.ts";
import * as AttachmentRepository from "../attachments/AttachmentRepository.ts";
import { inputMessageId, rootSessionId } from "../chats/ChatIds.ts";
import { ChatEvents } from "../chats/ChatEvents.ts";
import * as ChatRepository from "../chats/ChatRepository.ts";
import * as OpenCode2Client from "../opencode/OpenCode2Client.ts";
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
    startChat: (input: { readonly chatId: string; readonly chat: RunConfig }) =>
      client
        .startChat({ params: { vmId: input.chatId }, payload: input.chat })
        .pipe(Effect.timeout("3 minutes"), Effect.catchTags(unavailable("startChat"))),
    getChatWorkspace: (chatId: string) =>
      client
        .getChatWorkspace({ params: { vmId: chatId } })
        .pipe(Effect.timeout("2 minutes"), Effect.catchTags(unavailable("getChatWorkspace"))),
    putChatWorkspace: (input: { readonly chatId: string; readonly content: Uint8Array }) =>
      client
        .putChatWorkspace({ params: { vmId: input.chatId }, payload: input.content })
        .pipe(Effect.timeout("2 minutes"), Effect.catchTags(unavailable("putChatWorkspace"))),
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
        .pipe(Effect.timeout("2 minutes"), Effect.catchTags(unavailable("putChatFile"))),
    removeChat: (chatId: string) =>
      client
        .removeChat({ params: { vmId: chatId } })
        .pipe(Effect.timeout("60 seconds"), Effect.catchTags(unavailable("removeChat"))),
    chatServer: (chatId: string) => ({
      url: `${baseUrl}/chats/${encodeURIComponent(chatId)}/opencode`,
      password: Redacted.value(token),
    }),
  };
});

type OpenCodeClient = OpenCode2Client.OpenCode2Api["client"];

/** The VM of a chat's running execution, for answers and dismissals. */
export interface ChatVm {
  readonly client: OpenCodeClient;
  /** The chat's root session. */
  readonly root: Session.ID;
  /** Puts files sent to the chat under the VM's `attachments/`. */
  readonly putFiles: (
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, RunnerUnavailableError>;
}

/** A run calls its consumer before continuing, while its VM and files still exist. */
type ExecutionResult = { readonly chatId: ChatId } & (
  | {
      readonly type: "messages";
      readonly messages: ReadonlyArray<SessionMessage.Info>;
      readonly read: (path: string) => Effect.Effect<Uint8Array | null>;
    }
  | { readonly type: "ended"; readonly status: "failed" | "interrupted" | null }
);
type Receive = (result: ExecutionResult) => Effect.Effect<void>;
type Run = (receive: Receive) => Effect.Effect<void>;

/** The event stream ended, or never said it was connected: the VM is out of reach. */
class StreamEndedError extends Schema.TaggedError<StreamEndedError>()("StreamEndedError", {}) {}

/** Batches events this long before reading what they changed. */
const CAPTURE_BATCH = "150 millis";
const CONNECT_TIMEOUT = "60 seconds";
/** How long an answer, dismissal or cancel waits for the VM. */
const VM_TIMEOUT = "1 minute";
/** Messages per page when capture reads a session. */
const CAPTURE_PAGE = 200;

/** What signals an execution: an input saved, OpenCode events, or the event stream ending. */
type Signal = "inputs" | "events" | "ended";

interface Execution {
  readonly signal: Queue.Queue<Signal>;
  fiber: Fiber.Fiber<unknown, unknown> | null;
  /** The attempt's VM, once its root session exists. */
  vm: ChatVm | null;
  /** The inputs the attempt sent its VM, by id. */
  readonly sent: Set<string>;
  readonly questions: boolean;
}

/** What events marked to read again: sessions to capture, with the messages events named. */
interface Marks {
  tree: boolean;
  forms: boolean;
  readonly sessions: Map<string, Set<string>>;
}

const noMarks = (): Marks => ({ tree: false, forms: false, sessions: new Map() });

/** Session events that change nothing T45 keeps. */
const IGNORED = new Set([
  "session.inbox.enqueued",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.progress",
  "session.compaction.delta",
  "session.step.streamed",
  "session.viewed",
  "session.metadata.updated",
  "session.permissions",
  "session.usage.updated",
  "session.moved",
]);

/** Marks what an event may have changed; false for events that change nothing T45 keeps. */
const mark = (marks: Marks, event: OpenCodeEvent): boolean => {
  const type = event.type;
  if (type.startsWith("form.")) {
    marks.forms = true;
    return true;
  }
  if (type.startsWith("shell.")) return true;
  if (!type.startsWith("session.") || IGNORED.has(type)) return false;
  if (!("sessionID" in event.data) || typeof event.data.sessionID !== "string") return false;
  if (type === "session.created" || type === "session.deleted" || type === "session.renamed") {
    marks.tree = true;
    return true;
  }
  const touched = marks.sessions.get(event.data.sessionID) ?? new Set<string>();
  const id =
    ("assistantMessageID" in event.data ? event.data.assistantMessageID : undefined) ??
    ("inboxID" in event.data ? event.data.inboxID : undefined);
  if (typeof id === "string") touched.add(id);
  marks.sessions.set(event.data.sessionID, touched);
  return true;
};

/**
 * Whether a failure means the VM is out of reach, which a new attempt gets past: the runner didn't
 * answer, the event stream ended, or a request found no connection or a 502 to 504 from the
 * runner's proxy. OpenCode's client wraps such a failure in a `ClientError`.
 */
const isConnectionLost = (error: unknown): boolean => {
  if (Predicate.isTagged(error, "RunnerUnavailableError")) return true;
  if (Predicate.isTagged(error, "StreamEndedError")) return true;
  const failure =
    Predicate.isTagged(error, "ClientError") && "cause" in error ? error.cause : error;
  if (!HttpClientError.isHttpClientError(failure)) return false;
  const reason = failure.reason;
  if (reason._tag === "TransportError") return true;
  const status = "response" in reason ? reason.response.status : 0;
  return status >= 502 && status <= 504;
};

const encodeInputMetadata = Schema.encodeSync(InputMetadata);

const location = Location.PublicRef.make({
  directory: AbsolutePath.make(OpenCode2Client.WORK_DIRECTORY),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ChatRepository.ChatRepository;
  const changes = yield* ChatEvents;
  const runner = yield* makeConnection;
  const agents = yield* AgentRepository.AgentRepository;
  const skillRepository = yield* SkillRepository.SkillRepository;
  const files = yield* AttachmentRepository.AttachmentRepository;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtime = path.resolve(
    import.meta.dirname,
    import.meta.filename.endsWith(".ts") ? "../../dist/runtime" : "runtime",
  );
  const toolFiles = yield* fileSystem.readDirectory(runtime).pipe(
    Effect.flatMap((files) =>
      Effect.forEach(
        files.filter((file) => file.endsWith(".mjs")),
        (file) =>
          fileSystem
            .readFileString(path.join(runtime, file))
            .pipe(Effect.map((source) => [`runtime/${file}`, source] as const)),
      ),
    ),
    Effect.map((files) => Object.fromEntries(files)),
    Effect.orDie,
  );
  const httpClient = yield* HttpClient.HttpClient;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const runs = yield* Queue.unbounded<Run>();

  /** The running execution of each chat; the registry lock keeps it to one, and runs no SQL. */
  const executions = new Map<ChatId, Execution>();
  const registry = yield* Semaphore.make(1);
  // Held while an execution reads inputs and sends them, and while one is cancelled.
  const inputLocks = yield* RcMap.make({ lookup: () => Semaphore.make(1) });
  const withInputs = <A, E, R>(chatId: ChatId, effect: Effect.Effect<A, E, R>) =>
    RcMap.get(inputLocks, chatId).pipe(
      Effect.flatMap((lock) => lock.withPermit(effect)),
      Effect.scoped,
    );

  const publish = (chatId: ChatId, kind: "chat" | "sessions" | "inputs" | "questions") =>
    changes.publish({ kind, chatId });

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

  /** Drops what an execution that didn't finish wrote; the next one sends its inputs again. */
  const discard = (chatId: ChatId) =>
    Effect.gen(function* () {
      if (yield* repository.discardUncommitted(chatId)) {
        yield* changes.publish({ chatId, kind: "replaced" });
      }
    });

  /** Checks new inputs and commits the conversation and its task outcome together. */
  const end = (
    chatId: ChatId,
    status: "failed" | "interrupted" | null,
    receive: Receive,
    completion?: { readonly sent: ReadonlySet<string>; readonly workspace: Uint8Array },
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (completion !== undefined) {
            const pending = yield* repository.pendingInputs(chatId);
            if (pending.some((input) => !completion.sent.has(input.inputId))) return false;
          }
          if (!(yield* repository.setStatus(chatId, status, yield* nowIso))) return false;
          if (completion !== undefined) {
            yield* repository.saveWorkspace(chatId, completion.workspace);
            yield* repository.commit(chatId);
          }
          yield* receive({ chatId, type: "ended", status });
          yield* sql.afterCommit(publish(chatId, "chat"));
          return true;
        }),
      )
      .pipe(Effect.orDie);

  /**
   * One attempt at the chat's execution, from a new VM until OpenCode is done. Fails when the VM
   * is out of reach, which starts the execution again.
   */
  const attempt = Effect.fnUntraced(function* (
    chatId: ChatId,
    execution: Execution,
    receive: Receive,
  ) {
    execution.vm = null;
    execution.sent.clear();
    yield* Queue.clear(execution.signal);
    const chat = yield* repository.get(chatId);
    if (chat?.status !== "running" && chat?.status !== "waiting") return;
    const agent = yield* agents.get(chat.agentId).pipe(
      Effect.filterOrFail(
        (agent) => agent !== null,
        () => "A chat must refer to an agent.",
      ),
      Effect.orDie,
    );
    const skills = yield* skillRepository.listForAgent(agent.id);
    const setup = {
      agent: {
        ...Struct.pick(agent, ["instructions", "mcpServers", "permissions"]),
        files: { ...agent.files, ...(hasT45Tools(agent.mcpServers) ? toolFiles : {}) },
        skills: Object.fromEntries(
          skills.map((skill) => [
            skill.name,
            Struct.pick(skill, ["name", "description", "content", "files"]),
          ]),
        ),
      },
    } satisfies RunConfig;

    yield* discard(chatId);
    if (yield* repository.setStatus(chatId, "running", null)) yield* publish(chatId, "chat");

    // Removed however the attempt ends, even when starting it failed halfway.
    yield* Effect.addFinalizer(() =>
      runner.removeChat(chatId).pipe(
        Effect.catchTags({
          RunnerUnavailableError: (error) =>
            Effect.logWarning("Removing a chat's VM failed; the next start removes it", {
              chatId,
              cause: error,
            }),
        }),
      ),
    );
    yield* runner.startChat({ chatId, chat: setup });
    const endpoint = runner.chatServer(chatId);
    const api = yield* OpenCode2Client.connect({
      baseUrl: endpoint.url,
      password: endpoint.password,
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    const client = api.client;
    const root = rootSessionId(chatId);

    // The stream only marks what to read again and forwards streamed text, so it never falls
    // behind; it starts before anything is sent, so nothing that changes after is missed.
    let marks = noMarks();
    let notified = false;
    const connected = yield* Deferred.make<void, StreamEndedError>();
    yield* (yield* api.events).pipe(
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
        if (!mark(marks, event) || notified) return Effect.void;
        notified = true;
        return Queue.offer(execution.signal, "events");
      }),
      Effect.exit,
      Effect.tap((exit) =>
        Exit.isFailure(exit)
          ? Effect.logInfo("A chat's event stream ended", { chatId, cause: exit.cause })
          : Effect.void,
      ),
      Effect.andThen(Deferred.fail(connected, new StreamEndedError())),
      Effect.andThen(Queue.offer(execution.signal, "ended")),
      Effect.forkScoped,
    );
    yield* Deferred.await(connected).pipe(
      Effect.timeoutOrElse({ duration: CONNECT_TIMEOUT, orElse: () => new StreamEndedError() }),
    );

    const workspace = yield* repository.readWorkspace(chatId);
    if (workspace !== null) {
      yield* runner.putChatWorkspace({ chatId, content: workspace });
    }
    // The saved /work leaves out attachments/, so every file sent to the chat goes back in.
    yield* Effect.forEach(yield* files.boundTo(chatId), (id) => putFile(chatId, id), {
      discard: true,
    });
    // The conversation as the last finished execution left it, parents before their children.
    const model = OpenCode2Client.modelRef(agent.model);
    const rootInfo = { title: titleOf(chat), ...(model === undefined ? {} : { model }) };
    const permissions = OpenCode2Client.sessionRules({
      questions: execution.questions,
    });
    const stored = (yield* repository.sessions(chatId)).map((session) => ({
      ...session,
      id: session.sessionId,
      parentID: session.parentSessionId,
    }));
    if (!stored.some((session) => session.id === root)) {
      yield* client.session.create({ id: root, ...rootInfo, location, permissions });
    }
    for (const session of [
      ...stored.filter((session) => session.id === root),
      ...OpenCode2Client.sessionsUnder(root, stored),
    ]) {
      yield* client.session.import({
        info: { ...session.info, permissions, ...(session.id === root ? rootInfo : {}) },
        messages: yield* repository.history(chatId, session.sessionId),
        location,
      });
    }
    execution.vm = {
      client,
      root,
      putFiles: (attachmentIds) =>
        Effect.forEach(attachmentIds, (id) => putFile(chatId, id), { discard: true }),
    };

    const readFile = (path: string) => api.readFile(path).pipe(Effect.orElseSucceed(() => null));
    // The chat's sessions this VM holds, and what capture saw of each: its paging cursor, and
    // whether each message it read was settled.
    const known = new Set<string>([root]);
    const cursors = new Map<string, string>();
    const seen = new Map<string, Map<string, boolean>>();
    // Per subagent session, the background launches the agent started (by tool call) and the
    // reports that reached their parent (by message); a session the agent continues launches again.
    const launches = new Map<string, Set<string>>();
    const reports = new Map<string, Set<string>>();
    const add = (map: Map<string, Set<string>>, child: string, id: string) =>
      map.set(child, (map.get(child) ?? new Set()).add(id));

    /** Sends the inputs the agent hasn't taken and this VM doesn't have yet, in order. */
    const deliver = withInputs(
      chatId,
      Effect.gen(function* () {
        for (const input of yield* repository.pendingInputs(chatId)) {
          if (execution.sent.has(input.inputId)) continue;
          yield* Effect.forEach(input.payload.attachments, (file) => putFile(chatId, file.id), {
            discard: true,
          });
          yield* client.session.prompt({
            sessionID: root,
            id: inputMessageId(chatId, input.inputId),
            text: PromptService.format(input.payload),
            metadata: encodeInputMetadata({ t45: input.payload }),
            delivery: "queue",
          });
          execution.sent.add(input.inputId);
        }
      }),
    );

    /** Keeps the root's sessions and what descends from it. */
    const readTree = Effect.gen(function* () {
      const all = yield* OpenCode2Client.listSessions(client).pipe(Stream.runCollect);
      let changed = false;
      for (const info of [
        ...all.filter((info) => info.id === root),
        ...OpenCode2Client.sessionsUnder(root, all),
      ]) {
        known.add(info.id);
        const parentSessionId = info.id === root ? null : (info.parentID ?? null);
        changed =
          (yield* repository.putSession(chatId, { sessionId: info.id, parentSessionId, info })) ||
          changed;
      }
      if (changed) yield* publish(chatId, "sessions");
    });

    /** Pages a session forward from where capture stood, and reads again what may have changed. */
    const captureSession = (sessionId: string, touched: ReadonlySet<string>) =>
      Effect.gen(function* () {
        const sessionID = Session.ID.make(sessionId);
        const messages: Array<SessionMessage.Info> = [];
        let cursor = cursors.get(sessionId);
        while (true) {
          const page = yield* client.message.list(
            cursor === undefined
              ? { sessionID, order: "asc", limit: CAPTURE_PAGE }
              : { sessionID, cursor, limit: CAPTURE_PAGE },
          );
          messages.push(...page.data);
          if (page.cursor.next === undefined) break;
          cursor = page.cursor.next;
          if (page.data.length < CAPTURE_PAGE) break;
        }
        if (cursor !== undefined) cursors.set(sessionId, cursor);
        const settled = seen.get(sessionId) ?? new Map<string, boolean>();
        seen.set(sessionId, settled);
        const read = new Set<string>(messages.map((message) => message.id));
        for (const [id, isSettled] of settled) {
          if (read.has(id) || (isSettled && !touched.has(id))) continue;
          const message = yield* client.session.message
            .get({ sessionID, messageID: SessionMessage.ID.make(id) })
            .pipe(
              Effect.asSome,
              Effect.catchTags({ MessageNotFoundError: () => Effect.succeedNone }),
            );
          if (Option.isSome(message)) messages.push(message.value);
        }
        if (messages.length === 0) return;
        for (const message of messages) {
          settled.set(message.id, ChatRepository.isSettled(message));
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
              if (typeof child === "string") add(launches, child, part.id);
            }
          } else if (message.type === "synthetic" && message.metadata?.["source"] === "subagent") {
            const child = message.metadata["childID"];
            if (typeof child === "string") add(reports, child, message.id);
          }
        }
        const saved = yield* repository.saveMessages(chatId, sessionId, messages);
        if (saved.inputsTaken) yield* publish(chatId, "inputs");
        if (saved.messageIds.length === 0) return;
        const written = new Set(saved.messageIds);
        yield* receive({
          chatId,
          type: "messages",
          messages: messages.filter((message) => written.has(message.id)),
          read: readFile,
        });
        yield* changes.publish({
          chatId,
          kind: "messages",
          sessionId,
          messageIds: saved.messageIds,
        });
      }).pipe(
        Effect.catchTags({
          // A subagent's session removed inside the VM keeps what capture saw of it.
          SessionNotFoundError: (error) =>
            sessionId === root ? Effect.fail(error) : Effect.sync(() => known.delete(sessionId)),
        }),
      );

    const readForms = Effect.gen(function* () {
      const forms: Array<Form.Info> = [];
      for (const sessionId of known) {
        const listed = yield* client.session.form
          .list({ sessionID: sessionId })
          .pipe(Effect.catchTags({ SessionNotFoundError: () => Effect.succeed([]) }));
        forms.push(...listed);
      }
      if (yield* repository.setQuestions(chatId, forms, yield* nowIso)) {
        yield* publish(chatId, "questions");
      }
      const status = forms.length > 0 ? "waiting" : "running";
      if (yield* repository.setStatus(chatId, status, null)) yield* publish(chatId, "chat");
    });

    const capture = (marked: Marks) =>
      Effect.gen(function* () {
        if ([...marked.sessions.keys()].some((sessionId) => !known.has(sessionId))) {
          marked.tree = true;
        }
        if (marked.tree) yield* readTree;
        for (const [sessionId, touched] of marked.sessions) {
          if (known.has(sessionId)) yield* captureSession(sessionId, touched);
        }
        if (marked.forms) yield* readForms;
      });

    /**
     * Whether OpenCode is done, by its own account: no session running, no
     * shell running, nothing waiting in an inbox, and every background subagent reported.
     */
    const done = Effect.gen(function* () {
      if (Object.keys(yield* client.session.active()).length > 0) return false;
      const shells = yield* client.shell.list({
        location: { directory: OpenCode2Client.WORK_DIRECTORY },
      });
      if (shells.data.some((shell) => shell.status === "running")) return false;
      for (const sessionId of known) {
        const inbox = yield* client.session.inbox
          .list({ sessionID: Session.ID.make(sessionId) })
          .pipe(Effect.catchTags({ SessionNotFoundError: () => Effect.succeed([]) }));
        if (inbox.length > 0) return false;
      }
      return [...launches].every(([child, ids]) => (reports.get(child)?.size ?? 0) >= ids.size);
    });

    /**
     * Reads every session again once OpenCode says it's done: what it wrote before is stored, even
     * when the events naming it haven't arrived yet.
     */
    const captureAll = Effect.gen(function* () {
      yield* readTree;
      yield* capture({
        ...noMarks(),
        forms: true,
        sessions: new Map([...known].map((sessionId) => [sessionId, new Set<string>()])),
      });
    });

    /**
     * Saves /work and ends the execution with the root's outcome, committing what it wrote; false
     * when an input came in since the last delivery, which this execution sends first.
     */
    const finish = Effect.gen(function* () {
      const info = yield* client.session.get({ sessionID: root });
      const status =
        info.outcome === "failed"
          ? ("failed" as const)
          : info.outcome === "interrupted"
            ? ("interrupted" as const)
            : null;
      const content = yield* runner.getChatWorkspace(chatId);
      return yield* end(chatId, status, receive, { sent: execution.sent, workspace: content });
    });

    let marked: Marks = { ...noMarks(), tree: true, forms: true };
    while (true) {
      yield* deliver;
      yield* capture(marked);
      if (yield* done) {
        yield* captureAll;
        if ((yield* done) && (yield* finish)) {
          execution.vm = null;
          return;
        }
      }
      const first = yield* Queue.take(execution.signal);
      if (first === "events") yield* Effect.sleep(CAPTURE_BATCH);
      const signals = new Set([first, ...(yield* Queue.clear(execution.signal))]);
      notified = false;
      if (signals.has("ended")) return yield* new StreamEndedError();
      marked = marks;
      marks = noMarks();
    }
  });

  /** Runs attempts until one finishes; a lost VM starts a new one, less and less often. */
  const execute = (chatId: ChatId, execution: Execution, receive: Receive) =>
    Effect.gen(function* () {
      let failures = 0;
      while (true) {
        const exit = yield* attempt(chatId, execution, receive).pipe(Effect.scoped, Effect.exit);
        if (Exit.isSuccess(exit)) return;
        const reached = execution.vm !== null;
        execution.vm = null;
        const error = Cause.findErrorOption(exit.cause);
        if (Option.isNone(error) || !isConnectionLost(error.value)) {
          // Anything else, such as a VM the runner refuses, would fail the same way again.
          yield* Effect.logError("A chat's execution failed; it waits for the chat's next input", {
            chatId,
            cause: exit.cause,
          });
          yield* discard(chatId);
          yield* end(chatId, "failed", receive);
          return;
        }
        failures = reached ? 1 : failures + 1;
        yield* Effect.logWarning("A chat's VM was lost; its execution starts again", {
          chatId,
          cause: exit.cause,
        });
        if (failures > 1) {
          yield* Effect.sleep(`${Math.min(30, 2 ** Math.min(failures - 2, 5))} seconds`);
        }
      }
    });

  const release = (chatId: ChatId, execution: Execution) =>
    Effect.sync(() => {
      if (executions.get(chatId) === execution) executions.delete(chatId);
    });

  /** Starts the chat's execution unless one runs; a running one delivers what it didn't send. */
  const processInputs = (
    chatId: ChatId,
    options: { readonly questions: boolean },
  ): Effect.Effect<void> =>
    registry
      .withPermit(
        Effect.gen(function* () {
          const running = executions.get(chatId);
          if (running !== undefined) return yield* Queue.offer(running.signal, "inputs");
          const execution: Execution = {
            signal: yield* Queue.unbounded<Signal>(),
            fiber: null,
            vm: null,
            sent: new Set(),
            questions: options.questions,
          };
          executions.set(chatId, execution);
          yield* Queue.offer(runs, (receive) =>
            Effect.gen(function* () {
              const claimed = yield* Effect.withFiberSucceed((fiber) => {
                if (executions.get(chatId) !== execution) return false;
                execution.fiber = fiber;
                return true;
              });
              if (!claimed) return;
              yield* execute(chatId, execution, receive);
              yield* release(chatId, execution);
              // An input saved as the execution ended needs a new one.
              const chat = yield* repository.get(chatId);
              if (chat?.status === "running" || chat?.status === "waiting")
                yield* processInputs(chatId, execution);
            }).pipe(
              Effect.ensuring(release(chatId, execution)),
              Effect.tapCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.logError("A chat's execution stopped", { chatId, cause }),
              ),
            ),
          );
        }),
      )
      .pipe(Effect.asVoid);

  // Construction clears leftovers before any caller can start a new execution.
  const inventory = yield* runner.inventory.pipe(
    Effect.map((inventory) => inventory.vms),
    Effect.catchTags({
      RunnerUnavailableError: (error) =>
        Effect.logWarning("Listing the runner's VMs failed; leftovers wait for the next start", {
          cause: error,
        }).pipe(Effect.as([])),
    }),
  );
  for (const each of inventory) {
    yield* runner.removeChat(each.vmId).pipe(
      Effect.catchTags({
        RunnerUnavailableError: (error) =>
          Effect.logWarning("Removing a leftover chat VM failed", { vm: each.vmId, cause: error }),
      }),
    );
  }
  return {
    models: runner.models,
    processInputs,
    runs: Stream.fromQueue(runs),
    /**
     * Ends the chat's execution and removes its VM, discarding what it wrote as when the VM is
     * lost: the next execution sends its inputs again. Never call it from the chat's own
     * execution, which it waits for.
     */
    stop: (chatId: ChatId) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.sync(() => {
          const execution = executions.get(chatId);
          if (execution?.fiber === null) executions.delete(chatId);
          return execution?.fiber ?? null;
        });
        if (fiber !== null) yield* Fiber.interrupt(fiber);
        yield* discard(chatId);
        if (yield* repository.setStatus(chatId, "interrupted", null)) {
          yield* publish(chatId, "chat");
        }
        yield* publish(chatId, "inputs");
      }),
    /** Runs `use` on the VM of the chat's running execution; none when nothing runs. */
    withVm: <A, E>(chatId: ChatId, use: (vm: ChatVm) => Effect.Effect<A, E>) =>
      Effect.suspend(() => {
        const vm = executions.get(chatId)?.vm ?? null;
        return vm === null
          ? Effect.succeedNone
          : use(vm).pipe(Effect.asSome, Effect.timeout(VM_TIMEOUT));
      }),
    /**
     * Cancels an input the agent hasn't taken, taking it back from the running VM; false when the
     * agent already took it.
     */
    cancel: (chatId: ChatId, inputId: InputId) =>
      withInputs(
        chatId,
        Effect.gen(function* () {
          const pending = yield* repository.pendingInputs(chatId);
          if (!pending.some((input) => input.inputId === inputId)) return false;
          const execution = executions.get(chatId);
          const vm = execution?.vm ?? null;
          if (vm !== null && execution?.sent.has(inputId) === true) {
            const id = inputMessageId(chatId, inputId);
            yield* vm.client.session.inbox.cancel({ sessionID: vm.root, inboxID: id });
            const taken = yield* vm.client.session.message
              .get({ sessionID: vm.root, messageID: id })
              .pipe(
                Effect.as(true),
                Effect.catchTags({ MessageNotFoundError: () => Effect.succeed(false) }),
              );
            if (taken) return false;
          }
          return yield* repository.deletePending(chatId, inputId);
        }),
      ).pipe(Effect.timeout(VM_TIMEOUT)),
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
