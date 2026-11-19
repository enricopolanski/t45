// Merges values into records already in Competitor Products, through the dev server as admin@admin.
// Input JSONL: {"key": "<record key>", "values": {"<field>": <value>, ...}} per line. Each record is read with
// getRecord and saved back with saveRecord holding all its values plus these ones, so its files stay the same
// attachments (nothing is uploaded again). Records not found are reported, never created.
// Run from /home/enrico/personal/t45/packages/capabilities: node .set-fields.ts <file.jsonl>
// Resumable: keys already done are listed in <file.jsonl>.done.
import * as NodeFS from "node:fs";
import { Authorization } from "@t45/contracts/Authorization";
import { CollectionOperations } from "@t45/contracts/resources/Collections";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";

const SERVER = "http://localhost:13773";
const COLLECTION = "a949b393-20e5-4d6e-ac98-8e93e43cb8e5";
const [file] = process.argv.slice(2);
const doneFile = `${file}.done`;
const done = new Set(
  NodeFS.existsSync(doneFile)
    ? NodeFS.readFileSync(doneFile, "utf8").split("\n").filter(Boolean)
    : [],
);
const rows = NodeFS.readFileSync(file!, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
  .filter((r) => !done.has(r.key));

const login = await fetch(`${SERVER}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify("admin@admin"),
});
if (!login.ok) throw new Error(`login ${login.status}`);
const cookie = login.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .join("; ");
const protocol = RpcClient.layerProtocolHttp({
  url: `${SERVER}/api/rpc`,
  transformClient: HttpClient.mapRequest(HttpClientRequest.setHeaders({ cookie })),
}).pipe(Layer.provide(RpcSerialization.layerNdjson), Layer.provide(FetchHttpClient.layer));

const program = Effect.gen(function* () {
  const api = yield* RpcClient.make(CollectionOperations.middleware(Authorization), {
    disableTracing: true,
    flatten: true,
  });
  let saved = 0;
  const missing: Array<string> = [];
  const refused: Array<string> = [];
  for (const row of rows) {
    const record = (yield* api("collections.getRecord", {
      collectionId: COLLECTION,
      key: row.key,
    } as never)) as any;
    if (record === null) {
      missing.push(row.key);
      continue;
    }
    const result = yield* api("collections.saveRecord", {
      collectionId: COLLECTION,
      values: { ...record.values, ...row.values },
    } as never).pipe(Effect.result);
    if (result._tag === "Success") {
      NodeFS.appendFileSync(doneFile, `${row.key}\n`);
      saved += 1;
    } else refused.push(`${row.key}: ${JSON.stringify(result.failure)}`);
    if ((saved + refused.length + missing.length) % 500 === 0)
      console.log(`${saved + refused.length + missing.length} of ${rows.length}`);
  }
  console.log(
    `Saved ${saved} of ${rows.length}; not found ${missing.length}; refused ${refused.length}.`,
  );
  for (const line of [
    ...missing.slice(0, 10).map((k) => `MISSING ${k}`),
    ...refused.slice(0, 20).map((r) => `REFUSED ${r}`),
  ])
    console.log(line);
});
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(protocol)));
