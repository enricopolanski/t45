import { Authorization, CurrentActor } from "@t45/contracts/Authorization";
import { Collections } from "@t45/contracts/resources/Collections";
import * as Effect from "effect/Effect";

import { CollectionService } from "./CollectionService.ts";

export const layer = Collections.middleware(Authorization).toLayer(
  Effect.gen(function* () {
    const collections = yield* CollectionService;
    return Collections.of({
      "collections.create": (input) => collections.create(input),
      "collections.update": (input) => collections.update(input),
      "collections.list": () => Effect.flatMap(CurrentActor, collections.list),
      "collections.get": ({ collectionId }) =>
        Effect.flatMap(CurrentActor, (actor) => collections.get(actor, collectionId)),
      "collections.getRecord": (input) =>
        Effect.flatMap(CurrentActor, (actor) => collections.getRecord(actor, input)),
      "collections.searchRecords": (input) =>
        Effect.flatMap(CurrentActor, (actor) => collections.searchRecords(actor, input)),
      "collections.saveRecord": (input) =>
        Effect.flatMap(CurrentActor, (actor) => collections.saveRecord(actor, input)),
    });
  }),
);
