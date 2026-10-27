import {
  type AvatarColor,
  Refused,
  type Role,
  type User,
  activeUserRefusal,
  lastAdminRefusal,
  pendingRequestRefusal,
  reactivationRefusal,
} from "@t45/contracts/models/User";
import { NotFound } from "@t45/contracts/resources/errors";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Authentication from "../auth/Authentication.ts";
import { UserRepository } from "./UserRepository.ts";

type Target = { readonly userId: string };
type RoleChange = Target & { readonly role: Role };
interface Profile {
  readonly displayName: string;
  readonly avatar:
    | { readonly kind: "keep" }
    | { readonly kind: "initial"; readonly color: AvatarColor }
    | { readonly kind: "image"; readonly contentType: string; readonly content: Uint8Array };
}

const make = Effect.gen(function* () {
  const authentication = yield* Authentication.make;
  const sql = yield* SqlClient.SqlClient;
  const users = yield* UserRepository;

  const transaction = <A, E>(effect: Effect.Effect<A, E>) =>
    sql.withTransaction(effect).pipe(Effect.catchTags({ SqlError: Effect.die }));

  const refuse = (reason: Refused["reason"] | null) =>
    reason === null ? Effect.void : Effect.fail(new Refused({ reason }));

  const load = (userId: string) =>
    users.get(userId).pipe(
      Effect.filterOrElse(
        (user) => user !== null,
        () => Effect.fail(new NotFound()),
      ),
    );

  const requireAnotherAdmin = (user: User) =>
    users.list.pipe(Effect.flatMap((everyone) => refuse(lastAdminRefusal(everyone, user))));

  /** Stores the user's next value, stamped with the time of the change. */
  const save = (user: User, avatarImage?: Uint8Array | null) =>
    Effect.gen(function* () {
      const saved = { ...user, updatedAt: yield* DateTime.now };
      yield* users.update(saved, avatarImage);
      return saved;
    });

  const endSessions = (user: User) => authentication.revokeAllForUser(user.id).pipe(Effect.orDie);

  return {
    ...authentication,
    approve: ({ userId, role }: RoleChange) =>
      transaction(
        Effect.gen(function* () {
          const target = yield* load(userId);
          yield* refuse(pendingRequestRefusal(target));
          return yield* save({ ...target, role, state: "active" });
        }),
      ),
    decline: ({ userId }: Target) =>
      transaction(
        Effect.gen(function* () {
          const target = yield* load(userId);
          yield* refuse(pendingRequestRefusal(target));
          yield* endSessions(target);
          yield* users.remove(target.id);
        }),
      ),
    changeRole: ({ userId, role }: RoleChange) =>
      transaction(
        Effect.gen(function* () {
          const target = yield* load(userId);
          yield* refuse(activeUserRefusal(target));
          if (target.role === role) return target;
          yield* requireAnotherAdmin(target);
          const changed = yield* save({ ...target, role });
          yield* endSessions(changed);
          return changed;
        }),
      ),
    deactivate: ({ userId }: Target) =>
      transaction(
        Effect.gen(function* () {
          const target = yield* load(userId);
          yield* refuse(activeUserRefusal(target));
          yield* requireAnotherAdmin(target);
          const deactivated = yield* save({ ...target, state: "deactivated" });
          yield* endSessions(deactivated);
          return deactivated;
        }),
      ),
    reactivate: ({ userId }: Target) =>
      transaction(
        Effect.gen(function* () {
          const target = yield* load(userId);
          yield* refuse(reactivationRefusal(target));
          return yield* save({ ...target, state: "active" });
        }),
      ),
    updateProfile: (userId: string, { displayName, avatar }: Profile) =>
      transaction(
        Effect.gen(function* () {
          const user = yield* load(userId);
          return yield* save(
            avatar.kind === "keep"
              ? { ...user, displayName }
              : avatar.kind === "initial"
                ? { ...user, displayName, avatarColor: avatar.color, avatarContentType: null }
                : { ...user, displayName, avatarContentType: avatar.contentType },
            avatar.kind === "keep" ? undefined : avatar.kind === "image" ? avatar.content : null,
          );
        }),
      ),
  };
});

/** Membership and profiles share authentication's session store and revocation feed. */
export class UserService extends Context.Service<UserService, Effect.Success<typeof make>>()(
  "t45/org/UserService",
) {
  static readonly make = make;
}
