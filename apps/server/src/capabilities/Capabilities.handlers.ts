import { Authorization } from "@t45/contracts/Authorization";
import { Capabilities } from "@t45/contracts/resources/Capabilities";
import { NotFound } from "@t45/contracts/resources/errors";
import * as Effect from "effect/Effect";

import { CapabilityRepository } from "./CapabilityRepository.ts";

export const layer = Capabilities.middleware(Authorization).toLayer(
  Effect.gen(function* () {
    const capabilities = yield* CapabilityRepository;

    return Capabilities.of({
      "capabilities.import": (request) => capabilities.saveAll(request.capabilities),
      "capabilities.list": () => capabilities.list,
      "capabilities.get": ({ capabilityId }) =>
        capabilities.get(capabilityId).pipe(
          Effect.filterOrFail(
            (capability) => capability !== null,
            () => new NotFound(),
          ),
        ),
    });
  }),
);
