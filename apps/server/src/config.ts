/**
 * ServerConfig - the server's runtime configuration and the data paths under its home dir.
 *
 * @module ServerConfig
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as LogLevel from "effect/LogLevel";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * ServerConfig - Service tag for server runtime configuration.
 */
export class ServerConfig extends Context.Service<
  ServerConfig,
  {
    readonly logLevel: LogLevel.LogLevel;
    readonly port: number;
    readonly host: string;
    readonly stateDir: string;
    readonly dbPath: string;
    readonly attachmentsDir: string;
    readonly logRequests: boolean;
  }
>()("t45/config/ServerConfig") {}

/** The state dir under `baseDir` and the paths in it, created if missing. */
const statePaths = Effect.fnUntraced(function* (baseDir: string) {
  const { join } = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const stateDir = join(baseDir, "userdata");
  const attachmentsDir = join(stateDir, "attachments");
  yield* fs.makeDirectory(attachmentsDir, { recursive: true });
  return { stateDir, dbPath: join(stateDir, "statev2.sqlite"), attachmentsDir };
});

export const fromEnv = Effect.gen(function* () {
  const env = yield* Config.all({
    logLevel: Config.LogLevel("LOG_LEVEL").pipe(Config.withDefault("Info")),
    port: Config.Port("PORT").pipe(Config.withDefault(3773)),
    host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
    // The state directory; the server refuses to start without it.
    dataDir: Config.schema(Schema.NonEmptyString, "DATA_DIR"),
    logRequests: Config.Boolean("LOG_REQUESTS").pipe(Config.withDefault(false)),
  });
  return ServerConfig.of({
    logLevel: env.logLevel,
    port: env.port,
    host: env.host,
    ...(yield* statePaths((yield* Path.Path).resolve(env.dataDir))),
    logRequests: env.logRequests,
  });
});

export const layerTest = (baseDirOrPrefix: string | { readonly prefix: string }) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const baseDir =
        typeof baseDirOrPrefix === "string"
          ? baseDirOrPrefix
          : yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
              prefix: baseDirOrPrefix.prefix,
            });
      return ServerConfig.of({
        logLevel: "Error",
        port: 0,
        host: "127.0.0.1",
        ...(yield* statePaths(baseDir)),
        logRequests: false,
      });
    }),
  );
