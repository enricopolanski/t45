/*
 * HTTP surface for the runner, which only T45 calls with the shared bearer token.
 *
 * Handlers stay thin: they call the chat table, sandbox or model catalog and answer with the
 * contract's errors.
 */
import {
  RunnerAuth,
  RunnerHttpApi,
  RunnerRefusedError,
  RunnerUnauthorizedError,
} from "@t45/contracts/resources/RunnerVms";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { ChatSandbox } from "./ChatSandbox.ts";
import { ChatTable } from "./ChatTable.ts";
import { ModelCatalog } from "./ModelCatalog.ts";
import { RunnerConfig } from "./RunnerConfig.ts";

export const routerConfig = { maxParamLength: 512 } as const;

export const layerAuth = Layer.effect(
  RunnerAuth,
  Effect.gen(function* () {
    const config = yield* RunnerConfig;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.headers.authorization !== `Bearer ${Redacted.value(config.token)}`) {
          return yield* new RunnerUnauthorizedError();
        }
        return yield* httpEffect;
      });
  }),
);

export const layer = HttpApiBuilder.group(
  RunnerHttpApi,
  "runner",
  Effect.fnUntraced(function* (handlers) {
    const chats = yield* ChatTable;
    const catalog = yield* ModelCatalog;
    const sandboxes = yield* ChatSandbox;

    return handlers
      .handle("inventory", () => chats.inventory)
      .handle(
        "models",
        Effect.fn("runner.models")(function* () {
          return { models: yield* catalog.models };
        }),
      )
      .handle(
        "ensureChat",
        Effect.fn("runner.ensureChat")(function* (args) {
          const health = yield* sandboxes.health;
          if (!health.isAvailable) {
            return yield* new RunnerRefusedError({
              reason: health.reason ?? "The runner can't run sandboxes.",
            });
          }
          return yield* chats.ensure({ chatId: args.params.vmId, chat: args.payload });
        }),
      )
      .handle(
        "getChatWorkspace",
        Effect.fn("runner.getChatWorkspace")(function* (args) {
          return yield* chats.readWorkspace(args.params.vmId);
        }),
      )
      .handle(
        "putChatWorkspace",
        Effect.fn("runner.putChatWorkspace")(function* (args) {
          yield* chats.writeWorkspace({ chatId: args.params.vmId, content: args.payload });
        }),
      )
      .handle(
        "putChatFile",
        Effect.fn("runner.putChatFile")(function* (args) {
          yield* chats.writeFile({
            chatId: args.params.vmId,
            path: args.query.path,
            content: args.payload,
          });
        }),
      )
      .handle(
        "removeChat",
        Effect.fn("runner.removeChat")(function* (args) {
          // A VM that could not be removed answers 500, so T45 tries again.
          yield* chats.remove(args.params.vmId).pipe(Effect.orDie);
        }),
      );
  }),
);
