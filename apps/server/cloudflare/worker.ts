import { DEV_INSTANCE_PREFIX, isDevelopment } from "./instance.ts";

export { InstanceObject as Instance } from "./instance.ts";

const INSTANCE_ID = /^[\w-]{1,128}$/u;

/** Only `/api/` reaches the Worker: the web client is its static assets. */
export default {
  fetch: (request, env) => {
    const instanceId = request.headers.get("x-instance-id");
    // Local development only, as on Node: a request carrying `x-instance-id` is served by that instance.
    if (instanceId === null || !isDevelopment(env))
      return env.INSTANCE.getByName(env.T45_INSTANCE).fetch(request);
    if (!INSTANCE_ID.test(instanceId))
      return new Response("Invalid x-instance-id", { status: 400 });
    return env.INSTANCE.getByName(`${DEV_INSTANCE_PREFIX}${instanceId}`).fetch(request);
  },
} satisfies ExportedHandler<Env>;
