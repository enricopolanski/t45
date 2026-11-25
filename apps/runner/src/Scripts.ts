import { CAPABILITIES_DIR } from "@t45/contracts/models/Capability";
import {
  ExecutionFailed,
  SCRIPT_INPUT_FILE,
  SCRIPT_OUTPUT_FILE,
  SCRIPT_TEMPLATE_FILE,
  type ScriptFileRequest,
  ScriptOutputs,
  ScriptRequest,
} from "@t45/contracts/resources/Runner";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { mergeCapabilityFiles } from "./AgentSetup.ts";

/** A script's run: its files by absolute path, the command, and the file it must write, if any. */
export interface Script {
  readonly files: ReadonlyArray<readonly [string, string | Uint8Array]>;
  readonly command: readonly [string, ...Array<string>];
  readonly outputPath: string | null;
}

/**
 * Where scripts run: a new sandbox per script, without network, working in /work, for at most 30
 * seconds. `output` is the file at `outputPath`, or null when it is missing or over the attachment
 * size limit.
 */
export class ScriptSandbox extends Context.Service<
  ScriptSandbox,
  {
    readonly run: (
      script: Script,
    ) => Effect.Effect<
      { readonly stdout: string; readonly output: Uint8Array | null },
      ExecutionFailed
    >;
  }
>()("@t45/runner/Scripts/ScriptSandbox") {}

const encodeInputs = Schema.encodeSync(Schema.fromJsonString(ScriptRequest.fields.inputs));
const decodeOutputs = Schema.decodeUnknownEffect(Schema.fromJsonString(ScriptOutputs));

/** The runner's script calls, the same wherever the sandbox runs. */
export const makeScripts = Effect.gen(function* () {
  const sandbox = yield* ScriptSandbox;
  const run = (request: ScriptRequest | ScriptFileRequest) => {
    if (
      !Object.hasOwn(request.files, request.entrypoint) ||
      !/\.(?:js|mjs|ts)$/u.test(request.entrypoint)
    )
      return Effect.fail(
        new ExecutionFailed({
          reason: "Choose a JavaScript or TypeScript file from the calculation files.",
        }),
      );
    const input = `/work/${SCRIPT_INPUT_FILE}`;
    const isFile = "template" in request;
    return sandbox.run({
      files: [
        [input, encodeInputs(request.inputs)],
        ...Object.entries(request.files).map(
          ([path, content]) => [`/work/${path}`, content] as const,
        ),
        ...(isFile
          ? [
              ...[...mergeCapabilityFiles(request.capabilityFiles)].map(
                ([path, content]) => [`${CAPABILITIES_DIR}/${path}`, content] as const,
              ),
              [`/work/${SCRIPT_TEMPLATE_FILE}`, request.template] as const,
            ]
          : []),
      ],
      command: ["node", `/work/${request.entrypoint}`, input],
      outputPath: isFile ? `/work/${SCRIPT_OUTPUT_FILE}` : null,
    });
  };
  return {
    runScript: (request: ScriptRequest) =>
      run(request).pipe(
        Effect.flatMap(({ stdout }) =>
          decodeOutputs(stdout).pipe(
            Effect.mapError(
              () =>
                new ExecutionFailed({
                  reason: "The calculation must print its outputs as a JSON object.",
                }),
            ),
          ),
        ),
      ),
    runScriptForFile: (request: ScriptFileRequest) =>
      run(request).pipe(
        Effect.flatMap(({ output }) =>
          output === null
            ? Effect.fail(
                new ExecutionFailed({
                  reason: `The script must write a file to ${SCRIPT_OUTPUT_FILE} within the attachment size limit.`,
                }),
              )
            : Effect.succeed(output),
        ),
      ),
  };
});
