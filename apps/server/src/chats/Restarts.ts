import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * What happens to a chat that was running when its instance stopped: the instance starts again,
 * then continues the chat or settles it as interrupted.
 */
export class Restarts extends Context.Service<
  Restarts,
  {
    /** Makes sure the instance starts again, should it stop while a chat runs. */
    readonly whileRunning: Effect.Effect<void>;
    /** Whether a chat found running at start runs again, or ends as interrupted. */
    readonly continuesRunning: boolean;
  }
>()("t45/chats/Restarts") {}

/** Whoever runs a Node server starts it again, and a chat continues from its saved disk. */
export const layerNode = Layer.succeed(Restarts, {
  whileRunning: Effect.void,
  continuesRunning: true,
});
