/**
 * Scripted HTTP responses for the OpenCode servers in T45's chat VMs. The real OpenCode client
 * talks to these responses; no OpenCode server or agent runs. Imports and prompts are recorded as
 * sent, so the fixture cannot repair a mistake made by T45. This does not verify integration with a
 * real OpenCode server.
 *
 * Each VM lives as long as the fake runner runs it: one the runner doesn't run doesn't answer, and
 * starting or removing it wipes what it held, as the runner's VMs keep nothing.
 */
import { Session } from "@opencode/client/effect";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";

import { type FakeRunner, respond as runnerResponse } from "./FakeRunner.testkit.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

type Json = Record<string, unknown>;

/** One of a VM's sessions, as OpenCode lists it. */
interface FakeSession {
  readonly id: string;
  readonly chatId: string;
  /** The session whose subagent runs in it. */
  readonly parentID?: string;
  readonly title?: string;
  readonly model?: unknown;
  outcome?: Session.Info["outcome"];
  /** Its history, encoded as OpenCode sends it, in OpenCode's order. */
  readonly items: Array<Json>;
  /** Whether OpenCode is running it now. */
  active: boolean;
  /** Question forms the agent asked and nobody answered. */
  readonly forms: Array<string>;
  /** Inputs admitted and not delivered yet, encoded as OpenCode lists them. */
  readonly inbox: Array<Json>;
  /** Whether inputs wait in the inbox, as while the agent is busy, instead of arriving at once. */
  hold: boolean;
}

export interface FakeOpenCode {
  /** Each VM's root session, by chat id, once T45 created or imported it. */
  readonly sessions: Map<string, FakeSession>;
  /** Subagents' sessions, by session id. */
  readonly subagents: Map<string, FakeSession>;
  /** Prompt texts whose next send finds the VM's server not answering. */
  readonly unansweredPrompts: Set<string>;
  /** The messages T45 prompted with, in order, across every VM. */
  readonly prompts: Array<{
    readonly chatId: string;
    readonly id: string;
    readonly text: string;
    readonly metadata?: unknown;
  }>;
  /** Told of each prompt's id, for `prompted`. */
  readonly promptListeners: Set<(id: string) => void>;
  /** The latest import of each session, by `<chatId>:<session id>`: the ids of its messages. */
  readonly imports: Map<string, ReadonlyArray<string>>;
  /** Files in VMs, by `<chatId>:<path relative to /work>`. */
  readonly files: Map<string, Uint8Array>;
  /** Answers T45 gave forms, by `<chatId>:<form id>`. */
  readonly formReplies: Map<string, Json>;
  /** Shells each VM lists, by chat id. */
  readonly shells: Map<string, Array<Json>>;
  /** VMs that don't answer until the runner starts them again. */
  readonly dead: Set<string>;
  /** Open event streams, by chat id. */
  readonly streams: Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>;
  /** The runner that runs the VMs. */
  readonly runner: FakeRunner;
  /** Numbers the ids of the items tests add. */
  next: number;
}

export const makeFakeOpenCode = (runner: FakeRunner): FakeOpenCode => ({
  sessions: new Map(),
  subagents: new Map(),
  unansweredPrompts: new Set(),
  prompts: [],
  promptListeners: new Set(),
  imports: new Map(),
  files: new Map(),
  formReplies: new Map(),
  shells: new Map(),
  dead: new Set(),
  streams: new Map(),
  runner,
  next: 1,
});

/** Back to no VMs, for the next test. */
export const reset = (fake: FakeOpenCode) => {
  for (const chatId of fake.streams.keys()) closeStreams(fake, chatId);
  Object.assign(fake, makeFakeOpenCode(fake.runner));
};

/** A chat VM's session: its root, or the subagent's session `sessionId`. */
const chatSession = (fake: FakeOpenCode, chatId: string, sessionId?: string) => {
  const session =
    sessionId === undefined ? fake.sessions.get(chatId) : fake.subagents.get(sessionId);
  if (session === undefined || session.chatId !== chatId) {
    throw new Error(`no session ${sessionId ?? "root"} in ${chatId}`);
  }
  return session;
};

const NOW = 1_790_000_000_000;

const nextId = (fake: FakeOpenCode, prefix: string) => `${prefix}${String(fake.next++)}`;

const newSession = (chatId: string, id: string, parentID?: string): FakeSession => ({
  id,
  chatId,
  ...(parentID === undefined ? {} : { parentID }),
  items: [],
  active: false,
  forms: [],
  inbox: [],
  hold: false,
});

