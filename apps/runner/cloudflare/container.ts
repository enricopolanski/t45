// @effect-diagnostics globalConsole:off globalDate:off
import type { Files } from "@cloudflare/sandbox";

/** One JSON line per event, which Workers Logs and `wrangler tail` show as fields. */
export const log = (event: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ event, ...fields }));

export const toIsoTime = (time: number) => new Date(time).toISOString();

/** Writes each file at its absolute path, making the folders it needs first. */
export const writeFiles = async (
  files: Files,
  entries: ReadonlyArray<readonly [string, string | Uint8Array]>,
) => {
  const folders = new Set(entries.map(([path]) => path.slice(0, path.lastIndexOf("/"))));
  for (const folder of folders) if (folder !== "") await files.mkdir(folder, { recursive: true });
  for (const [path, content] of entries) await files.writeFile(path, content);
};
