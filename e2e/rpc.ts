import { expect, type Page } from "@playwright/test";

interface RpcExit {
  readonly _tag: string;
  readonly exit?: {
    readonly _tag: "Success" | "Failure";
    readonly value?: unknown;
    readonly cause?: unknown;
  };
}

/** Calls one T45 HTTP RPC endpoint with the signed-in browser context's cookies and instance header. */
async function rpcExit(page: Page, tag: string, payload: unknown) {
  const response = await page.request.post("/api/rpc", {
    headers: { "content-type": "application/x-ndjson" },
    data: `${JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })}\n`,
  });
  expect(response.ok(), `HTTP ${response.status()} for ${tag}`).toBe(true);
  const lines = (await response.text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RpcExit);
  const exit = lines.find((line) => line._tag === "Exit")?.exit;
  if (!exit) throw new Error("Missing RPC response for " + tag);
  return exit;
}

export async function rpc<T = unknown>(page: Page, tag: string, payload: unknown): Promise<T> {
  const exit = await rpcExit(page, tag, payload);
  expect(exit?._tag, `RPC failure for ${tag}: ${JSON.stringify(exit?.cause)}`).toBe("Success");
  return exit.value as T;
}

export async function expectRpcFailure(page: Page, tag: string, payload: unknown, reason: string) {
  const exit = await rpcExit(page, tag, payload);
  expect(exit._tag, tag).toBe("Failure");
  expect(JSON.stringify(exit.cause), tag).toContain(reason);
}
