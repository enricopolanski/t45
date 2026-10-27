/**
 * Scripted HTTP responses for T45's chat delivery and recovery tests. The real OpenCode client
 * talks to these responses; no OpenCode server or agent runs. Imports and prompts are recorded
 * as sent, without filtering history or suppressing duplicate messages, so the fixture cannot
 * repair a mistake made by T45. This does not verify integration with a real OpenCode server.
 *
 * Each VM follows its boots on the fake runner: a VM the runner doesn't run doesn't answer, and a
 * new boot starts empty, as the runner's VMs keep nothing.
 */
import { Session } from "@opencode/client/effect";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

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
  title?: string;
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
  /** Prompt texts OpenCode refuses as invalid requests, with why. */
  readonly invalidPrompts: Map<string, string>;
  /** Prompt texts whose next send finds the VM's server not answering. */
  readonly unansweredPrompts: Set<string>;
  /** The messages T45 prompted with, in order, an id it sent again included. */
  readonly prompts: Array<{
    readonly chatId: string;
    readonly id: string;
    readonly text: string;
    readonly metadata?: unknown;
  }>;
  /** Files in VMs, by `<chatId>:<path relative to /work>`. */
  readonly files: Map<string, Uint8Array>;
  /** Forms T45 cancelled, by `<chatId>:<form id>`. */
  readonly cancelledForms: Array<string>;
  /** Answers T45 gave forms, by `<chatId>:<form id>`. */
  readonly formReplies: Map<string, Json>;
  /** Sessions T45 imported, by `<chatId>:<session id>`, with the ids of the messages it sent. */
  readonly imports: Map<string, ReadonlyArray<string>>;
  /** Sessions T45 interrupted, by `<chatId>:<session id>`. */
  readonly interrupts: Array<string>;
  /** Shell responses scripted by tests, by chat id. */
  readonly shells: Map<string, Array<Json>>;
  readonly removedShells: Array<string>;
  holdPrompt: Effect.Effect<void> | null;
  holdInboxCancel: Effect.Effect<void> | null;
  /** Open event streams, by chat id. */
  readonly streams: Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>;
  /** The runner whose boots the VMs follow. */
  readonly runner: FakeRunner;
  /** The boot of each VM the fake last answered for. */
  readonly boots: Map<string, string>;
  /** Numbers the ids of the items tests add. */
  next: number;
}

