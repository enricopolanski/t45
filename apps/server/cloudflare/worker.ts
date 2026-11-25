import { DEV_INSTANCE_PREFIX, isDevelopment } from "./instance.ts";
import type { TransferRequest } from "./Import.ts";

export { InstanceObject as Instance } from "./instance.ts";

const INSTANCE_ID = /^[\w-]{1,128}$/u;

/**
 * Fills the instance's database from another's (`scripts/transfer-to-cloudflare.ts`), only while a
 * `T45_IMPORT_TOKEN` secret is set and with that token.
 */
const transfer = async (request: Request, env: Env) => {
  const token: unknown = Reflect.get(env, "T45_IMPORT_TOKEN");
  if (typeof token !== "string" || token === "" || request.method !== "POST")
    return new Response("Not Found", { status: 404 });
  if (request.headers.get("authorization") !== `Bearer ${token}`)
    return new Response("Unauthorized", { status: 401 });
  const body: TransferRequest = await request.json();
  try {
    return Response.json(await env.INSTANCE.getByName(env.T45_INSTANCE).transfer(body));
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
};

/** Only `/api/` reaches the Worker: the web client is its static assets. */
export default {
  fetch: (request, env) => {
    if (new URL(request.url).pathname === "/api/transfer") return transfer(request, env);
    const instanceId = request.headers.get("x-instance-id");
    // Local development only, as on Node: a request carrying `x-instance-id` is served by that instance.
    if (instanceId === null || !isDevelopment(env))
      return env.INSTANCE.getByName(env.T45_INSTANCE).fetch(request);
    if (!INSTANCE_ID.test(instanceId))
      return new Response("Invalid x-instance-id", { status: 400 });
    return env.INSTANCE.getByName(`${DEV_INSTANCE_PREFIX}${instanceId}`).fetch(request);
  },
} satisfies ExportedHandler<Env>;