/** Adds a message to a session and announces it, as OpenCode does once it starts writing one. */
const write = (fake: FakeOpenCode, session: FakeSession, item: Json) => {
  session.items.push(item);
  emit(fake, session.chatId, "session.text.started", {
    sessionID: session.id,
    assistantMessageID: item.id,
    ordinal: 0,
  });
  return String(item.id);
};

/**
 * A chat's agent asks a question in its root session, or the subagent's `sessionId`, and
 * OpenCode announces it. Returns the form's id.
 */
export const ask = (fake: FakeOpenCode, chatId: string, sessionId?: string) => {
  const session = chatSession(fake, chatId, sessionId);
  const id = nextId(fake, "frm_");
  session.forms.push(id);
  emit(fake, chatId, "form.created", { form: formInfo(session.id, id) });
  return id;
};

const formInfo = (sessionID: string, id: string) => ({
  id,
  sessionID,
  title: "Which year?",
  fields: [{ key: "year", type: "string" }],
});

/**
 * A chat's agent started a subagent in the background, which already finished its own turn but
 * whose report hasn't reached the root yet. Returns the subagent's session id.
 */
export const backgroundSubagent = (fake: FakeOpenCode, chatId: string) => {
  const root = chatSession(fake, chatId);
  const child = Session.ID.make(nextId(fake, "ses_sub"));
  fake.subagents.set(child, newSession(chatId, child, root.id));
  const at = NOW + fake.next * 1000;
  write(fake, root, {
    id: nextId(fake, "msg_a"),
    type: "assistant",
    agent: "build",
    model: { providerID: "opencode-go", id: "test-model" },
    content: [
      {
        type: "tool",
        id: nextId(fake, "call_"),
        name: "subagent",
        state: {
          status: "completed",
          input: {},
          content: [{ type: "text", text: "Started in the background." }],
          metadata: { status: "running", sessionID: child },
        },
        time: { created: at, completed: at },
      },
    ],
    time: { created: at, completed: at + 1 },
  });
  return child;
};

/** The background subagent's report reaches the root, which runs a turn on it. Returns its id. */
export const reportSubagent = (fake: FakeOpenCode, chatId: string, child: string) => {
  const root = chatSession(fake, chatId);
  const id = nextId(fake, "msg_s");
  root.items.push({
    id,
    type: "synthetic",
    text: "The research is done.",
    metadata: { source: "subagent", childID: child },
    time: { created: NOW + fake.next * 1000 },
  });
  emit(fake, chatId, "session.execution.succeeded", { sessionID: root.id });
  return id;
};

/**
 * A chat's agent writes an answer in its root session, or in the subagent's session `sessionId`,
 * as `parts` text parts (one by default); one still `streaming` has no completion yet. Returns the
 * message's id.
 */
export const answerText = (
  fake: FakeOpenCode,
  chatId: string,
  text: string,
  options: {
    readonly sessionId?: string;
    readonly streaming?: boolean;
    readonly parts?: number;
  } = {},
) => {
  const at = NOW + fake.next * 1000;
  return write(fake, chatSession(fake, chatId, options.sessionId), {
    id: nextId(fake, "msg_a"),
    type: "assistant",
    agent: "build",
    model: { providerID: "opencode-go", id: "test-model" },
    content: Array.from({ length: options.parts ?? 1 }, () => ({ type: "text", text })),
    time: options.streaming === true ? { created: at } : { created: at, completed: at + 1 },
  });
};

/** A shell the VM lists as running until `exitShell`; no command actually runs. */
export const runningShell = (fake: FakeOpenCode, chatId: string) => {
  const id = nextId(fake, "sh_");
  const shells = fake.shells.get(chatId) ?? [];
  shells.push({
    id,
    status: "running",
    command: "build",
    cwd: "/work",
    shell: "/bin/sh",
    file: "/tmp/output",
    metadata: {},
    time: { started: NOW },
  });
  fake.shells.set(chatId, shells);
  return id;
};

/** The shell `id` exits, and OpenCode announces it. */
export const exitShell = (fake: FakeOpenCode, chatId: string, id: string) => {
  for (const shell of fake.shells.get(chatId) ?? []) {
    if (shell.id === id) shell.status = "exited";
  }
  emit(fake, chatId, "shell.exited", { id, status: "exited", exit: 0 });
};

/**
 * The agent finishes its turn in the root, and OpenCode announces it. Returns the id of the idle
 * message that ends it.
 */
