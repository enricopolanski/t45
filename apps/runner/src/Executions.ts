import { Model, type OpenCodeClient } from "@opencode/client/effect";
import {
  AnswerInvalid,
  type Message,
  type RunRequest,
  type RunUpdate,
  QuestionGone,
  RunnerRpcs,
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
import { Sandbox, type Vm } from "./Sandbox.ts";

const CAPTURE_BATCH = "150 millis";

const RESTART = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")]);

type Signal = "messages" | "events" | "ended";

interface Running {
  readonly request: RunRequest;
  /** Null once cancelled, so a late `send` can't bring it back. */
  readonly messages: Map<string, Message | null>;
  readonly files: Map<string, Uint8Array>;
  readonly signal: Queue.Queue<Signal>;
  readonly lock: Semaphore.Semaphore;
  /** The current one, once its root is in its VM. */
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

    /** Until OpenCode is done with every message; returns the root's outcome, and fails when the VM is lost. */
    const converse = Effect.fnUntraced(function* (
      id: string,
      vm: Vm,
      running: Running,
      emit: (event: RunUpdate) => Effect.Effect<void>,
    ) {
      const { request } = running;
      const root = request.root;
      yield* Queue.clear(running.signal);
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
      const model = Model.Ref.parse(request.agent.model);
      const permissions = OpenCode.sessionRules(request.questions);
      // A root the disk kept comes back as it is.
      yield* client.session.create({
        id: root,
        title: request.title,
        model,
        permissions,
      });
      yield* client.session.switchModel({ sessionID: root, model });
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
          for (const message of running.messages.values()) {
            if (message === null || sent.has(message.id)) continue;
            yield* client.session.prompt({ ...message, sessionID: root, delivery: "queue" });
            sent.add(message.id);
          }
        }),
      );

      const done = Effect.gen(function* () {
        for (const message of running.messages.values()) {
          if (message !== null && !sent.has(message.id)) return false;
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
            return info.outcome === "failed" ? ("failed" as const) : null;
          }
        }
        const first = yield* Queue.take(running.signal);
        if (first === "events") yield* Effect.sleep(CAPTURE_BATCH);
        const signals = new Set([first, ...(yield* Queue.clear(running.signal))]);
        if (signals.has("ended")) return yield* new Capture.StreamEndedError();
      }
    });

    /** In a new VM, removed when it ends, whose disk is saved once OpenCode is done. */
    const attempt = Effect.fnUntraced(function* (
      id: string,
      running: Running,
      emit: (event: RunUpdate) => Effect.Effect<void>,
    ) {
      const { agent, disk } = running.request;
      const vm = yield* sandbox.start(id, agent, disk);
      const outcome = yield* Effect.scoped(converse(id, vm, running, emit));
      yield* emit({ _tag: "finished", outcome, disk: yield* vm.save });
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
      run: ({ id, request }) =>
        Stream.callback<RunUpdate>((queue) =>
          Effect.gen(function* () {
            const running: Running = {
              request,
              messages: new Map(request.messages.map((message) => [message.id, message])),
              files: new Map(Object.entries(request.files)),
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
            const emit = (event: RunUpdate) => Queue.offer(queue, event).pipe(Effect.asVoid);
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
      send: ({ id, message, files }) =>
        Effect.suspend(() => {
          const running = executions.get(id);
          if (running === undefined || running.messages.has(message.id)) return Effect.void;
          for (const [path, content] of Object.entries(files)) running.files.set(path, content);
          running.messages.set(message.id, message);
          return Queue.offer(running.signal, "messages").pipe(Effect.asVoid);
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
      cancel: ({ id, messageId }) =>
        Effect.suspend(() => {
          const running = executions.get(id);
          if (running === undefined) return Effect.void;
          return running.lock.withPermit(
            Effect.gen(function* () {
              running.messages.set(messageId, null);
              const current = running.attempt;
              if (current === null || !current.sent.has(messageId)) return;
              yield* current.client.session.inbox
                .cancel({ sessionID: running.request.root, inboxID: messageId })
                .pipe(Effect.ignore);
            }),
          );
        }),
    });
  }),
);
