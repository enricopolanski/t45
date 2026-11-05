/**
 * Scripted VMs: a fake `Sandbox`, and an `HttpClient` that answers each VM's OpenCode at its url as
 * the real client expects. No OpenCode server or agent runs; a saved disk carries a VM's files and
 * sessions to the VM that boots on it.
 */
import { Form } from "@opencode/client/effect";
import type { RunRequest } from "@t45/contracts/resources/Runner";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { Sandbox, SandboxError } from "./Sandbox.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

type Json = Record<string, unknown>;

interface FakeSession {
  readonly id: string;
  /** As the runner created it. */
  readonly info: Json;
  /** Encoded as OpenCode sends them. */
  readonly items: Array<Json>;
  outcome?: "failed";
  active: boolean;
  readonly forms: Array<string>;
  readonly inbox: Array<Json>;
  /** Inputs wait in the inbox, as while the agent is busy. */
  hold: boolean;
}

/** Every start is a new VM. */
interface Vm {
  readonly id: string;
  readonly url: string;
  readonly agent: RunRequest["agent"];
  /** A lost or removed VM's OpenCode stops answering. */
  state: "up" | "lost" | "removed";
  readonly booted: Uint8Array | null;
  saved: Uint8Array | null;
  /** /work by path. */
  readonly files: Map<string, Uint8Array>;
  /** The root first. */
  readonly sessions: Array<FakeSession>;
  readonly shells: Array<Json>;
  readonly streams: Set<ReadableStreamDefaultController<Uint8Array>>;
}

interface Fake {
  /** In start order. */
  readonly started: Array<Vm>;
  /** Across every VM. */
  readonly prompts: Array<Json>;
  /** By form id. */
  readonly replies: Map<string, unknown>;
  /** Run by each start once its VM exists. */
  starting: Effect.Effect<void, SandboxError>;
  readonly listeners: Set<() => void>;
  next: number;
}

export class Vms extends Context.Service<Vms, Fake>()("@t45/runner/FakeOpenCode.testkit/Vms") {}

const NOW = 1_790_000_000_000;

const nextId = (fake: Fake, prefix: string) => `${prefix}${String(fake.next++)}`;

/** The latest VM started for `id`. */
export const vm = (fake: Fake, id: string) => {
  const found = fake.started.findLast((each) => each.id === id);
  if (found === undefined) throw new Error(`No VM started for ${id}`);
  return found;
};

export const root = (fake: Fake, id: string) => {
  const found = vm(fake, id).sessions[0];
  if (found === undefined) throw new Error(`No root session in ${id}`);
  return found;
};

const changed = (fake: Fake) => {
  for (const listener of fake.listeners) listener();
};

const until = (fake: Fake, holds: () => boolean) =>
  Effect.callback<void>((resume) => {
    const check = () => {
      if (!holds()) return;
      fake.listeners.delete(check);
      resume(Effect.void);
    };
    fake.listeners.add(check);
    check();
    return Effect.sync(() => fake.listeners.delete(check));
  });

export const prompted = (fake: Fake, inputId: string) =>
  until(fake, () => fake.prompts.some((prompt) => prompt.id === inputId));

/** Every VM started for `id` is removed. */
export const removed = (fake: Fake, id: string) =>
  until(fake, () => fake.started.every((each) => each.id !== id || each.state === "removed"));

const frameOf = (event: Json) => new TextEncoder().encode(`data: ${encodeJson(event)}\n\n`);

/** Ephemeral events ignore the durable envelope. */
export const emit = (fake: Fake, id: string, type: string, data: Json) => {
  const durable = { aggregateID: id, seq: fake.next, version: 1 };
  const frame = frameOf({ id: nextId(fake, "evt_"), created: NOW, type, data, durable });
  for (const stream of vm(fake, id).streams) stream.enqueue(frame);
};

const closeStreams = (target: Vm) => {
  for (const stream of target.streams) stream.close();
  target.streams.clear();
};

/** It loses its event streams and answers nothing more. */
export const crash = (fake: Fake, id: string) => {
  const target = vm(fake, id);
  target.state = "lost";
  closeStreams(target);
};

/** It answers nothing more, while its event streams stay open. */
export const hang = (fake: Fake, id: string) => {
  vm(fake, id).state = "lost";
};

