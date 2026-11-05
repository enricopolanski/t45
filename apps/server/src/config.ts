// @effect-diagnostics nodeBuiltinImport:off - Configuration recipes derive paths before services are built.
import * as NodePath from "node:path";

import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

export const logLevel = Config.LogLevel("LOG_LEVEL").pipe(Config.withDefault("Info"));
export const port = Config.Port("PORT").pipe(Config.withDefault(3773));
export const host = Config.String("HOST").pipe(Config.withDefault("127.0.0.1"));
export const logRequests = Config.Boolean("LOG_REQUESTS").pipe(Config.withDefault(false));

export const stateDir = Config.schema(Schema.NonEmptyString, "DATA_DIR").pipe(
  Config.map((baseDir) => NodePath.resolve(baseDir, "userdata")),
);
export const dbPath = stateDir.pipe(Config.map((dir) => NodePath.join(dir, "statev2.sqlite")));
export const attachmentsDir = stateDir.pipe(Config.map((dir) => NodePath.join(dir, "attachments")));

export const layerTest = (baseDirOrPrefix: string | { readonly prefix: string }) =>
  ConfigProvider.layer(
    Effect.gen(function* () {
      const baseDir =
        typeof baseDirOrPrefix === "string"
          ? baseDirOrPrefix
          : yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
              prefix: baseDirOrPrefix.prefix,
            });
      return ConfigProvider.fromUnknown({
        LOG_LEVEL: "Error",
        PORT: 0,
        HOST: "127.0.0.1",
        DATA_DIR: baseDir,
        LOG_REQUESTS: false,
      });
    }),
  );
