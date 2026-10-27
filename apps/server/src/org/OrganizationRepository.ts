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

import { avatarJson, setAvatar } from "./avatars.ts";

const ID = "organization";

const Row = Schema.Struct({
  ...Organization.fields,
  avatar: Schema.fromJsonString(Organization.fields.avatar),
});
const decodeOrganizations = Schema.decodeUnknownEffect(Schema.Array(Row));
const encodeOrganization = Schema.encodeEffect(Organization);

export class OrganizationRepository extends Context.Service<
  OrganizationRepository,
  {
    readonly get: Effect.Effect<Organization>;
    /** Writes the organization, with `upload` as its new logo. */
    readonly update: (
      organization: Organization,
      upload?: Uint8Array | null,
    ) => Effect.Effect<void>;
    /** The organization's logo, a PNG. */
    readonly avatarImage: Effect.Effect<Uint8Array | null>;
  }
>()("t45/org/OrganizationRepository") {}

export const layer = Layer.effect(
  OrganizationRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return OrganizationRepository.of({
      get: sql`
        SELECT name, ${sql.unsafe(avatarJson("'/api/organization/avatar'"))} AS avatar,
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM organizations WHERE id = ${ID}
      `.pipe(
        Effect.flatMap(decodeOrganizations),
        Effect.flatMap(([organization]) => Effect.fromNullishOr(organization)),
        Effect.orDie,
      ),
      update: (organization, upload = null) =>
        Effect.gen(function* () {
          const row = yield* encodeOrganization(organization);
          yield* sql`UPDATE organizations SET name = ${row.name},
            ${setAvatar(sql, organization.avatar, upload)},
            updated_at = ${row.updatedAt} WHERE id = ${ID}`;
        }).pipe(Effect.orDie),
      avatarImage: sql<{ readonly image: Uint8Array | null }>`
        SELECT avatar_image AS image FROM organizations WHERE id = ${ID}
      `.pipe(
        Effect.map(([row]) => row?.image ?? null),
        Effect.orDie,
      ),
    });
  }),
);
