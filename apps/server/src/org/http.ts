import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { member } from "../auth/http.ts";
import { OrganizationRepository } from "./OrganizationRepository.ts";
import { UserRepository } from "./UserRepository.ts";

const png = (image: Uint8Array | null, cacheControl: string) =>
  image === null
    ? HttpServerResponse.text("Not Found", { status: 404 })
    : HttpServerResponse.uint8Array(image, {
        headers: { "Content-Type": "image/png", "Cache-Control": cacheControl },
      });

// Avatar images stay on HTTP so an <img> can load one with the browser's session cookie.
const userAvatar = HttpRouter.add(
  "GET",
  "/api/avatars/:userId",
  Effect.gen(function* () {
    const currentUser = yield* member;
    if (HttpServerResponse.isHttpServerResponse(currentUser)) return currentUser;
    const { userId = "" } = yield* HttpRouter.params;
    return png(yield* (yield* UserRepository).avatarImage(userId), "private, no-cache");
  }),
);

// Public: the splash screen shows the logo before sign-in.
const organizationAvatar = HttpRouter.add(
  "GET",
  "/api/organization/avatar",
  Effect.gen(function* () {
    return png(yield* (yield* OrganizationRepository).avatarImage, "no-cache");
  }),
);

export const layer = Layer.mergeAll(userAvatar, organizationAvatar);