export const finishTurn = (fake: FakeOpenCode, chatId: string) => {
  const session = chatSession(fake, chatId);
  const id = nextId(fake, "msg_i");
  session.items.push({
    id,
    type: "idle",
    outcome: "succeeded",
    time: { created: NOW + fake.next * 1000 },
  });
  session.active = false;
  emit(fake, chatId, "session.execution.succeeded", { sessionID: session.id });
  return id;
};

/** The agent's turn in the root fails, and OpenCode announces it. */
export const failTurn = (fake: FakeOpenCode, chatId: string, message: string) => {
  const session = chatSession(fake, chatId);
  session.active = false;
  session.outcome = "failed";
  emit(fake, chatId, "session.execution.failed", {
    sessionID: session.id,
    error: { type: "provider", message },
  });
};

/** Whether inputs to the chat's root wait in its inbox, as while the agent is busy. */
export const hold = (fake: FakeOpenCode, chatId: string, held: boolean) => {
  const session = chatSession(fake, chatId);
  session.hold = held;
  if (held) return;
  for (const entry of session.inbox.splice(0)) deliver(fake, session, entry);
};

/** OpenCode makes an inbox entry the session's message, which starts a turn. */
const deliver = (fake: FakeOpenCode, session: FakeSession, entry: Json) => {
  const payload = entry.payload as Json;
  session.items.push({
    id: entry.id,
    type: entry.type,
    text: payload.text,
    ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
    time: { created: NOW },
  });
  session.active = true;
  emit(fake, session.chatId, "session.inbox.delivered", {
    sessionID: session.id,
    inboxID: entry.id,
  });
};

/** Waits until T45 prompted the message `id`, in any VM. */
export const prompted = (fake: FakeOpenCode, id: string) =>
  Effect.suspend(() =>
    fake.prompts.some((prompt) => prompt.id === id)
      ? Effect.void
      : Effect.callback<void>((resume) => {
          const told = (sent: string) => {
            if (sent !== id) return;
            fake.promptListeners.delete(told);
            resume(Effect.void);
          };
          fake.promptListeners.add(told);
          return Effect.sync(() => fake.promptListeners.delete(told));
        }),
  );

/**
 * OpenCode sends the event to the VM's open streams: `type` with `data`, durable unless it is a
 * delta or the server's own.
 */
export const emit = (fake: FakeOpenCode, chatId: string, type: string, data: Json) => {
  const id = nextId(fake, "evt_");
  const ephemeral =
    type.endsWith(".delta") ||
    type.startsWith("server.") ||
    type.startsWith("form.") ||
    type.startsWith("shell.");
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : chatId;
  const frame = frameOf({
    id,
    created: NOW,
    type,
    data,
    ...(ephemeral ? {} : { durable: { aggregateID: sessionID, seq: fake.next, version: 1 } }),
  });
  for (const stream of fake.streams.get(chatId) ?? []) stream.enqueue(frame);
};

const frameOf = (event: Json) => new TextEncoder().encode(`data: ${encodeJson(event)}\n\n`);

const closeStreams = (fake: FakeOpenCode, chatId: string) => {
  for (const stream of fake.streams.get(chatId) ?? []) {
    try {
      stream.close();
    } catch {
      // A stream its reader already cancelled is closed.
    }
  }
  fake.streams.delete(chatId);
};

/** Everything the VM held goes: its streams, sessions, shells and files. */
const wipe = (fake: FakeOpenCode, chatId: string) => {
  closeStreams(fake, chatId);
  fake.sessions.delete(chatId);
  fake.shells.delete(chatId);
  for (const [id, session] of fake.subagents) {
    if (session.chatId === chatId) fake.subagents.delete(id);
  }
  for (const key of fake.files.keys()) {
    if (key.startsWith(`${chatId}:`)) fake.files.delete(key);
  }
};

/** The VM dies: it loses everything it held and answers nothing until the runner starts it. */
export const crash = (fake: FakeOpenCode, chatId: string) => {
  wipe(fake, chatId);
  fake.dead.add(chatId);
};

/**
 * The VM's server stops answering requests until the runner starts it again; its event streams
 * stay open and it keeps what it held.
 */
export const hang = (fake: FakeOpenCode, chatId: string) => {
  fake.dead.add(chatId);
};

const json = (body: unknown, status = 200) =>
  new Response(encodeJson(body), { status, headers: { "content-type": "application/json" } });

const noContent = () => new Response(null, { status: 204 });

