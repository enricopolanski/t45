import { AbsolutePath, Location, Model, type OpenCodeClient } from "@opencode/client/effect";
import {
  AnswerInvalid,
  type Execution,
  type ExecutionEvent,
  type ExecutionInput,
  QuestionGone,
  RunnerRpcs,
  WORK_DIRECTORY,
} from "@t45/contracts/resources/Runner";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as Capture from "./Capture.ts";
import { ModelCatalog } from "./ModelCatalog.ts";
import * as OpenCode from "./OpenCode.ts";
import { Sandbox } from "./Sandbox.ts";

const CAPTURE_BATCH = "150 millis";

const RESTART = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")]);

const location = Location.PublicRef.make({ directory: AbsolutePath.make(WORK_DIRECTORY) });

type Signal = "inputs" | "events" | "ended";

interface Running {
  readonly execution: Execution;
  /** Null once cancelled, so a late `send` can't bring it back. */
  readonly inputs: Map<string, ExecutionInput | null>;
  readonly files: Map<string, Uint8Array>;
  readonly signal: Queue.Queue<Signal>;
  readonly lock: Semaphore.Semaphore;
  /** The current one, once the conversation is in its VM. */
  attempt: Attempt | null;
}

interface Attempt {
  readonly client: OpenCodeClient;
  readonly sent: Set<string>;
  readonly putFiles: Effect.Effect<void>;
}

/** The VM is out of reach; OpenCode's client wraps such a failure in a `ClientError`. */
const isLost = (error: unknown) => {
  if (Predicate.isTagged(error, "StreamEndedError")) return true;
  const failure =
    Predicate.isTagged(error, "ClientError") && "cause" in error ? error.cause : error;
  return HttpClientError.isHttpClientError(failure) && failure.reason._tag === "TransportError";
};

