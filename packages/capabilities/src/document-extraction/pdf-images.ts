// @effect-diagnostics nodeBuiltinImport:off - Reads extracted images inside the agent VM.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";
import { ATTACHMENT_MAX_FILE_BYTES } from "@t45/contracts/models/Attachment";
import { PNG } from "pngjs";
import { refuse } from "../mcp-stdio.ts";

const run = NodeUtil.promisify(NodeChildProcess.execFile);

async function listImageMasks(pdf: string) {
  const { stdout } = await run("pdfimages", ["-list", pdf]);
  const masks = new Map<string, string>();
  let previous: { page: string; number: string; kind: string } | undefined;
  // Poppler emits a PDF image's soft mask immediately after its color image, as a separate PNG.
  for (const [, page, number, kind] of stdout.matchAll(/^ *([0-9]+) +([0-9]+) +(\w+)/gmu)) {
    if (kind === "smask" && previous?.kind === "image" && previous.page === page) {
      masks.set(
        `image-${previous.number.padStart(3, "0")}.png`,
        `image-${number!.padStart(3, "0")}.png`,
      );
    }
    previous = { page: page!, number: number!, kind: kind! };
  }
  return masks;
}

export function makePdfImageReader(attachments: string, pages: string) {
  const prepared = new Map<string, ReturnType<typeof listImageMasks>>();

  return async function readPdfImage(id: string, filename: string) {
    const pdf = `${attachments}/${id}`;
    const directory = `${pages}/${id}`;
    const path = `${directory}/${filename}`;
    const reference = `pdf-image:${id}/${filename}`;
    const missing = () => refuse(`There is no PDF image ${reference}.`);
    const invalidSize = () => refuse(`The size of PDF image ${reference} is invalid.`);
    const readPng = async (path: string) => {
      const info = await NodeFSP.stat(path).catch(missing);
      if (!info.isFile() || info.size === 0 || info.size > ATTACHMENT_MAX_FILE_BYTES)
        return invalidSize();
      return NodeFSP.readFile(path);
    };

    let masks = prepared.get(id);
    if (!masks) {
      // The document reader may have already extracted all the PNGs in this VM.
      const extract = NodeFSP.access(path).catch(async () => {
        await NodeFSP.mkdir(directory, { recursive: true });
        await run("pdfimages", ["-png", pdf, `${directory}/image`]);
      });
      masks = Promise.all([listImageMasks(pdf), extract]).then(([masks]) => masks, missing);
      prepared.set(id, masks);
    }
    const maskFilename = (await masks).get(filename);
    const bytes = await readPng(path);
    if (maskFilename === undefined) return bytes;

    const image = PNG.sync.read(bytes);
    const mask = PNG.sync.read(await readPng(`${directory}/${maskFilename}`));
    if (image.width !== mask.width || image.height !== mask.height) return bytes;
    for (let pixel = 0; pixel < image.data.length; pixel += 4)
      image.data[pixel + 3] = mask.data[pixel]!;

    const transparent = PNG.sync.write(image);
    if (transparent.length > ATTACHMENT_MAX_FILE_BYTES) return invalidSize();
    return Buffer.from(transparent);
  };
}