export const makeFakeOpenCode = (runner: FakeRunner): FakeOpenCode => ({
  sessions: new Map(),
  subagents: new Map(),
  invalidPrompts: new Map(),
  unansweredPrompts: new Set(),
  prompts: [],
  files: new Map(),
  cancelledForms: [],
  formReplies: new Map(),
  imports: new Map(),
  interrupts: [],
  shells: new Map(),
  removedShells: [],
  holdPrompt: null,
  holdInboxCancel: null,
  streams: new Map(),
  runner,
  boots: new Map(),
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
 * A chat's agent starts a subagent in a session of its own under its root. Returns its id, which
 * is `id` when given, as a VM's OpenCode takes any id it is asked for.
 */
export const chatSubagent = (fake: FakeOpenCode, chatId: string, id?: string) => {
  const parent = chatSession(fake, chatId);
  const sessionId = Session.ID.make(id ?? nextId(fake, "ses_sub"));
  fake.subagents.set(sessionId, { ...newSession(chatId, sessionId, parent.id), active: true });
  return sessionId;
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
  const id = nextId(fake, "msg_a");
  chatSession(fake, chatId, options.sessionId).items.push({
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "opencode-go", id: "test-model" },
    content: Array.from({ length: options.parts ?? 1 }, () => ({ type: "text", text })),
    time: options.streaming === true ? { created: at } : { created: at, completed: at + 1 },
  });
  return id;
};

/** A shell listed as running until T45 removes it; no command actually runs. */
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

/**
 * The chat's agent finishes its turn in its root session, or the subagent's `sessionId`. Returns
 * the id of the idle message that ends it.
 */
export const endTurn = (fake: FakeOpenCode, chatId: string, sessionId?: string) => {
  const session = chatSession(fake, chatId, sessionId);
  const id = nextId(fake, "msg_i");
  session.items.push({
    id,
    type: "idle",
    outcome: "succeeded",
    time: { created: NOW + fake.next * 1000 },
  });
  session.active = false;
  return id;
};

export const finishTurn = (fake: FakeOpenCode, chatId: string) => {
  const idle = endTurn(fake, chatId);
  emit(fake, chatId, "session.execution.succeeded", { sessionID: chatSession(fake, chatId).id });
  return idle;
};

export const failTurn = (fake: FakeOpenCode, chatId: string, message: string) => {
  const session = chatSession(fake, chatId);
  session.active = false;
  session.outcome = "failed";
  emit(fake, chatId, "session.execution.failed", {
    sessionID: session.id,
    error: { type: "provider", message },
  });
};

export const interruptTurn = (fake: FakeOpenCode, chatId: string) => {
  const session = chatSession(fake, chatId);
  session.active = false;
  session.outcome = "interrupted";
  emit(fake, chatId, "session.execution.interrupted", { sessionID: session.id, reason: "user" });
};

export const emptyInbox = (fake: FakeOpenCode, chatId: string) => {
  chatSession(fake, chatId).inbox.splice(0);
};

/** Whether inputs to the chat's root wait in its inbox, as while the agent is busy. */
export const hold = (fake: FakeOpenCode, chatId: string, held: boolean) => {
  const session = chatSession(fake, chatId);
  session.hold = held;
  if (held) return;
  for (const entry of session.inbox.splice(0)) deliver(session, entry);
};

const deliver = (session: FakeSession, entry: Json) => {
  const payload = entry.payload as Json;
  session.items.push({
    id: entry.id,
    type: entry.type,
    text: payload.text,
    ...(typeof payload.description === "string" ? { description: payload.description } : {}),
    ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
    time: { created: NOW },
  });
  session.active = true;
};

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

/** The VM's event streams end, as when the connection to it breaks; the VM keeps the rest. */
export const dropStreams = (fake: FakeOpenCode, chatId: string) => closeStreams(fake, chatId);

/** The VM loses everything it held, as when it dies: its sessions, its files, its streams. */
export const crash = (fake: FakeOpenCode, chatId: string) => {
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

/** Answers one request to the VM `chatId`'s OpenCode at `path`. */
const answer = (
  fake: FakeOpenCode,
  chatId: string,
  method: string,
  path: string,
  query: URLSearchParams,
  body: Json,
) => {
  if (method === "GET" && path === "/api/event") {
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
  }
  const read = /^\/api\/fs\/read\/(.+)$/u.exec(path);
  if (method === "GET" && read !== null) {
    const key = `${chatId}:${decodeURIComponent(read[1] ?? "")}`;
    const content = fake.files.get(key);
    return content === undefined
      ? json({ _tag: "FileNotFoundError", path: read[1], message: "No such file." }, 404)
      : new Response(content, { headers: { "content-type": "application/octet-stream" } });
  }
  if (method === "GET" && path === "/api/shell") {
    return json({ location: { directory: "/work" }, data: fake.shells.get(chatId) ?? [] });
  }
  const shell = /^\/api\/shell\/([^/]+)$/u.exec(path);
  if (method === "DELETE" && shell !== null) {
    const id = decodeURIComponent(shell[1] ?? "");
    fake.shells.set(
      chatId,
      (fake.shells.get(chatId) ?? []).filter((entry) => entry.id !== id),
    );
    fake.removedShells.push(`${chatId}:${id}`);
    return noContent();
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
  if (method === "PATCH" && rest === "") {
    if (typeof body.title === "string") session.title = body.title;
    return noContent();
  }
  if (method === "POST" && rest === "/prompt") {
    const id = String(body.id);
    const text = String(body.text);
    fake.prompts.push({
      chatId,
      id,
      text,
      ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
    });
    if (fake.unansweredPrompts.delete(text)) {
      return json({ error: "The chat's OpenCode did not answer." }, 502);
    }
    const invalid = fake.invalidPrompts.get(text);
    if (invalid !== undefined) return json({ _tag: "InvalidRequestError", message: invalid }, 400);
    const entry = {
      id,
      sessionID,
      type: "user",
      payload: { text, ...(body.metadata === undefined ? {} : { metadata: body.metadata }) },
      delivery: typeof body.delivery === "string" ? body.delivery : "steer",
      time: { created: NOW },
    };
    if (session.hold) session.inbox.push(entry);
    else deliver(session, entry);
    return json({ data: entry });
  }
  if (method === "POST" && rest === "/synthetic") {
    const entry = {
      id: typeof body.id === "string" ? body.id : nextId(fake, "msg_s"),
      sessionID,
      type: "synthetic",
      payload: {
        text: body.text,
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
      },
      delivery: typeof body.delivery === "string" ? body.delivery : "steer",
      time: { created: NOW },
    };
    // Without `resume`, it waits in the inbox for the session's next turn.
    if (body.resume === false || session.hold) session.inbox.push(entry);
    else deliver(session, entry);
    return json({ data: entry });
  }
  if (method === "POST" && rest === "/compact") {
    const id = nextId(fake, "msg_c");
    session.inbox.push({
      id,
      sessionID,
      type: "compaction",
      payload: {},
      delivery: "steer",
      time: { created: NOW },
    });
    return json({ data: session.inbox.at(-1) });
  }
  if (method === "POST" && rest === "/interrupt") {
    const interrupted = session.active;
    session.active = false;
    fake.interrupts.push(`${chatId}:${sessionID}`);
    return json({ interrupted });
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
  const replied = /^\/form\/([^/]+)\/reply$/u.exec(rest);
  if (method === "POST" && replied !== null) {
    const formId = replied[1] ?? "";
    const at = session.forms.indexOf(formId);
    if (at < 0) return json({ _tag: "FormNotFoundError", id: formId, message: "No form." }, 404);
    session.forms.splice(at, 1);
    fake.formReplies.set(`${chatId}:${formId}`, body.answer as Json);
    return noContent();
  }
  const cancelled = /^\/form\/([^/]+)$/u.exec(rest);
  if (method === "DELETE" && cancelled !== null) {
    const formId = cancelled[1] ?? "";
    const at = session.forms.indexOf(formId);
    if (at >= 0) session.forms.splice(at, 1);
    fake.cancelledForms.push(`${chatId}:${formId}`);
    return noContent();
  }
  throw new Error(`Unscripted OpenCode request: ${method} ${path}`);
};

/**
 * Whether the VM runs, following the fake runner's boots: a VM it doesn't run doesn't answer, and
 * a new boot starts empty.
 */
const running = (fake: FakeOpenCode, chatId: string) => {
  const boot = fake.runner.boots.get(chatId);
  if (boot === undefined) {
    crash(fake, chatId);
    fake.boots.delete(chatId);
    return false;
  }
  if (fake.boots.get(chatId) !== boot) {
    crash(fake, chatId);
    fake.boots.set(chatId, boot);
  }
  return true;
};

const takeHold = (fake: FakeOpenCode, method: string, path: string) => {
  if (method === "POST" && path.endsWith("/prompt")) {
    const held = fake.holdPrompt;
    fake.holdPrompt = null;
    return held;
  }
  if (method === "DELETE" && path.includes("/inbox/")) {
    const held = fake.holdInboxCancel;
    fake.holdInboxCancel = null;
    return held;
  }
  return null;
};

/** An `HttpClient` that answers as `fake`'s VMs' OpenCode servers. */
export const httpClient = (fake: FakeOpenCode) =>
  HttpClient.make((request, url) =>
    !url.pathname.includes("/opencode/")
      ? runnerResponse(fake.runner, request, url).pipe(
          Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
        )
      : Effect.gen(function* () {
          const routed = /^\/chats\/([^/]+)\/opencode(\/.*)$/u.exec(url.pathname);
          const held = takeHold(fake, request.method, routed?.[2] ?? "");
          if (held !== null) yield* held;
          const raw =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
          const body = (raw === "" ? {} : decodeJson(raw)) as Json;
          const chatId = decodeURIComponent(routed?.[1] ?? "");
          const response =
            routed === null
              ? json({ error: `unexpected ${url.pathname}` }, 500)
              : !running(fake, chatId)
                ? json({ error: "This VM isn't running." }, 503)
                : answer(fake, chatId, request.method, routed[2] ?? "", url.searchParams, body);
          return HttpClientResponse.fromWeb(request, response);
        }),
  );
