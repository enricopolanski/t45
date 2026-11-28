import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const pdfImageDirectory = "/work/.t45-document-pages";
/** Reading answers with what the documents state and has no tools; extraction saves records. */
const isReading = process.env.T45_DOCUMENT_MODE === "read";
/** The only tools an extraction uses: reading categories, then saving once. */
const EXTRACTION_TOOLS = new Set([
  "extraction_categories",
  "extraction_category_schema",
  "extraction_save_records",
]);

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

const preparePdf = async ({ id, name }) => {
  const directory = `${pdfImageDirectory}/${id}`;
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
      const reference = `pdf-image:${id}/${filename}`;
      return [
        {
          text: `${name}, page ${page}. Embedded image reference: ${reference}`,
          file: { uri: NodeURL.pathToFileURL(`${directory}/${filename}`).href, name: reference },
        },
      ];
    }),
  };
};

/** Every sheet of a spreadsheet as CSV, since models read PDFs but not Excel. */
const SHEETS_AS_CSV = `
import csv, io, sys
import openpyxl
book = openpyxl.load_workbook(sys.argv[1], data_only=True, read_only=True)
for sheet in book.worksheets:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\\n")
    for row in sheet.iter_rows(values_only=True):
        if any(cell is not None for cell in row):
            writer.writerow(["" if cell is None else cell for cell in row])
    print(f"\\f{sheet.title}\\n{out.getvalue()}", end="")
`;

const isSpreadsheet = ({ name }) => /\.(?:xlsx|xlsm|csv)$/iu.test(name);

const prepareSpreadsheet = async ({ id, name }) => {
  const file = NodePath.resolve("attachments", id);
  if (/\.csv$/iu.test(name)) return [{ text: `${name}\n${await NodeFSP.readFile(file, "utf8")}` }];
  const { stdout } = await run("python3", ["-c", SHEETS_AS_CSV, file], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .split("\f")
    .filter((sheet) => sheet !== "")
    .map((sheet) => {
      const [title, ...rows] = sheet.split("\n");
      return { text: `${name}, sheet ${title} (as CSV)\n${rows.join("\n").trim()}` };
    });
};

export default {
  id: "t45-document-extraction",
  async setup(ctx) {
    await ctx.session.hook("prompt", async ({ metadata, prompt }) => {
      const attachments = (metadata?.t45?.attachments ?? []).filter(({ id }) =>
        /^[a-f0-9-]{36}\.[a-z0-9]{1,10}$/u.test(id),
      );
      const pdfs = attachments.filter(
        ({ mimeType, name }) => mimeType === "application/pdf" || /\.pdf$/iu.test(name),
      );
      const spreadsheets = attachments.filter(isSpreadsheet);
      if (pdfs.length === 0 && spreadsheets.length === 0) {
        prompt.text =
          "Document extraction requires at least one PDF or spreadsheet attached to the workflow step. Ask for one and stop.";
        return;
      }
      const [instructions, entries, documents, sheets, schema] = await Promise.all([
        NodeFSP.readFile("AGENTS.md", "utf8"),
        NodeFSP.readdir(".", { withFileTypes: true }),
        Promise.all(pdfs.map(preparePdf)),
        Promise.all(spreadsheets.map(prepareSpreadsheet)),
        isReading ? null : run("node", ["/opt/t45/extraction-tools.mjs", "--schema"]),
      ]);
      const pages = documents.flatMap(({ pages }) => pages);
      const sheetTexts = sheets.flat().map(({ text }) => text);
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
      const sources = `Source attachment IDs:\n${[...pdfs, ...spreadsheets].map(({ name, id }) => `${name}: ${id}`).join("\n")}`;
      if (isReading) {
        prompt.text = [
          instructions,
          "You have no tools: the documents are all below, so answer in one message, without calling anything. Read every page image and its selectable text. Answer with everything the documents state, article by article, for the automation that records the articles after you: each code and name, each value with its unit, condition and test method, prices, terms and packaging, which data sheet or specification table covers which articles, and the embedded image references that show each article, citing the document and page of each fact. When no embedded image shows an article or its family whole, give a crop of the page image that does, as pdf-page:<attachment ID>/page-<N>@<left>,<top>,<width>,<height> with the box in fractions of the page from its top left corner, tight around the product and without text. Report what the documents say; record nothing yourself.",
          sources,
          ...sheetTexts,
          ...material.map(({ text }) => text),
        ].join("\n\n");
        prompt.files = [...material.map(({ file }) => file), ...references];
        return;
      }
      prompt.text = [
        instructions,
        `Extraction fields by ID. If the destination has review fields, supply review data. The tool fills every link and database identifier.\n${schema.stdout}`,
        'Read every page image and its selectable text as source evidence. When the instructions describe articles by their category, call extraction_categories, choose each article\'s category, and call extraction_category_schema for each category chosen. Submit one extraction_save_records call when all articles and review fields are ready. Start with {"recordsFieldId": "...", "groups": [{"sharedValues": {}, "sharedReview": {}, "articles": [{"sourceId": "...", "values": {}, "review": {}}]}]}. Each code occurs once, even across groups. Articles the instructions leave out go in skipped, not in groups. Use field IDs and arrays of objects for repeatable groups. The tool supplies identifiers and links. Report only source discrepancies that require a person to resolve them. After saving, reply with one short sentence.',
        sources,
        ...sheetTexts,
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
        if (isReading || isSaved || !EXTRACTION_TOOLS.has(name)) delete tools[name];
      }
    });
  },
};
