/*
 * The deployment's one organization. The schema seeds its row, so it always exists; the row's id
 * is this repository's business, never the model's.
 */
import { Organization } from "@t45/contracts/models/Organization";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const ID = "organization";

const decodeOrganizations = Schema.decodeUnknownEffect(Schema.Array(Organization));
const encodeOrganization = Schema.encodeEffect(Organization);

export class OrganizationRepository extends Context.Service<
  OrganizationRepository,
  {
    readonly get: Effect.Effect<Organization>;
    readonly update: (organization: Organization) => Effect.Effect<void>;
  }
>()("t45/org/OrganizationRepository") {}

export const layer = Layer.effect(
  OrganizationRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return OrganizationRepository.of({
      get: sql`
        SELECT name, created_at AS "createdAt", updated_at AS "updatedAt"
        FROM organizations WHERE id = ${ID}
      `.pipe(
        Effect.flatMap(decodeOrganizations),
        Effect.flatMap(([organization]) => Effect.fromNullishOr(organization)),
        Effect.orDie,
      ),
      update: (organization) =>
        Effect.gen(function* () {
          const row = yield* encodeOrganization(organization);
          yield* sql`UPDATE organizations SET name = ${row.name},
            updated_at = ${row.updatedAt} WHERE id = ${ID}`;
        }).pipe(Effect.orDie),
    });
  }),
);
