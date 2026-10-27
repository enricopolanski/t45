import { Organization } from "@t45/contracts/resources/Organization";
import { Authorization } from "@t45/contracts/Authorization";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { OrganizationRepository } from "./OrganizationRepository.ts";

export const layer = Organization.middleware(Authorization).toLayer(
  Effect.gen(function* () {
    const organizations = yield* OrganizationRepository;

    return Organization.of({
      "organization.get": () => organizations.get,
      "organization.rename": ({ name }) =>
        Effect.gen(function* () {
          const renamed = { ...(yield* organizations.get), name, updatedAt: yield* DateTime.now };
          yield* organizations.update(renamed);
          return renamed;
        }),
    });
  }),
);