export const layer = RunnerRpcs.toLayer(
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const catalog = yield* ModelCatalog;
    const httpClient = yield* HttpClient.HttpClient;
    const executions = new Map<string, Running>();

    /** From a new VM, removed when it ends, until OpenCode is done; fails when the VM is lost. */
    const attempt = Effect.fnUntraced(function* (
      id: string,
      running: Running,
      emit: (event: ExecutionEvent) => Effect.Effect<void>,
    ) {
      const { execution } = running;
      const root = execution.root;
      yield* Queue.clear(running.signal);
      const vm = yield* sandbox.start(id, execution.agent);
      const opencode = yield* OpenCode.connect(vm).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      const { client } = opencode;
      const capture = yield* Capture.make({
        opencode,
        root,
        emit,
        changed: Queue.offer(running.signal, "events"),
        ended: Queue.offer(running.signal, "ended"),
      });

      if (execution.workspace !== null) yield* vm.unpack(execution.workspace);
      const written = new Set<string>();
      /** One the sandbox refuses is skipped. */
      const putFiles = Effect.forEach(
        running.files,
        ([path, content]) =>
          written.has(path)
            ? Effect.void
            : vm.write(path, content).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Writing a file into a VM failed", { id, path, error }),
                ),
                Effect.andThen(Effect.sync(() => written.add(path))),
              ),
        { discard: true },
      );
      yield* putFiles;
      const permissions = OpenCode.sessionRules(execution.questions);
      const rootInfo = { title: execution.title, model: Model.Ref.parse(execution.agent.model) };
      if (!execution.conversation.some(({ info }) => info.id === root)) {
        yield* client.session.create({ id: root, ...rootInfo, location, permissions });
      }
      for (const { info, messages } of execution.conversation) {
        yield* client.session.import({
          info: { ...info, permissions, ...(info.id === root ? rootInfo : {}) },
          messages,
          location,
        });
      }
      const sent = new Set<string>();
      running.attempt = { client, sent, putFiles };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          running.attempt = null;
        }),
      );

      const deliver = running.lock.withPermit(
        Effect.gen(function* () {
          yield* putFiles;
          for (const input of running.inputs.values()) {
            if (input === null || sent.has(input.id)) continue;
            yield* client.session.prompt({ ...input, sessionID: root, delivery: "queue" });
            sent.add(input.id);
          }
        }),
      );

      const done = Effect.gen(function* () {
        for (const input of running.inputs.values()) {
          if (input !== null && !sent.has(input.id)) return false;
        }
        return yield* capture.idle;
      });

      while (true) {
        yield* deliver;
        yield* capture.marked;
        if (yield* done) {
          yield* capture.all;
          if (yield* done) {
            const info = yield* client.session.get({ sessionID: root });
            return yield* emit({
              _tag: "finished",
              outcome: info.outcome === "failed" ? "failed" : null,
              workspace: yield* vm.pack,
            });
          }
        }
        const first = yield* Queue.take(running.signal);
        if (first === "events") yield* Effect.sleep(CAPTURE_BATCH);
        const signals = new Set([first, ...(yield* Queue.clear(running.signal))]);
        if (signals.has("ended")) return yield* new Capture.StreamEndedError();
      }
    });

    /** A question goes with its VM, so there is none without an attempt. */
    const onAttempt = <A, E>(
      id: string,
      use: (running: Running, attempt: Attempt) => Effect.Effect<A, E>,
    ) =>
      Effect.gen(function* () {
        const running = executions.get(id);
        if (running === undefined || running.attempt === null) return yield* new QuestionGone();
        return yield* use(running, running.attempt);
      });

    return RunnerRpcs.of({
      getModels: () => catalog.models,
      run: ({ id, execution }) =>
        Stream.callback<ExecutionEvent>((queue) =>
          Effect.gen(function* () {
            const running: Running = {
              execution,
              inputs: new Map(execution.inputs.map((input) => [input.id, input])),
              files: new Map(Object.entries(execution.files)),
              signal: yield* Queue.unbounded<Signal>(),
              lock: yield* Semaphore.make(1),
              attempt: null,
            };
            executions.set(id, running);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                if (executions.get(id) === running) executions.delete(id);
              }),
            );
            const emit = (event: ExecutionEvent) => Queue.offer(queue, event).pipe(Effect.asVoid);
            yield* emit({ _tag: "heartbeat" }).pipe(
              Effect.repeat(Schedule.spaced("15 seconds")),
              Effect.forkScoped,
            );
            yield* attempt(id, running, emit).pipe(
              Effect.scoped,
              Effect.tapError((error) =>
                isLost(error)
                  ? Effect.logWarning("A VM was lost; its execution starts over", {
                      id,
                      error,
                    }).pipe(Effect.andThen(emit({ _tag: "restarted" })))
                  : Effect.logError("An execution failed", { id, error }),
              ),
              Effect.retry({ while: isLost, schedule: RESTART }),
              Effect.orDie,
            );
            yield* Queue.end(queue);
          }),
        ),
      send: ({ id, input, files }) =>
        Effect.suspend(() => {
          const running = executions.get(id);
          if (running === undefined || running.inputs.has(input.id)) return Effect.void;
          for (const [path, content] of Object.entries(files)) running.files.set(path, content);
          running.inputs.set(input.id, input);
          return Queue.offer(running.signal, "inputs").pipe(Effect.asVoid);
        }),
      answer: ({ id, sessionId, formId, answer, files }) =>
        onAttempt(id, (running, attempt) =>
          Effect.gen(function* () {
            for (const [path, content] of Object.entries(files)) running.files.set(path, content);
            yield* attempt.putFiles;
            yield* attempt.client.session.form.reply({
              sessionID: sessionId,
              formID: formId,
              answer,
            });
          }).pipe(
            Effect.mapError((error) =>
              error._tag === "FormInvalidAnswerError" ? new AnswerInvalid() : new QuestionGone(),
            ),
          ),
        ),
      dismiss: ({ id, sessionId, formId }) =>
        onAttempt(id, (_, attempt) =>
          attempt.client.session.form
            .cancel({ sessionID: sessionId, formID: formId })
            .pipe(Effect.mapError(() => new QuestionGone())),
        ),
      cancel: ({ id, inputId }) =>
        Effect.suspend(() => {
          const running = executions.get(id);
          if (running === undefined) return Effect.void;
          return running.lock.withPermit(
            Effect.gen(function* () {
              running.inputs.set(inputId, null);
              const current = running.attempt;
              if (current === null || !current.sent.has(inputId)) return;
              yield* current.client.session.inbox
                .cancel({ sessionID: running.execution.root, inboxID: inputId })
                .pipe(Effect.ignore);
            }),
          );
        }),
    });
  }),
);
