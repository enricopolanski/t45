import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export class ServerActivation extends Context.Reference<Effect.Effect<void> | undefined>(
  "t45/serverActivation",
  { defaultValue: () => undefined },
) {}

/**
 * Gates background work until startup recovery finishes and HTTP is serving.
 * For example, automations cannot create new chats while existing chats are being recovered.
 */
export const forkParked = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const activation = yield* ServerActivation;
    yield* Effect.forkScoped(
      activation === undefined ? effect : activation.pipe(Effect.andThen(effect)),
    );
  });