const sessionInfo = (session: FakeSession) => ({
  id: session.id,
  ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
  ...(session.title === undefined ? {} : { title: session.title }),
  ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
  projectID: "global",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: NOW, updated: NOW },
  location: { directory: "/work" },
});

const notFound = (sessionID: string) =>
  json({ _tag: "SessionNotFoundError", sessionID, message: "No such session." }, 404);

/** Only the forward capture pages T45 reads; the last message's id is the fixture's cursor. */
const listMessages = (session: FakeSession, query: URLSearchParams) => {
  const cursor = query.get("cursor");
  if (cursor === null ? query.get("order") !== "asc" : query.has("order")) {
    throw new Error(
      "The fixture only scripts ascending message capture with cursor-only continuation.",
    );
  }
  const limit = Number(query.get("limit"));
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("The fixture requires an explicit positive capture page size.");
  }
  const at = cursor === null ? -1 : session.items.findIndex((item) => item.id === cursor);
  if (cursor !== null && at < 0) throw new Error(`Unknown fixture message cursor: ${cursor}`);
  const page = session.items.slice(at + 1, at + 1 + limit);
  const last = page.at(-1);
  return json({
    data: page,
    cursor: last === undefined ? {} : { next: last.id },
  });
};

/** Opens an event stream to the VM, which says it is connected first. */
const openStream = (fake: FakeOpenCode, chatId: string) => {
  const connected = frameOf({
    id: nextId(fake, "evt_"),
    created: NOW,
    type: "server.connected",
    data: {},
  });
  const streams = fake.streams.get(chatId) ?? new Set();
  fake.streams.set(chatId, streams);
  let opened: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      opened = controller;
      streams.add(controller);
      controller.enqueue(connected);
    },
    cancel: () => {
      if (opened !== undefined) streams.delete(opened);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
};

