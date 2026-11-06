import { Form } from "@opencode/schema/form";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import {
  type Message,
  type ExecutionRequest,
  type ExecutionUpdate,
  RunnerRpcs,
} from "@t45/contracts/resources/Runner";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";

import { rootSessionId } from "../chats/ChatIds.ts";
import { RunnerService } from "./RunnerService.ts";

type RunnerRpc = RpcGroup.Rpcs<typeof RunnerRpcs>;
type Payload<Tag extends RunnerRpc["_tag"]> = Rpc.Payload<Rpc.ExtractTag<RunnerRpc, Tag>>;

interface Execution {
  readonly request: ExecutionRequest;
  readonly messages: Array<Message>;
  readonly events: Queue.Queue<ExecutionUpdate, Cause.Done>;
  readonly ended: Deferred.Deferred<void>;
}

const NOW = 1_790_000_000_000;
const decodeSession = Schema.decodeUnknownSync(Session.Info);
const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Info);

/** A runner at the contract's level: tests script what its executions emit and read what T45 sent it. */
const make = () => {
  const running = new Map<string, Execution>();
  let next = 1;

  const executionOf = (chatId: string) => {
    const execution = running.get(rootSessionId(chatId));
    if (execution === undefined) throw new Error(`No execution for ${chatId}.`);
    return execution;
  };
  const emit = (execution: Execution, event: ExecutionUpdate) =>
    void Queue.offerUnsafe(execution.events, event);
  const write = (execution: Execution, message: unknown) =>
    emit(execution, {
      _tag: "messages",
      sessionId: execution.request.rootId,
      messages: [decodeMessage(message)],
    });
  const deliver = (execution: Execution, message: Message) => {
    if (!fake.hold) write(execution, { ...message, type: "user", time: { created: NOW } });
  };
  /** As in a new VM: the root session, then each message the agent takes. */
  const begin = (execution: Execution) => {
    const { rootId, title } = execution.request;
    const info = decodeSession({
      id: rootId,
      title,
      projectID: "global",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: NOW, updated: NOW },
      location: { directory: "/work" },
    });
    emit(execution, { _tag: "sessions", sessions: [info] });
    for (const message of execution.messages) deliver(execution, message);
  };

  const fake = {
    /** Set to keep messages from the agent: they stay pending. */
    hold: false,
    /** Set to fail each execution with this reason. */
    refuse: null as string | null,
    /** Every execution T45 asked for, refused ones included. */
    executions: [] as Array<Payload<"execute">>,
    fileWrites: [] as Array<Payload<"writeFiles">>,
    sends: [] as Array<Payload<"send">>,
    answers: [] as Array<Payload<"answer">>,
    cancels: [] as Array<Payload<"cancel">>,
    emit: (id: string, event: ExecutionUpdate) => emit(executionOf(id), event),
    /** The agent writes a reply in the root, unfinished while `streaming`. Returns its id. */
    reply: (
      id: string,
      text: string,
      options: { readonly streaming?: boolean; readonly parts?: number } = {},
    ) => {
      const messageId = `msg_a${String(next++)}`;
      write(executionOf(id), {
        id: messageId,
        type: "assistant",
        agent: "build",
        model: { providerID: "opencode-go", id: "test-model" },
        content: Array.from({ length: options.parts ?? 1 }, () => ({ type: "text", text })),
        time: options.streaming === true ? { created: NOW } : { created: NOW, completed: NOW },
      });
      return messageId;
    },
    /** The agent asks a question in the root. Returns its form's id. */
    ask: (id: string) => {
      const execution = executionOf(id);
      const form = Form.Info.make({
        id: Form.ID.make(`frm_${String(next++)}`),
        sessionID: execution.request.rootId,
        title: "Which year?",
        fields: [{ key: "year", type: "string" }],
      });
      emit(execution, { _tag: "questions", forms: [form] });
      return form.id;
    },
    fail: (id: string) =>
      void Queue.failCauseUnsafe(executionOf(id).events, Cause.die("The sandbox was lost.")),
    finish: (
      id: string,
      {
        outcome = null,
        disk = new Uint8Array(),
      }: { readonly outcome?: "failed" | null; readonly disk?: Uint8Array } = {},
    ) => {
      const execution = executionOf(id);
      emit(execution, { _tag: "finished", outcome, disk });
      Queue.endUnsafe(execution.events);
    },
    /** Waits until the chat's `execute` call ended: at once when none runs. */
    ended: (id: string) =>
      Effect.suspend(() => {
        const execution = running.get(rootSessionId(id));
        return execution === undefined ? Effect.void : Deferred.await(execution.ended);
      }),
  };

  const handlers = RunnerRpcs.of({
    execute: (request) =>
      Stream.unwrap(
        Effect.gen(function* () {
          fake.executions.push(request);
          if (fake.refuse !== null) {
            return Stream.die(fake.refuse);
          }
          const execution: Execution = {
            request,
            messages: [...request.messages],
            events: yield* Queue.unbounded<ExecutionUpdate, Cause.Done>(),
            ended: yield* Deferred.make<void>(),
          };
          running.set(request.rootId, execution);
          begin(execution);
          return Stream.fromQueue(execution.events).pipe(
            Stream.ensuring(
              Effect.suspend(() => {
                if (running.get(request.rootId) === execution) running.delete(request.rootId);
                return Deferred.succeed(execution.ended, undefined);
              }),
            ),
          );
        }),
      ),
    writeFiles: (payload) => Effect.sync(() => void fake.fileWrites.push(payload)),
    send: (payload) =>
      Effect.sync(() => {
        fake.sends.push(payload);
        const execution = running.get(payload.rootId);
        if (execution === undefined) return;
        execution.messages.push(payload.message);
        deliver(execution, payload.message);
      }),
    answer: (payload) => Effect.sync(() => void fake.answers.push(payload)),
    dismiss: () => Effect.void,
    cancel: (payload) => Effect.sync(() => void fake.cancels.push(payload)),
  });

  return { fake, handlers };
};

export class FakeRunner extends Context.Service<FakeRunner, ReturnType<typeof make>["fake"]>()(
  "t45/runner/FakeRunner.testkit/FakeRunner",
) {}

/** The fake as the RunnerService, over an in-memory RPC client. */
export const layer = Layer.unwrap(
  Effect.sync(() => {
    const { fake, handlers } = make();
    return Layer.effect(RunnerService, RpcTest.makeClient(RunnerRpcs)).pipe(
      Layer.provide(RunnerRpcs.toLayer(handlers)),
      Layer.merge(Layer.succeed(FakeRunner, fake)),
    );
  }),
);
