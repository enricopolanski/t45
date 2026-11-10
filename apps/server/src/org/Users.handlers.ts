import { Authorization, CurrentUser } from "@t45/contracts/Authorization";
import { Users } from "@t45/contracts/resources/Users";
import { NotFound } from "@t45/contracts/resources/errors";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { avatarUpload } from "./avatars.ts";
import { UserService } from "./UserService.ts";
import { UserRepository } from "./UserRepository.ts";
import { AutomationRepository } from "../automations/AutomationRepository.ts";
import { WorkflowService } from "../workflows/WorkflowService.ts";

export const layer = Users.middleware(Authorization).toLayer(
  Effect.gen(function* () {
    const service = yield* UserService;
    const users = yield* UserRepository;
    const workflows = yield* WorkflowService;
    const automations = yield* AutomationRepository;
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
          const upload = yield* avatarUpload(avatar);
          return yield* service.updateProfile(userId, { displayName, avatar }, upload);
        }),
      "users.approve": (request) => service.approve(request),
      "users.decline": (request) => service.decline(request),
      "users.changeRole": (request) => service.changeRole(request),
      // Workflows can refuse the deactivation, which rolls it back; the member's revoked sessions
      // are announced only once it all commits. Their schedules are archived for good.
      "users.deactivate": (request) =>
        service.deactivate(request).pipe(
          Effect.tap(() => workflows.memberDeactivated(request.userId)),
          Effect.tap((user) => automations.triggers.archiveCreatedBy(user.id, user.updatedAt)),
          sql.withTransaction,
          Effect.catchTags({ SqlError: Effect.die }),
        ),
      "users.reactivate": (request) => service.reactivate(request),
      "users.signOutElsewhere": () =>
        Effect.gen(function* () {
          const { userId, sessionId } = yield* CurrentUser;
          const revokedCount = yield* service.revokeAllForUser(userId, sessionId);
          return { revokedCount };
        }),
    });
  }),
);
