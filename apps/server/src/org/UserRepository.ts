/*
 * The organization's users: one Clerk identity each, keyed by the token's `sub`, with its role,
 * lifecycle state and profile. The repository stores them; it does not verify Clerk tokens or
 * mint sessions.
 */
import { User } from "@t45/contracts/models/User";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { avatarJson, setAvatar } from "./avatars.ts";

const Row = Schema.Struct({ ...User.fields, avatar: Schema.fromJsonString(User.fields.avatar) });
const decodeUsers = Schema.decodeUnknownEffect(Schema.Array(Row));
const encodeUser = Schema.encodeEffect(User);
const encodeCreatedAt = Schema.encodeSync(User.fields.createdAt);

const COLUMNS = `id, role, state, email, display_name AS "displayName",
  ${avatarJson("'/api/avatars/' || id")} AS avatar,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

export class UserRepository extends Context.Service<
  UserRepository,
  {
    /** Oldest first. */
    readonly list: Effect.Effect<ReadonlyArray<User>>;
    readonly get: (userId: string) => Effect.Effect<User | null>;
    /**
     * Registers a Clerk identity. The first on a fresh deployment becomes the active admin, in the
     * insert itself; every later one is a pending member.
     */
    readonly register: (identity: {
      readonly id: string;
      readonly email: string;
      readonly displayName: string;
      readonly createdAt: User["createdAt"];
    }) => Effect.Effect<User>;
    /** Writes the user, with `upload` as its new avatar image. */
    readonly update: (user: User, upload?: Uint8Array | null) => Effect.Effect<void>;
    /** Removes a declined registration after its sessions have been revoked. */
    readonly remove: (userId: string) => Effect.Effect<void>;
    /** The user's avatar image, a PNG. */
    readonly avatarImage: (userId: string) => Effect.Effect<Uint8Array | null>;
  }
>()("t45/org/UserRepository") {}

export const layer = Layer.effect(
  UserRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const select = (where: string, params: ReadonlyArray<string>) =>
      sql
        .unsafe(`SELECT ${COLUMNS} FROM users WHERE ${where} ORDER BY created_at, id`, [...params])
        .pipe(Effect.flatMap(decodeUsers), Effect.orDie);

    return UserRepository.of({
      list: select("1 = 1", []),
      get: (userId) => select("id = ?", [userId]).pipe(Effect.map(([user]) => user ?? null)),
      register: (identity) => {
        const at = encodeCreatedAt(identity.createdAt);
        return sql`
          INSERT INTO users (id, role, state, email, display_name, created_at,
            updated_at)
          SELECT ${identity.id},
            CASE WHEN EXISTS (SELECT 1 FROM users) THEN 'member' ELSE 'admin' END,
            CASE WHEN EXISTS (SELECT 1 FROM users) THEN 'pending' ELSE 'active' END,
            ${identity.email}, ${identity.displayName}, ${at}, ${at}
          RETURNING ${sql.unsafe(COLUMNS)}
        `.pipe(
          Effect.flatMap(decodeUsers),
          Effect.flatMap(([user]) => Effect.fromNullishOr(user)),
          Effect.orDie,
        );
      },
      update: (user, upload = null) =>
        Effect.gen(function* () {
          const row = yield* encodeUser(user);
          yield* sql`UPDATE users SET role = ${row.role}, state = ${row.state}, email = ${row.email},
            display_name = ${row.displayName}, ${setAvatar(sql, user.avatar, upload)},
            updated_at = ${row.updatedAt} WHERE id = ${row.id}`;
        }).pipe(Effect.orDie),
      remove: (userId) =>
        sql`DELETE FROM users WHERE id = ${userId}`.pipe(Effect.asVoid, Effect.orDie),
      avatarImage: (userId) =>
        sql<{ readonly image: Uint8Array | null }>`
          SELECT avatar_image AS image FROM users WHERE id = ${userId}
        `.pipe(
          Effect.map(([row]) => row?.image ?? null),
          Effect.orDie,
        ),
    });
  }),
);