const write = (fake: Fake, id: string, item: Json) => {
  const session = root(fake, id);
  session.items.push(item);
  emit(fake, id, "session.text.started", {
    sessionID: session.id,
    assistantMessageID: item.id,
    ordinal: 0,
  });
  return String(item.id);
};

const assistant = (fake: Fake, content: ReadonlyArray<Json>) => {
  const at = NOW + fake.next * 1000;
  return {
    id: nextId(fake, "msg_a"),
    type: "assistant",
    agent: "build",
    model: { providerID: "opencode-go", id: "test-model" },
    content,
    time: { created: at, completed: at + 1 },
  };
};

/** Returns the message's id. */
export const answerText = (fake: Fake, id: string, text: string) =>
  write(fake, id, assistant(fake, [{ type: "text", text }]));

/** The subagent already finished its own turn; its report hasn't reached the root. Returns its session's id. */
export const backgroundSubagent = (fake: Fake, id: string) => {
  const child = nextId(fake, "ses_sub");
  vm(fake, id).sessions.push(
    newSession({ id: child, parentID: root(fake, id).id, title: "Research" }),
  );
  write(
    fake,
    id,
    assistant(fake, [
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
        time: { created: NOW, completed: NOW },
      },
    ]),
  );
  return child;
};

/** Returns the report's id. */
export const reportSubagent = (fake: Fake, id: string, child: string) => {
  const session = root(fake, id);
  const report = nextId(fake, "msg_s");
  session.items.push({
    id: report,
    type: "synthetic",
    text: "The research is done.",
    metadata: { source: "subagent", childID: child },
    time: { created: NOW + fake.next * 1000 },
  });
  emit(fake, id, "session.execution.succeeded", { sessionID: session.id });
  return report;
};

/** Listed as running until `exitShell`. Returns its id. */
export const runningShell = (fake: Fake, id: string) => {
  const shell = nextId(fake, "sh_");
  vm(fake, id).shells.push({
    id: shell,
    status: "running",
    command: "build",
    cwd: "/work",
    shell: "/bin/sh",
    file: "/tmp/output",
    metadata: {},
    time: { started: NOW },
  });
  return shell;
};

export const exitShell = (fake: Fake, id: string, shell: string) => {
  for (const each of vm(fake, id).shells) {
    if (each.id === shell) each.status = "exited";
  }
  emit(fake, id, "shell.exited", { id: shell, status: "exited", exit: 0 });
};

/** Returns the id of the idle message that ends the turn. */
export const finishTurn = (fake: Fake, id: string) => {
  const session = root(fake, id);
  const idle = nextId(fake, "msg_i");
  session.items.push({
    id: idle,
    type: "idle",
    outcome: "succeeded",
    time: { created: NOW + fake.next * 1000 },
  });
  session.active = false;
  emit(fake, id, "session.execution.succeeded", { sessionID: session.id });
  return idle;
};

export const failTurn = (fake: Fake, id: string) => {
  const session = root(fake, id);
  session.active = false;
  session.outcome = "failed";
  emit(fake, id, "session.execution.failed", {
    sessionID: session.id,
    error: { type: "provider", message: "The provider refused the turn." },
  });
};

const formInfo = (sessionID: string, id: string) => ({
  id,
  sessionID,
  title: "Which year?",
  fields: [{ key: "year", type: "string" }],
});

/** The agent asks in the root. Returns the form's id. */
export const ask = (fake: Fake, id: string) => {
  const session = root(fake, id);
  const form = Form.ID.make(nextId(fake, "frm_"));
  session.forms.push(form);
  emit(fake, id, "form.created", { form: formInfo(session.id, form) });
  return form;
};

/** OpenCode makes an inbox entry the session's message, which starts a turn. */
const deliver = (fake: Fake, id: string, session: FakeSession, entry: Json) => {
  const payload = entry.payload as Json;
  session.items.push({ id: entry.id, type: entry.type, ...payload, time: { created: NOW } });
  session.active = true;
  emit(fake, id, "session.inbox.delivered", { sessionID: session.id, inboxID: entry.id });
};

export const hold = (fake: Fake, id: string, held: boolean) => {
  const session = root(fake, id);
  session.hold = held;
  if (!held) for (const entry of session.inbox.splice(0)) deliver(fake, id, session, entry);
};

const newSession = (info: Json, items: Array<Json> = []): FakeSession => ({
  id: String(info.id),
  info,
  items,
  active: false,
  forms: [],
  inbox: [],
  hold: false,
});

