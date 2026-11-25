import type { ChatId } from "@t45/contracts/models/Chat";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";

/** Each chat's disk, as its last execution left it, for the next to continue from. */
export class ChatDisks extends Context.Service<
  ChatDisks,
  {
    readonly read: (chatId: ChatId) => Effect.Effect<Uint8Array | null>;
    /** Replaces the chat's disk; a save cut short leaves the last good one. */
    readonly save: (chatId: ChatId, content: Uint8Array) => Effect.Effect<void>;
    readonly remove: (chatId: ChatId) => Effect.Effect<void>;
  }
>()("t45/chats/ChatDisks") {}

/** Where chats' disks are kept, under the server's state folder. */
const DISKS_DIRECTORY = "chat-disks";

/** As `<chatId>.tgz` files in the state folder. */
export const layerDirectory = Layer.effect(
  ChatDisks,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const disksDir = path.join(yield* ServerConfig.stateDir, DISKS_DIRECTORY);
    const diskFile = (chatId: ChatId) => path.join(disksDir, `${chatId}.tgz`);
    return {
      read: (chatId) =>
        fileSystem.readFile(diskFile(chatId)).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
          Effect.orDie,
        ),
      save: (chatId, content) =>
        Effect.gen(function* () {
          const target = diskFile(chatId);
          yield* fileSystem.makeDirectory(disksDir, { recursive: true });
          // Written beside it first, so a save cut short leaves the last good one.
          yield* fileSystem.writeFile(`${target}.part`, content);
          yield* fileSystem.rename(`${target}.part`, target);
        }).pipe(Effect.orDie),
      remove: (chatId) =>
        Effect.gen(function* () {
          const target = diskFile(chatId);
          yield* fileSystem.remove(target, { force: true });
          yield* fileSystem.remove(`${target}.part`, { force: true });
        }).pipe(Effect.orDie),
    };
  }),
);
