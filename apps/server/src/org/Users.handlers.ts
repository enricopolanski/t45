import { MAX_AVATAR_BYTES, Refused } from "@t45/contracts/models/User";
import { Authorization, CurrentUser } from "@t45/contracts/Authorization";
import { Users } from "@t45/contracts/resources/Users";
import { NotFound } from "@t45/contracts/resources/errors";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as SqlClient from "effect/sql/SqlClient";

import { UserService } from "./UserService.ts";
import { UserRepository } from "./UserRepository.ts";
import { WorkflowService } from "../workflows/WorkflowService.ts";

/** The image types an avatar can be, recognized by their first bytes rather than a label. */
const imageType = (content: Uint8Array) => {
  const starts = (bytes: ReadonlyArray<number>, offset = 0) =>
    bytes.every((byte, index) => content[offset + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
};

const invalidAvatar = () => new Refused({ reason: "invalid_avatar" });

const avatarImage = (content: Uint8Array) => {
  const contentType = imageType(content);
  return contentType === null || content.byteLength > MAX_AVATAR_BYTES
    ? Effect.fail(invalidAvatar())
    : Effect.succeed({ kind: "image" as const, contentType, content });
};

export const layer = Users.middleware(Authorization).toLayer(
  Effect.gen(function* () {
    const service = yield* UserService;
    const users = yield* UserRepository;
    const workflows = yield* WorkflowService;
    const sql = yield* SqlClient.SqlClient;

    const ownUser = Effect.gen(function* () {
      const { userId } = yield* CurrentUser;
      return (yield* users.get(userId)) ?? (yield* new NotFound());
    });

    return Users.of({
      "users.list": () => users.list,
      "users.getProfile": () => ownUser,
      "users.updateProfile": ({ displayName, avatar }) =>
        Effect.gen(function* () {
          const { userId } = yield* CurrentUser;
          const next =
            avatar.kind === "upload"
              ? yield* Effect.fromResult(Base64.decode(avatar.data)).pipe(
                  Effect.mapError(invalidAvatar),
                  Effect.flatMap(avatarImage),
                )
              : avatar;
          return yield* service.updateProfile(userId, { displayName, avatar: next });
        }),
      "users.approve": (request) => service.approve(request),
      "users.decline": (request) => service.decline(request),
      "users.changeRole": (request) => service.changeRole(request),
      // Workflows can refuse the deactivation, which rolls it back, or hand the member's open
      // steps on; their revoked sessions are announced only once it all commits.
      "users.deactivate": (request) =>
        service.deactivate(request).pipe(
          Effect.tap(() => workflows.memberDeactivated(request.userId)),
          sql.withTransaction,
          Effect.catchTags({ SqlError: Effect.die }),
        ),
      "users.reactivate": (request) => service.reactivate(request),
      "users.signOutElsewhere": () =>
        Effect.gen(function* () {
          const { userId, sessionId } = yield* CurrentUser;
          const revokedCount = yield* service
            .revokeAllForUser(userId, sessionId)
            .pipe(Effect.catchTags({ SessionStoreError: Effect.die }));
          return { revokedCount };
        }),
    });
  }),
);