/** Answers one request to the VM `chatId`'s OpenCode at `path`. */
const answer = (
  fake: FakeOpenCode,
  chatId: string,
  method: string,
  path: string,
  query: URLSearchParams,
  body: Json,
) => {
  if (method === "GET" && path === "/api/event") return openStream(fake, chatId);
  const read = /^\/api\/fs\/read\/(.+)$/u.exec(path);
  if (method === "GET" && read !== null) {
    const content = fake.files.get(`${chatId}:${decodeURIComponent(read[1] ?? "")}`);
    return content === undefined
      ? json({ _tag: "FileNotFoundError", path: read[1], message: "No such file." }, 404)
      : new Response(content, { headers: { "content-type": "application/octet-stream" } });
  }
  if (method === "GET" && path === "/api/shell") {
    return json({ location: { directory: "/work" }, data: fake.shells.get(chatId) ?? [] });
  }
  const root = fake.sessions.get(chatId);
  const sessions = [
    ...(root === undefined ? [] : [root]),
    ...[...fake.subagents.values()].filter((session) => session.chatId === chatId),
  ];
  if (method === "GET" && path === "/api/session/active") {
    return json({
      data: Object.fromEntries(
        sessions.filter((each) => each.active).map((each) => [each.id, { type: "running" }]),
      ),
    });
  }
  if (method === "GET" && path === "/api/session") {
    if (query.has("parentID")) throw new Error("The fixture only scripts the full session tree.");
    return json({ data: sessions.map(sessionInfo), cursor: {} });
  }
  if (method === "POST" && path === "/api/session") {
    const created: FakeSession = {
      ...newSession(chatId, String(body.id)),
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(body.model === undefined ? {} : { model: body.model }),
    };
    fake.sessions.set(chatId, created);
    return json({ data: sessionInfo(created) });
  }
  if (method === "POST" && path === "/api/experimental/session/import") {
    const info = body.info as Json;
    const id = String(info.id);
    if (sessions.some((each) => each.id === id)) {
      return json({ _tag: "ConflictError", message: "Session exists." }, 409);
    }
    const parentID = typeof info.parentID === "string" ? info.parentID : undefined;
    if (parentID !== undefined && !sessions.some((each) => each.id === parentID)) {
      return notFound(parentID);
    }
    const messages = body.messages as Array<Json>;
    const imported: FakeSession = {
      ...newSession(chatId, id, parentID),
      ...(typeof info.title === "string" ? { title: info.title } : {}),
      ...(info.model === undefined ? {} : { model: info.model }),
    };
    imported.items.push(...messages);
    if (parentID === undefined) fake.sessions.set(chatId, imported);
    else fake.subagents.set(id, imported);
    fake.imports.set(
      `${chatId}:${id}`,
      messages.map((message) => String(message.id)),
    );
    return json({ data: sessionInfo(imported) });
  }
  const route = /^\/api\/session\/([^/]+)(\/.*)?$/u.exec(path);
  if (route === null) throw new Error(`Unscripted OpenCode request: ${method} ${path}`);
  const [, encodedId = "", rest = ""] = route;
  const sessionID = decodeURIComponent(encodedId);
  const session = sessions.find((each) => each.id === sessionID);
  if (session === undefined) return notFound(sessionID);
  if (method === "GET" && rest === "") return json({ data: sessionInfo(session) });
  if (method === "POST" && rest === "/prompt") {
    const id = String(body.id);
    const text = String(body.text);
    fake.prompts.push({
      chatId,
      id,
      text,
      ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
    });
    for (const told of fake.promptListeners) told(id);
    if (fake.unansweredPrompts.delete(text)) {
      return json({ error: "The chat's OpenCode did not answer." }, 502);
    }
    const entry = {
      id,
      sessionID,
      type: "user",
      payload: { text, ...(body.metadata === undefined ? {} : { metadata: body.metadata }) },
      delivery: typeof body.delivery === "string" ? body.delivery : "steer",
      time: { created: NOW },
    };
    if (session.hold) session.inbox.push(entry);
    else deliver(fake, session, entry);
    return json({ data: entry });
  }
  if (method === "GET" && rest === "/inbox") return json({ data: session.inbox });
  const cancelledInput = /^\/inbox\/([^/]+)$/u.exec(rest);
  if (method === "DELETE" && cancelledInput !== null) {
    const inboxId = decodeURIComponent(cancelledInput[1] ?? "");
    const at = session.inbox.findIndex((item) => item.id === inboxId);
    if (at >= 0) session.inbox.splice(at, 1);
    return noContent();
  }
  if (method === "GET" && rest === "/message") return listMessages(session, query);
  const message = /^\/message\/([^/]+)$/u.exec(rest);
  if (method === "GET" && message !== null) {
    const messageID = decodeURIComponent(message[1] ?? "");
    const item = session.items.find((each) => each.id === messageID);
    return item === undefined
      ? json(
          { _tag: "MessageNotFoundError", sessionID, messageID, message: "No such message." },
          404,
        )
      : json({ data: item });
  }
  if (method === "GET" && rest === "/form") {
    return json({ data: session.forms.map((id) => formInfo(sessionID, id)) });
  }
  const form = /^\/form\/([^/]+)(\/reply)?$/u.exec(rest);
  if (form !== null && (method === "POST" ? form[2] !== undefined : method === "DELETE")) {
    const formId = form[1] ?? "";
    const at = session.forms.indexOf(formId);
    if (at < 0) return json({ _tag: "FormNotFoundError", id: formId, message: "No form." }, 404);
    session.forms.splice(at, 1);
    if (method === "POST") {
      fake.formReplies.set(`${chatId}:${formId}`, body.answer as Json);
      emit(fake, chatId, "form.replied", { id: formId, sessionID, answer: body.answer });
    } else {
      emit(fake, chatId, "form.cancelled", { id: formId, sessionID });
    }
    return noContent();
  }
  throw new Error(`Unscripted OpenCode request: ${method} ${path}`);
};

/** An `HttpClient` that answers as the fake runner and its VMs' OpenCode servers. */
export const httpClient = (fake: FakeOpenCode) =>
  HttpClient.make((request, url) =>
    Effect.sync(() => {
      const routed = /^\/chats\/([^/]+)\/opencode(\/.*)$/u.exec(url.pathname);
      if (routed === null) {
        const response = runnerResponse(fake.runner, request, url);
        // A VM the runner starts or removes keeps nothing of what it held.
        const vm = /^\/chats\/([^/]+)$/u.exec(url.pathname);
        if (vm !== null && response.status === 204) {
          const chatId = decodeURIComponent(vm[1] ?? "");
          wipe(fake, chatId);
          fake.dead.delete(chatId);
        }
        return HttpClientResponse.fromWeb(request, response);
      }
      const chatId = decodeURIComponent(routed[1] ?? "");
      const raw =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const response =
        fake.runner.down || fake.dead.has(chatId) || !fake.runner.chats.has(chatId)
          ? json({ error: "The chat's VM isn't running." }, 502)
          : answer(
              fake,
              chatId,
              request.method,
              routed[2] ?? "",
              url.searchParams,
              (raw === "" ? {} : decodeJson(raw)) as Json,
            );
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
