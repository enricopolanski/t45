#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { chromium } from "playwright";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

class InvalidBrowserStepsError extends Schema.TaggedError<InvalidBrowserStepsError>()(
  "InvalidBrowserStepsError",
  { path: Schema.String },
) {
  override get message() {
    return `The steps module at ${this.path} must export a default function.`;
  }
}

const origin = new URL("http://localhost:5733");

const command = Command.make("browser", {
  email: Flag.String("email").pipe(
    Flag.withSchema(Schema.NonEmptyString),
    Flag.withDescription("Open a fresh browser as this local user's email."),
  ),
  instanceId: Flag.String("instance-id").pipe(
    Flag.withDescription("Send every request to this instance instead of the default app."),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  steps: Flag.String("steps").pipe(
    Flag.withDescription("Run a steps module in a headless browser, then close it."),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
}).pipe(
  Command.withDescription("Sign a fresh browser into the running local development app."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const browser = yield* Effect.acquireRelease(
        Effect.tryPromise(() => chromium.launch({ headless: input.steps !== undefined })),
        (browser) => Effect.promise(() => browser.close()),
      );
      const extraHTTPHeaders =
        input.instanceId === undefined ? {} : { "x-instance-id": input.instanceId };
      const context = yield* Effect.tryPromise(() => browser.newContext({ extraHTTPHeaders }));
      const page = yield* Effect.tryPromise(() => context.newPage());

      yield* Effect.tryPromise(async () => {
        await page.goto(new URL("/login", origin).href);
        await page.getByLabel("Email").fill(input.email);
        const [response] = await Promise.all([
          page.waitForResponse(
            (response) =>
              response.url() === new URL("/api/auth/login", origin).href &&
              response.request().method() === "POST",
          ),
          page.getByRole("button", { name: "Sign in", exact: true }).click(),
        ]);
        if (!response.ok()) {
          throw new Error(`Sign-in for ${input.email} was refused (${response.status()}).`);
        }
        await page.waitForURL((url) => url.pathname !== "/login");
      });
      yield* Console.log(`Opened ${page.url()} as ${input.email}.`);

      if (input.steps !== undefined) {
        const stepsUrl = yield* path.toFileUrl(path.resolve(input.steps));
        const module: { readonly default?: unknown } = yield* Effect.tryPromise(
          () => import(stepsUrl.href),
        );
        if (typeof module.default !== "function") {
          return yield* new InvalidBrowserStepsError({ path: input.steps });
        }
        const runSteps = module.default;
        yield* Effect.tryPromise(async () => {
          await runSteps({ page, context, browser, url: origin.origin });
        });
      } else {
        yield* Effect.callback<void>((resume) => {
          const stopWaiting = () => resume(Effect.void);
          browser.once("disconnected", stopWaiting);
          page.once("close", stopWaiting);
          if (!browser.isConnected() || page.isClosed()) stopWaiting();
          return Effect.sync(() => {
            browser.off("disconnected", stopWaiting);
            page.off("close", stopWaiting);
          });
        });
      }
    }).pipe(Effect.scoped),
  ),
);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
