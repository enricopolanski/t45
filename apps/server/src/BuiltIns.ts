import { BuiltIns } from "@t45/contracts/resources/BuiltIns";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { AgentRepository } from "./agents/AgentRepository.ts";
import { CapabilityRepository } from "./capabilities/CapabilityRepository.ts";
import * as ServerConfig from "./config.ts";

const decodeBuiltIns = Schema.decodeUnknownEffect(Schema.fromJsonString(BuiltIns));

/** This deployment's built-ins as JSON, or none when an instance has none to apply. */
export class Source extends Context.Service<
  Source,
  { readonly read: Effect.Effect<Option.Option<string>> }
>()("t45/BuiltIns/Source") {}

/** The file `BUILT_INS_FILE` names, applied at every start. */
export const layerFile = Layer.effect(
  Source,
  Effect.gen(function* () {
    const file = yield* ServerConfig.builtInsFile;
    const fs = yield* FileSystem.FileSystem;
    return {
      read: Option.isNone(file)
        ? Effect.succeedNone
        : fs.readFileString(file.value).pipe(Effect.asSome, Effect.orDie),
    };
  }),
);

/**
 * Replaces the supplied capabilities and agents with this deployment's at start, before the
 * instance serves requests, so a release's tools reach existing databases.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const json = yield* (yield* Source).read;
    if (Option.isNone(json)) return;
    const builtIns = yield* decodeBuiltIns(json.value);
    const agents = yield* AgentRepository;
    const capabilities = yield* CapabilityRepository;
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.gen(function* () {
      yield* capabilities.saveAll(builtIns.capabilities);
      const now = yield* DateTime.now;
      for (const preset of builtIns.agents) {
        yield* agents.save({
          ...preset,
          creatorUserId: null,
          isPublished: true,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
    }).pipe(sql.withTransaction);
  }).pipe(Effect.orDie),
);
