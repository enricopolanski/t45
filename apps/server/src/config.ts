// @effect-diagnostics nodeBuiltinImport:off - Configuration recipes derive paths before services are built.
import * as NodePath from "node:path";

import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const logLevel = Config.LogLevel("LOG_LEVEL").pipe(Config.withDefault("Info"));
export const port = Config.Port("PORT").pipe(Config.withDefault(3773));
export const host = Config.String("HOST").pipe(Config.withDefault("127.0.0.1"));
export const logRequests = Config.Boolean("LOG_REQUESTS").pipe(Config.withDefault(false));

const decodeClerkIssuer = (publishableKey: string) =>
  `https://${atob(publishableKey.replace(/^pk_(?:test|live)_/u, "")).replace(/\$$/u, "")}`;

export type Environment =
  | { readonly _tag: "development" }
  | {
      readonly _tag: "production";
      readonly buildSha: string;
      readonly clerkIssuer: string;
    };

export const environment = Config.String("BUILD_SHA").pipe(
  Config.option,
  Config.flatMap(
    Option.match({
      onNone: (): Config.Config<Environment> => Config.succeed({ _tag: "development" }),
      onSome: (buildSha): Config.Config<Environment> =>
        Config.String("AUTH_CLERK_PUBLISHABLE_KEY").pipe(
          Config.map((key) => ({
            _tag: "production",
            buildSha,
            clerkIssuer: decodeClerkIssuer(key),
          })),
        ),
    }),
  ),
);

/**
 * In release bundles the build replaces `process.env.BUILD_SHA` with the commit string, so
 * `environment` sees it even though the server's environment doesn't set it.
 */
export const layer = ConfigProvider.layerAdd(
  ConfigProvider.fromUnknown({ BUILD_SHA: process.env.BUILD_SHA }),
);

const dataDir = Config.schema(Schema.NonEmptyString, "DATA_DIR");
export const stateDir = dataDir.pipe(Config.map((dir) => NodePath.resolve(dir, "userdata")));
/** Each development instance keeps a whole `DATA_DIR` in here. */
export const instancesDir = dataDir.pipe(Config.map((dir) => NodePath.resolve(dir, "instances")));
export const dbPath = stateDir.pipe(Config.map((dir) => NodePath.join(dir, "statev2.sqlite")));
export const attachmentsDir = stateDir.pipe(Config.map((dir) => NodePath.join(dir, "attachments")));

export const testLayer = (prefix: string) =>
  ConfigProvider.layer(
    Effect.gen(function* () {
      const filesystem = yield* FileSystem.FileSystem;
      const baseDir = yield* filesystem.makeTempDirectoryScoped({ prefix });
      return ConfigProvider.fromUnknown({
        LOG_LEVEL: "Error",
        PORT: 0,
        HOST: "127.0.0.1",
        DATA_DIR: baseDir,
        LOG_REQUESTS: false,
      });
    }),
  );
