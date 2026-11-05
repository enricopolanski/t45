import { Form } from "@opencode/schema/form";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import {
  type Message,
  type RunRequest,
  type RunUpdate,
  RunnerRpcs,
} from "@t45/contracts/resources/Runner";
import type * as Cause from "effect/Cause";
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

import { RunnerService } from "./RunnerService.ts";

type RunnerRpc = RpcGroup.Rpcs<typeof RunnerRpcs>;
type Payload<Tag extends RunnerRpc["_tag"]> = Rpc.Payload<Rpc.ExtractTag<RunnerRpc, Tag>>;

interface Run {
  readonly request: RunRequest;
  readonly messages: Array<Message>;
  readonly events: Queue.Queue<RunUpdate, Cause.Done>;
  readonly ended: Deferred.Deferred<void>;
}

const NOW = 1_790_000_000_000;
const decodeSession = Schema.decodeUnknownSync(Session.Info);
const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Info);

/** A runner at the contract's level: tests script what its runs emit and read what T45 sent it. */
const make = () => {
  const running = new Map<string, Run>();
  let next = 1;

  const runOf = (id: string) => {
    const run = running.get(id);
    if (run === undefined) throw new Error(`No run for ${id}.`);
    return run;
  };
  const emit = (run: Run, event: RunUpdate) => void Queue.offerUnsafe(run.events, event);
  const write = (run: Run, message: unknown) =>
    emit(run, {
      _tag: "messages",
      sessionId: run.request.root,
      messages: [decodeMessage(message)],
    });
  const deliver = (run: Run, message: Message) => {
    if (!fake.hold) write(run, { ...message, type: "user", time: { created: NOW } });
  };
  /** As in a new VM: the root session, then each message the agent takes. */
  const begin = (run: Run) => {
    const { root, title } = run.request;
    const info = decodeSession({
      id: root,
      title,
      projectID: "global",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: NOW, updated: NOW },
      location: { directory: "/work" },
    });
    emit(run, { _tag: "sessions", sessions: [info] });
    for (const message of run.messages) deliver(run, message);
  };

  const fake = {
    /** Set to keep messages from the agent: they stay pending. */
    hold: false,
    /** Set to fail each run with this reason. */
    refuse: null as string | null,
    /** Every run T45 asked for, refused ones included. */
    runs: [] as Array<Payload<"run">>,
    sends: [] as Array<Payload<"send">>,
    answers: [] as Array<Payload<"answer">>,
    cancels: [] as Array<Payload<"cancel">>,
    emit: (id: string, event: RunUpdate) => emit(runOf(id), event),
    /** The agent writes a reply in the root, unfinished while `streaming`. Returns its id. */
    reply: (
      id: string,
      text: string,
      options: { readonly streaming?: boolean; readonly parts?: number } = {},
    ) => {
      const messageId = `msg_a${String(next++)}`;
      write(runOf(id), {
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
      const run = runOf(id);
      const form = Form.Info.make({
        id: Form.ID.make(`frm_${String(next++)}`),
        sessionID: run.request.root,
        title: "Which year?",
        fields: [{ key: "year", type: "string" }],
      });
      emit(run, { _tag: "questions", forms: [form] });
      return form.id;
    },
    /** The run's VM was lost: it starts over in a new one. */
    restart: (id: string) => {
      const run = runOf(id);
      emit(run, { _tag: "restarted" });
      begin(run);
    },
    finish: (
      id: string,
      {
        outcome = null,
        disk = new Uint8Array(),
      }: { readonly outcome?: "failed" | null; readonly disk?: Uint8Array } = {},
    ) => {
      const run = runOf(id);
      emit(run, { _tag: "finished", outcome, disk });
      Queue.endUnsafe(run.events);
    },
    /** Waits until the chat's run call ended: at once when none runs. */
    ended: (id: string) =>
      Effect.suspend(() => {
        const run = running.get(id);
        return run === undefined ? Effect.void : Deferred.await(run.ended);
      }),
  };

  const handlers = RunnerRpcs.of({
    run: (payload) =>
      Stream.unwrap(
        Effect.gen(function* () {
          fake.runs.push(payload);
          if (fake.refuse !== null) {
            return Stream.die(fake.refuse);
          }
          const run: Run = {
            request: payload.request,
            messages: [...payload.request.messages],
            events: yield* Queue.unbounded<RunUpdate, Cause.Done>(),
            ended: yield* Deferred.make<void>(),
          };
          running.set(payload.id, run);
          begin(run);
          return Stream.fromQueue(run.events).pipe(
            Stream.ensuring(
              Effect.suspend(() => {
                if (running.get(payload.id) === run) running.delete(payload.id);
                return Deferred.succeed(run.ended, undefined);
              }),
            ),
          );
        }),
      ),
    send: (payload) =>
      Effect.sync(() => {
        fake.sends.push(payload);
        const run = running.get(payload.id);
        if (run === undefined) return;
        run.messages.push(payload.message);
        deliver(run, payload.message);
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