const sessionInfo = (session: FakeSession) => {
  const { parentID, title } = session.info;
  return {
    id: session.id,
    ...(typeof parentID === "string" ? { parentID } : {}),
    ...(typeof title === "string" ? { title } : {}),
    outcome: session.outcome,
    projectID: "global",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: NOW, updated: NOW },
    location: { directory: "/work" },
  };
};

const json = (body: unknown, status = 200) =>
  new Response(encodeJson(body), { status, headers: { "content-type": "application/json" } });

const noContent = () => new Response(null, { status: 204 });

const notFound = (sessionID: string) =>
  json({ _tag: "SessionNotFoundError", sessionID, message: "No such session." }, 404);

/** Only ascending pages continued by cursor alone; a page's last message is its cursor. */
const listMessages = (session: FakeSession, query: URLSearchParams) => {
  const cursor = query.get("cursor");
  const limit = Number(query.get("limit"));
  if ((cursor === null ? query.get("order") !== "asc" : query.has("order")) || !(limit > 0)) {
    throw new Error("The fixture only scripts ascending capture, continued by cursor alone.");
  }
  const at = cursor === null ? -1 : session.items.findIndex((item) => item.id === cursor);
  const page = session.items.slice(at + 1, at + 1 + limit);
  return json({ data: page, cursor: { next: page.at(-1)?.id } });
};

const openStream = (fake: Fake, target: Vm) => {
  const connected = frameOf({
    id: nextId(fake, "evt_"),
    created: NOW,
    type: "server.connected",
    data: {},
  });
  let opened: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      opened = controller;
      target.streams.add(controller);
      controller.enqueue(connected);
    },
    cancel: () => {
      if (opened !== undefined) target.streams.delete(opened);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
};

const answer = (
  fake: Fake,
  target: Vm,
  method: string,
  path: string,
  query: URLSearchParams,
  body: Json,
) => {
  const route = `${method} ${path}`;
  if (route === "GET /api/event") return openStream(fake, target);
  if (route === "GET /api/shell") {
    return json({ location: { directory: "/work" }, data: target.shells });
  }
  if (route === "GET /api/fs/list") {
    const under = `${query.get("path")}/`;
    const data = [...target.files.keys()]
      .filter((file) => file.startsWith(under) && !file.slice(under.length).includes("/"))
      .map((file) => ({ path: file, type: "file" }));
    return json({ location: { directory: "/work" }, data });
  }
  if (route.startsWith("GET /api/fs/read/")) {
    const file = path.slice("/api/fs/read/".length).split("/").map(decodeURIComponent).join("/");
    const content = target.files.get(file);
    return content === undefined
      ? json({ _tag: "FileNotFoundError", path: file, message: "No such file." }, 404)
      : new Response(new Uint8Array(content));
  }
  if (route === "GET /api/session/active") {
    return json({
      data: Object.fromEntries(
        target.sessions.filter((each) => each.active).map((each) => [each.id, { type: "running" }]),
      ),
    });
  }
  if (route === "GET /api/session") {
    return json({ data: target.sessions.map(sessionInfo), cursor: {} });
  }
  if (route === "POST /api/session") {
    const stored = target.sessions.find((each) => each.id === body.id);
    if (stored !== undefined) return json({ data: sessionInfo(stored) });
    const created = newSession(body);
    target.sessions.push(created);
    return json({ data: sessionInfo(created) });
  }
  const matched = /^\/api\/session\/([^/]+)(\/.*)?$/u.exec(path);
  if (matched === null) throw new Error(`Unscripted OpenCode request: ${route}`);
  const sessionID = decodeURIComponent(matched[1] ?? "");
  const rest = `${method} ${matched[2] ?? ""}`;
  const session = target.sessions.find((each) => each.id === sessionID);
  if (session === undefined) return notFound(sessionID);
  if (rest === "GET ") return json({ data: sessionInfo(session) });
  if (rest === "POST /model") {
    session.info.model = body.model;
    return noContent();
  }
  if (rest === "POST /prompt") {
    const { id, text, metadata, delivery } = body;
    const entry = {
      id,
      sessionID,
      type: "user",
      payload: { text, metadata },
      delivery,
      time: { created: NOW },
    };
    if (session.hold) session.inbox.push(entry);
    else deliver(fake, target.id, session, entry);
    fake.prompts.push({ id, text, metadata, delivery });
    changed(fake);
    return json({ data: entry });
  }
  if (rest === "GET /inbox") return json({ data: session.inbox });
  if (rest === "GET /message") return listMessages(session, query);
  if (rest === "GET /form")
    return json({ data: session.forms.map((id) => formInfo(sessionID, id)) });
  const [, kind = "", itemId = "", reply] =
    /^\/(inbox|message|form)\/([^/]+)(\/reply)?$/u.exec(matched[2] ?? "") ?? [];
  const item = decodeURIComponent(itemId);
  if (method === "DELETE" && kind === "inbox") {
    const at = session.inbox.findIndex((each) => each.id === item);
    if (at >= 0) session.inbox.splice(at, 1);
    return noContent();
  }
  if (method === "GET" && kind === "message") {
    const message = session.items.find((each) => each.id === item);
    return message === undefined
      ? json({ _tag: "MessageNotFoundError", sessionID, messageID: item, message: "None." }, 404)
      : json({ data: message });
  }
  if (kind === "form" && (method === "DELETE" || reply !== undefined)) {
    const at = session.forms.indexOf(item);
    if (at < 0) return json({ _tag: "FormNotFoundError", id: item, message: "No form." }, 404);
    session.forms.splice(at, 1);
    if (reply === undefined) {
      emit(fake, target.id, "form.cancelled", { id: item, sessionID });
    } else {
      fake.replies.set(item, body.answer);
      emit(fake, target.id, "form.replied", { id: item, sessionID, answer: body.answer });
    }
    return noContent();
  }
  throw new Error(`Unscripted OpenCode request: ${route}`);
};

