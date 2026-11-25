// @effect-diagnostics globalConsole:off globalDate:off globalTimers:off
import { Files } from "@cloudflare/sandbox";
import { ATTACHMENT_MAX_FILE_BYTES } from "@t45/contracts/models/Attachment";
import { CAPABILITIES_DIR } from "@t45/contracts/models/Capability";
import {
  SCRIPT_INPUT_FILE,
  SCRIPT_OUTPUT_FILE,
  SCRIPT_TEMPLATE_FILE,
} from "@t45/contracts/resources/Runner";
import { DurableObject } from "cloudflare:workers";

import { log, toIsoTime, writeFiles } from "./container.ts";

const MAX_STDOUT_BYTES = 1024 * 1024;
const TIMEOUT_MS = 30_000;
const WORK = "/work";
/** The local calculation VM's CPU and memory. */
const INSTANCE = { vcpu: 1, memoryMib: 512, diskMb: 4000 };

/** A calculation script with its encoded inputs and files, as the Worker hands it to the sandbox. */
export type Script = {
  entrypoint: string;
  input: string;
  files: Record<string, string>;
  /** For a script that fills a template: the template and its capabilities' files. */
  template?: { content: Uint8Array; capabilityFiles: Record<string, string> };
};
/** The script's stdout, or the file it wrote for a template; `reason` when it failed. */
export type ScriptResult = { stdout: string } | { file: Uint8Array } | { reason: string };

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

const readOutputFile = async (files: Files) => {
  const path = `${WORK}/${SCRIPT_OUTPUT_FILE}`;
  const failure = new ScriptFailure(
    `The script must write a file to ${SCRIPT_OUTPUT_FILE} within the attachment size limit.`,
  );
  const info = await files.stat(path).catch(() => null);
  if (info === null || info.type !== "file" || info.size === 0n) throw failure;
  if (info.size > BigInt(ATTACHMENT_MAX_FILE_BYTES)) throw failure;
  const bytes = new Uint8Array(await (await files.readFile(path)).arrayBuffer());
  if (BigInt(bytes.byteLength) !== info.size) throw failure;
  return bytes;
};

/** One container per calculation; the method destroys it before returning. */
export class Calculation extends DurableObject<Env> {
  async run(script: Script): Promise<ScriptResult> {
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
        await writeFiles(files, [
          [`${WORK}/${SCRIPT_INPUT_FILE}`, script.input],
          ...Object.entries(script.files).map(
            ([path, content]) => [`${WORK}/${path}`, content] as const,
          ),
          ...Object.entries(script.template?.capabilityFiles ?? {}).map(
            ([path, content]) => [`${CAPABILITIES_DIR}/${path}`, content] as const,
          ),
          ...(script.template === undefined
            ? []
            : [[`${WORK}/${SCRIPT_TEMPLATE_FILE}`, script.template.content] as const]),
        ]);
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
        container.exec(["node", `${WORK}/${script.entrypoint}`, `${WORK}/${SCRIPT_INPUT_FILE}`], {
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
          : script.template === undefined
            ? { stdout }
            : { file: await readOutputFile(files) };
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
