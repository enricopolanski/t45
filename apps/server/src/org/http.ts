import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { member } from "../auth/http.ts";
import { UserRepository } from "./UserRepository.ts";

// Avatar images stay on HTTP so an <img> can load one with the browser's session cookie.
export const layer = HttpRouter.add(
  "GET",
  "/api/avatars/:userId",
  Effect.gen(function* () {
    const currentUser = yield* member;
    if (HttpServerResponse.isHttpServerResponse(currentUser)) return currentUser;
    const { userId = "" } = yield* HttpRouter.params;
    const image = yield* (yield* UserRepository).avatarImage(userId);
    if (image === null) return HttpServerResponse.text("Not Found", { status: 404 });
    return HttpServerResponse.uint8Array(image.content, {
      headers: { "Content-Type": image.contentType, "Cache-Control": "private, no-cache" },
    });
  }),
);