const httpClient = (fake: Fake) =>
  HttpClient.make((request, url) =>
    Effect.suspend(() => {
      const target = fake.started.find((each) => each.url === url.origin);
      if (target?.state !== "up") {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "No VM answers." }),
          }),
        );
      }
      const raw =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const body = (raw === "" ? {} : decodeJson(raw)) as Json;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          answer(fake, target, request.method, url.pathname, url.searchParams, body),
        ),
      );
    }),
  );

interface Disk {
  readonly files: ReadonlyArray<readonly [string, ReadonlyArray<number>]>;
  readonly sessions: ReadonlyArray<{ readonly info: Json; readonly items: Array<Json> }>;
}

const saveDisk = (booted: Vm) => {
  const disk: Disk = {
    files: [...booted.files].map(([path, content]) => [path, [...content]]),
    sessions: booted.sessions.map(({ info, items }) => ({ info, items })),
  };
  return new TextEncoder().encode(encodeJson(disk));
};

const remove = (fake: Fake, booted: Vm) => {
  booted.state = "removed";
  closeStreams(booted);
  changed(fake);
};

const sandbox = (fake: Fake) =>
  Sandbox.of({
    start: (id, agent, disk) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const restored =
            disk === null ? null : (decodeJson(new TextDecoder().decode(disk)) as Disk);
          const booted: Vm = {
            id,
            url: `http://vm${fake.started.length + 1}.test`,
            agent,
            booted: disk,
            saved: null,
            state: "up",
            files: new Map(
              restored?.files.map(([path, content]) => [path, new Uint8Array(content)]),
            ),
            sessions: restored?.sessions.map(({ info, items }) => newSession(info, items)) ?? [],
            shells: [],
            streams: new Set(),
          };
          fake.started.push(booted);
          return booted;
        }),
        (booted) => Effect.sync(() => remove(fake, booted)),
      ).pipe(
        Effect.tap(() => fake.starting),
        Effect.map((booted) => ({
          url: booted.url,
          password: Redacted.make("vm-password"),
          write: (path: string, content: Uint8Array) =>
            Effect.sync(() => void booted.files.set(path, content)),
          save: Effect.sync(() => {
            remove(fake, booted);
            booted.saved = saveDisk(booted);
            return booted.saved;
          }),
        })),
      ),
  });

/** Fresh VMs per build, as `Vms`, behind the `Sandbox` and the `HttpClient` that reaches them. */
export const layer = Layer.unwrap(
  Effect.sync(() => {
    const fake: Fake = {
      started: [],
      prompts: [],
      replies: new Map(),
      starting: Effect.void,
      listeners: new Set(),
      next: 1,
    };
    return Layer.mergeAll(
      Layer.succeed(Vms, fake),
      Layer.succeed(Sandbox, sandbox(fake)),
      Layer.succeed(HttpClient.HttpClient, httpClient(fake)),
    );
  }),
);
