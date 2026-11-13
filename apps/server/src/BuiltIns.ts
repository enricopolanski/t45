import { BuiltIns } from "@t45/contracts/resources/BuiltIns";
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

/**
 * Every start replaces the supplied capabilities and agents with this deployment's, before any
 * instance serves requests, so a release's tools reach existing databases.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const file = yield* ServerConfig.builtInsFile;
    if (Option.isNone(file)) return;
    const fs = yield* FileSystem.FileSystem;
    const builtIns = yield* fs.readFileString(file.value).pipe(Effect.flatMap(decodeBuiltIns));
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
