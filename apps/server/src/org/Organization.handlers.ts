import { Organization } from "@t45/contracts/resources/Organization";
import { Authorization } from "@t45/contracts/Authorization";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { avatarUpload } from "./avatars.ts";
import { OrganizationRepository } from "./OrganizationRepository.ts";

export const layer = Organization.middleware(Authorization).toLayer(
  Effect.gen(function* () {
    const organizations = yield* OrganizationRepository;

    return Organization.of({
      "organization.get": () => organizations.get,
      // Read back for where its logo is served.
      "organization.update": ({ name, avatar }) =>
        Effect.gen(function* () {
          const upload = yield* avatarUpload(avatar);
          const organization = yield* organizations.get;
          const updatedAt = yield* DateTime.now;
          yield* organizations.update({ ...organization, name, avatar, updatedAt }, upload);
          return yield* organizations.get;
        }),
    });
  }),
);
