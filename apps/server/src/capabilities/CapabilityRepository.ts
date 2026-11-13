import { Capability } from "@t45/contracts/models/Capability";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";

const decodeCapabilities = Schema.decodeUnknownEffect(
  Schema.Array(Schema.fromJsonString(Capability)),
);
const encodeCapability = Schema.encodeEffect(Schema.fromJsonString(Capability));

export class CapabilityRepository extends Context.Service<
  CapabilityRepository,
  {
    readonly list: Effect.Effect<ReadonlyArray<Capability>>;
    readonly get: (capabilityId: string) => Effect.Effect<Capability | null>;
    readonly listForAgent: (agentId: string) => Effect.Effect<ReadonlyArray<Capability>>;
    readonly save: (capability: Capability) => Effect.Effect<void>;
    readonly saveAll: (capabilities: ReadonlyArray<Capability>) => Effect.Effect<void>;
  }
>()("t45/capabilities/CapabilityRepository") {}

export const layer = Layer.effect(
  CapabilityRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const read = (where: Fragment) =>
      sql<{ readonly definition: string }>`SELECT definition FROM capabilities
        WHERE ${where} ORDER BY id`.pipe(
        Effect.flatMap((rows) => decodeCapabilities(rows.map((row) => row.definition))),
        Effect.orDie,
      );
    const save = (capability: Capability) =>
      Effect.gen(function* () {
        const definition = yield* encodeCapability(capability);
        yield* sql`INSERT INTO capabilities (id, definition)
          VALUES (${capability.id}, ${definition})
          ON CONFLICT (id) DO UPDATE SET definition = excluded.definition`;
      }).pipe(Effect.orDie);

    return CapabilityRepository.of({
      list: read(sql`1 = 1`),
      get: (capabilityId) =>
        read(sql`id = ${capabilityId}`).pipe(Effect.map(([capability]) => capability ?? null)),
      listForAgent: (agentId) =>
        read(sql`id IN (SELECT capability_id FROM agent_capabilities WHERE agent_id = ${agentId})`),
      save,
      saveAll: (capabilities) =>
        Effect.forEach(capabilities, save, { discard: true }).pipe(
          sql.withTransaction,
          Effect.orDie,
        ),
    });
  }),
);
