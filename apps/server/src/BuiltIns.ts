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

/** Deployment data is imported into the database before any instance serves requests. */
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
      for (const capability of builtIns.capabilities) {
        if ((yield* capabilities.get(capability.id)) === null) yield* capabilities.save(capability);
      }
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
