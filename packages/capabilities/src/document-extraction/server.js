import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const pdfImageDirectory = "/work/.t45-document-pages";

const uniqueImages = async (images) => {
  const digests = await Promise.all(
    images.map(async ({ file }) =>
      NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(new URL(file.uri)))
        .digest("hex"),
    ),
  );
  const seen = new Set();
  return images.filter((_, index) => {
    const digest = digests[index];
    if (seen.has(digest)) return false;
    seen.add(digest);
    return true;
  });
};

const attachReference = async ({ name }) => {
  const uri = NodeURL.pathToFileURL(NodePath.resolve(name)).href;
  if (!/\.json$/iu.test(name)) return { name, uri };
  const text = await NodeFSP.readFile(name, "utf8");
  try {
    const compact = JSON.stringify(JSON.parse(text));
    return { name, uri: `data:text/plain;base64,${Buffer.from(compact).toString("base64")}` };
  } catch {
    return { name, uri };
  }
};

const preparePdf = async ({ id, name }, index) => {
  const directory = `${pdfImageDirectory}/document-${index + 1}`;
  const pdf = NodePath.resolve("attachments", id);
  await NodeFSP.mkdir(directory, { recursive: true });
  const [text, info, , images] = await Promise.all([
    run("pdftotext", ["-layout", pdf, "-"]),
    run("pdfinfo", [pdf]),
    run("pdftoppm", ["-scale-to", "2200", "-jpeg", pdf, `${directory}/page`]),
    run("pdfimages", ["-list", pdf]),
    run("pdfimages", ["-png", pdf, `${directory}/image`]),
  ]);
  const pageCount = Number(/^Pages:[ \t]+(\d+)[ \t]*$/mu.exec(info.stdout)?.[1]);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1)
    throw new Error(`Could not count the pages of ${name}.`);
  const pages = text.stdout.split("\f");
  return {
    pages: Array.from({ length: pageCount }, (_, offset) => {
      const page = offset + 1;
      const label = `${name}, page ${page}`;
      const image = `page-${String(page).padStart(String(pageCount).length, "0")}.jpg`;
      return {
        text: `${label}\n${pages[offset]?.trim() || "(No selectable text. Read the page image.)"}`,
        file: { uri: NodeURL.pathToFileURL(`${directory}/${image}`).href, name: label },
      };
    }),
    images: images.stdout.split("\n").flatMap((line) => {
      const [, page, image] = /^\s*(\d+)\s+(\d+)\s+image\s+/u.exec(line) ?? [];
      if (page === undefined || image === undefined) return [];
      const filename = `image-${image.padStart(3, "0")}.png`;
      const reference = `pdf-image:document-${index + 1}/${filename}`;
      return [
        {
          text: `${name}, page ${page}. Embedded image reference: ${reference}`,
          file: { uri: NodeURL.pathToFileURL(`${directory}/${filename}`).href, name: reference },
        },
      ];
    }),
  };
};

export default {
  id: "t45-document-extraction",
  async setup(ctx) {
    await ctx.session.hook("prompt", async ({ metadata, prompt }) => {
      const pdfs = (metadata?.t45?.attachments ?? []).filter(
        ({ id, mimeType, name }) =>
          /^[a-f0-9-]{36}\.[a-z0-9]{1,10}$/u.test(id) &&
          (mimeType === "application/pdf" || /\.pdf$/iu.test(name)),
      );
      if (pdfs.length === 0) {
        prompt.text =
          "Document extraction requires at least one PDF attached to the workflow step. Ask for one and stop.";
        return;
      }
      const [instructions, entries, documents, schema] = await Promise.all([
        NodeFSP.readFile("AGENTS.md", "utf8"),
        NodeFSP.readdir(".", { withFileTypes: true }),
        Promise.all(pdfs.map(preparePdf)),
        run("node", ["/opt/t45/extraction-tools.mjs", "--schema"]),
      ]);
      const pages = documents.flatMap(({ pages }) => pages);
      const [images, references] = await Promise.all([
        uniqueImages(documents.flatMap(({ images }) => images)),
        Promise.all(
          entries
            .filter(
              (entry) =>
                entry.isFile() &&
                /\.(?:json|md|txt|csv)$/iu.test(entry.name) &&
                !["AGENTS.md", "opencode.json", "extraction-settings.json"].includes(entry.name),
            )
            .map(attachReference),
        ),
      ]);
      const material = [...pages, ...images];
      prompt.text = [
        instructions,
        `Extraction fields by ID. If the destination has review fields, supply review data. The tool fills every link and database identifier.\n${schema.stdout}`,
        'Read every page image and its selectable text as source evidence. Submit one extraction_save_records call when all articles and review fields are ready. Start with {"recordsFieldId": "...", "groups": [{"sharedValues": {}, "sharedReview": {}, "articles": [{"sourceId": "...", "values": {}, "review": {}}]}]}. Each code occurs once, even across groups. Use field IDs and arrays of objects for repeatable groups. The tool supplies identifiers and links. Report only source discrepancies that require a person to resolve them. After saving, reply with one short sentence.',
        `Source attachment IDs:\n${pdfs.map(({ name, id }) => `${name}: ${id}`).join("\n")}`,
        ...material.map(({ text }) => text),
      ].join("\n\n");
      prompt.files = [...material.map(({ file }) => file), ...references];
    });
    await ctx.session.hook("context", async ({ tools }) => {
      const isSaved = await NodeFSP.access(".t45-document-pages/saved").then(
        () => true,
        () => false,
      );
      for (const name of Object.keys(tools)) {
        if (isSaved || name !== "extraction_save_records") delete tools[name];
      }
    });
  },
};
