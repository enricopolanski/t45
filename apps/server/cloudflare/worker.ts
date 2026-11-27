import { DEV_INSTANCE_PREFIX, isDevelopment } from "./instance.ts";
import type { ExportRequest } from "./Export.ts";
import type { TransferRequest } from "./Import.ts";

export { InstanceObject as Instance } from "./instance.ts";

const INSTANCE_ID = /^[\w-]{1,128}$/u;

type Instance = ReturnType<Env["INSTANCE"]["getByName"]>;

/** A route served only while the `secret` it names is set, and with that token. */
const gated =
  <Body>(secret: string, run: (instance: Instance, body: Body) => Promise<unknown>) =>
  async (request: Request, env: Env) => {
    const token: unknown = Reflect.get(env, secret);
    if (typeof token !== "string" || token === "" || request.method !== "POST")
      return new Response("Not Found", { status: 404 });
    if (request.headers.get("authorization") !== `Bearer ${token}`)
      return new Response("Unauthorized", { status: 401 });
    const body: Body = await request.json();
    try {
      return Response.json(await run(env.INSTANCE.getByName(env.T45_INSTANCE), body));
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  };

/** Fills the instance's database from another's (`scripts/transfer-to-cloudflare.ts`). */
const transfer = gated<TransferRequest>("T45_IMPORT_TOKEN", (instance, body) =>
  instance.transfer(body),
);

/**
 * Reads the instance's database out (`scripts/backup-cloudflare-to-r2.ts`). Its own secret, as the
 * import's token also writes.
 */
const exportDatabase = gated<ExportRequest>("T45_EXPORT_TOKEN", (instance, body) =>
  instance.exportDatabase(body),
);

/** Only `/api/` reaches the Worker: the web client is its static assets. */
export default {
  fetch: (request, env) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/transfer") return transfer(request, env);
    if (pathname === "/api/export") return exportDatabase(request, env);
    const instanceId = request.headers.get("x-instance-id");
    // Local development only, as on Node: a request carrying `x-instance-id` is served by that instance.
    if (instanceId === null || !isDevelopment(env))
      return env.INSTANCE.getByName(env.T45_INSTANCE).fetch(request);
    if (!INSTANCE_ID.test(instanceId))
      return new Response("Invalid x-instance-id", { status: 400 });
    return env.INSTANCE.getByName(`${DEV_INSTANCE_PREFIX}${instanceId}`).fetch(request);
  },
} satisfies ExportedHandler<Env>;
