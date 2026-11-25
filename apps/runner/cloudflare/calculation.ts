// @effect-diagnostics globalConsole:off globalDate:off globalTimers:off
import { Files } from "@cloudflare/sandbox";
import { ATTACHMENT_MAX_FILE_BYTES } from "@t45/contracts/models/Attachment";
import { DurableObject } from "cloudflare:workers";

import type { Script } from "../src/Scripts.ts";
import { log, toIsoTime, writeFiles } from "./container.ts";

const MAX_STDOUT_BYTES = 1024 * 1024;
const TIMEOUT_MS = 30_000;
const WORK = "/work";
/** The largest container Cloudflare allows by default, so a calculation never waits on CPU or memory. */
const INSTANCE = { vcpu: 4, memoryMib: 12_288, diskMb: 20_000 };

/** What the script printed and the file it wrote, if asked for one; `reason` when it failed. */
export type ScriptResult = { stdout: string; output: Uint8Array | null } | { reason: string };

class ScriptFailure extends Error {}

const readStdout = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_STDOUT_BYTES) {
      await reader.cancel();
      throw new ScriptFailure("The calculation printed more than 1 MiB.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

/** The file at `path`, or null when it is missing, empty or over the attachment size limit. */
const readOutputFile = async (files: Files, path: string) => {
  const info = await files.stat(path).catch(() => null);
  if (info === null || info.type !== "file" || info.size === 0n) return null;
  if (info.size > BigInt(ATTACHMENT_MAX_FILE_BYTES)) return null;
  const bytes = new Uint8Array(await (await files.readFile(path)).arrayBuffer());
  return BigInt(bytes.byteLength) === info.size ? bytes : null;
};

/** One container per calculation; the method destroys it before returning. */
export class Calculation extends DurableObject<Env> {
  async run({ files: entries, command, outputPath }: Script): Promise<ScriptResult> {
    const container = this.ctx.container;
    if (container === undefined) return { reason: "The container binding is missing." };
    const sandboxId = this.ctx.id.toString();
    const startedAt = Date.now();
    let preparedAt: number | undefined;
    let finishedAt: number | undefined;
    let result: ScriptResult;
    // Cleared on return: a pending timer would keep the invocation open and later signal a destroyed container.
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    log("sandbox.start", { sandboxId, startedAt: toIsoTime(startedAt) });
    try {
      const files = new Files(container);
      try {
        container.start({
          image: container.images["agent"]!,
          enableInternet: false,
          instance: INSTANCE,
        });
        await writeFiles(files, entries);
      } catch (error) {
        throw new ScriptFailure(
          container.running
            ? `The sandbox could not stage the calculation files: ${String(error)}`
            : `The sandbox did not start: ${String(error)}`,
        );
      }
      preparedAt = Date.now();
      const expired = new Promise<never>((_resolve, reject) =>
        deadline.signal.addEventListener(
          "abort",
          () => reject(new ScriptFailure("The calculation did not finish within 30 seconds.")),
          { once: true },
        ),
      );
      timer = setTimeout(() => deadline.abort(), TIMEOUT_MS);
      const process = await Promise.race([
        container.exec([...command], {
          cwd: WORK,
          user: "agent",
          signal: deadline.signal,
          stdout: "pipe",
          stderr: "ignore",
        }),
        expired,
      ]);
      const [stdout, exitCode] = await Promise.race([
        Promise.all([readStdout(process.stdout!), process.exitCode]),
        expired,
      ]);
      finishedAt = Date.now();
      result =
        exitCode !== 0
          ? { reason: `The calculation exited with code ${exitCode}.` }
          : {
              stdout,
              output: outputPath === null ? null : await readOutputFile(files, outputPath),
            };
    } catch (error) {
      finishedAt ??= Date.now();
      result = {
        reason:
          error instanceof ScriptFailure ? error.message : `The sandbox failed: ${String(error)}`,
      };
    } finally {
      clearTimeout(timer);
      let isDestroyed = true;
      try {
        await container.destroy();
      } catch (error) {
        isDestroyed = false;
        log("sandbox.destroy_failed", { sandboxId, error: String(error) });
      }
      const stoppedAt = Date.now();
      log("sandbox.stop", {
        sandboxId,
        isDestroyed,
        instance: INSTANCE,
        startedAt: toIsoTime(startedAt),
        stoppedAt: toIsoTime(stoppedAt),
        prepareMs: preparedAt === undefined ? null : preparedAt - startedAt,
        commandMs: preparedAt === undefined ? null : finishedAt! - preparedAt,
        outcome: "reason" in result! ? result.reason : "succeeded",
      });
    }
    return result;
  }
}
