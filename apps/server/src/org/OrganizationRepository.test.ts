import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as OrganizationRepository from "./OrganizationRepository.ts";

it.effect("starts with an unnamed organization and keeps its rename", () =>
  Effect.gen(function* () {
    const organizations = yield* OrganizationRepository.OrganizationRepository;
    const unnamed = yield* organizations.get;
    assert.isNull(unnamed.name);

    const renamed = {
      ...unnamed,
      name: "Acme",
      updatedAt: DateTime.makeUnsafe("2026-09-22T12:00:00.000Z"),
    };
    yield* organizations.update(renamed);
    assert.deepStrictEqual(yield* organizations.get, renamed);
  }).pipe(
    Effect.provide(
      OrganizationRepository.layer.pipe(Layer.provideMerge(SqlitePersistence.layerTest)),
    ),
  ),
);
