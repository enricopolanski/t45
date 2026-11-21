// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Runs inside the agent VM.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";
import { ATTACHMENT_MAX_FILE_BYTES } from "@t45/contracts/models/Attachment";
import { type Collection, recordProblem } from "@t45/contracts/models/Collection";
import {
  type Field,
  FieldPathSegment,
  fileKeys,
  holdsData,
  recordKeys,
  rowIds,
  valuesProblem,
  withFieldValue,
} from "@t45/contracts/models/Field";
import { generateId, TrimmedNonEmptyString } from "@t45/contracts/models/primitives";
import { AttachmentUploadResult } from "@t45/contracts/resources/Attachments";
import type { StepView } from "@t45/contracts/resources/Workflows";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { apiHeaders, apiUrl, callOperation, refuse, serve } from "./mcp-stdio.ts";

const step = { stepId: process.env.T45_STEP_ID! };
const ExtractedValues = Schema.Record(FieldPathSegment, Schema.Json);
type ExtractedValues = typeof ExtractedValues.Type;
const Citation = Schema.Struct({
  file: TrimmedNonEmptyString,
  page: Schema.Int.check(Schema.isGreaterThan(0)),
  value: TrimmedNonEmptyString,
});
const Discrepancy = Schema.Struct({
  field: TrimmedNonEmptyString,
  first: Citation,
  second: Citation,
  question: TrimmedNonEmptyString,
});
const Article = Schema.Struct({
  sourceId: TrimmedNonEmptyString,
  isSourceIdGenerated: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "True only for articles without a documented code." }),
  ),
  values: ExtractedValues,
  review: Schema.optionalKey(ExtractedValues),
  discrepancies: Schema.optionalKey(
    Schema.Array(Discrepancy).annotate({
      description:
        "Only contradictions requiring a human decision. Cite two values for the same field, with exact PDF filenames and pages.",
    }),
  ),
});
const Batch = Schema.Struct({
  recordsFieldId: FieldPathSegment,
  /** Empty when every article is left out. */
  groups: Schema.Array(
    Schema.Struct({
      sharedValues: Schema.optionalKey(ExtractedValues),
      sharedReview: Schema.optionalKey(ExtractedValues),
      articles: Schema.NonEmptyArray(Article),
    }),
  ),
  skipped: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        sourceId: TrimmedNonEmptyString,
        title: TrimmedNonEmptyString,
        reason: TrimmedNonEmptyString,
      }),
    ).annotate({
      description:
        "The articles the instructions leave out of the analysis, each with why, in the instructions' language. They are not saved; a comment on the step lists them.",
    }),
  ),
});
const decodeBatch = Schema.decodeUnknownSync(Batch);
const document = Schema.toJsonSchemaDocument(Batch);
const decodeUpload = Schema.decodeUnknownSync(AttachmentUploadResult);
/** An image embedded in one of the step's PDFs, by the PDF's attachment ID. */
const imageReference = /^pdf-image:([a-f0-9-]{36}\.[a-z0-9]{1,10})\/(image-\d{3,}\.png)$/u;
const run = NodeUtil.promisify(NodeChildProcess.execFile);
const readSettings = async () => {
  const schema = Schema.fromJsonString(
    Schema.Struct({
      ticketIdField: Schema.optionalKey(FieldPathSegment),
      sourceIdField: Schema.optionalKey(FieldPathSegment),
    }),
  );
  try {
    return Schema.decodeSync(schema)(await NodeFSP.readFile("extraction-settings.json", "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
};

const request = async (...args: Parameters<typeof callOperation>) => {
  const result = await callOperation(...args);
  if (Result.isFailure(result)) return refuse(result.failure);
  return result.success;
};

const getStep = async () => (await request("workflows.getStep", step)) as StepView;

/**
 * The collection listing product categories by name, each with a description. A category's name
 * is the title of the collection holding its specifications.
 */
const CATEGORIES = "Categories";
const CategoryName = Schema.Struct({
  name: TrimmedNonEmptyString.annotate({
    description: "A category's Name, as categories lists it.",
  }),
});
const decodeCategoryName = Schema.decodeUnknownSync(CategoryName);
const categoryNameDocument = Schema.toJsonSchemaDocument(CategoryName);

const collectionNamed = async (title: string) => {
  const collections = (await request("collections.list", undefined)) as ReadonlyArray<Collection>;
  const named = collections.filter((collection) => collection.title === title);
  if (named.length === 0) return refuse(`There is no collection named ${title}.`);
  if (named.length > 1)
    return refuse(`Several collections are named ${title}: an admin must rename all but one.`);
  return named[0]!;
};

/** Each category's values by field label. */
const listCategories = async () => {
  const categories = await collectionNamed(CATEGORIES);
  const rows: Array<Record<string, Schema.Json>> = [];
  for (let hasMore = true; hasMore;) {
    const page = (await request("collections.searchRecords", {
      collectionId: categories.id,
      offset: rows.length,
      limit: 100,
    })) as { records: ReadonlyArray<{ values: Record<string, Schema.Json> }>; hasMore: boolean };
    for (const { values } of page.records)
      rows.push(
        Object.fromEntries(
          categories.fields.flatMap(({ id, label }) =>
            values[id] === undefined ? [] : [[label, values[id]]],
          ),
        ),
      );
    hasMore = page.hasMore && page.records.length > 0;
  }
  return JSON.stringify(rows);
};

/** The fields of a category's specifications collection, without its links to products. */
const categorySchema = async ({ name }: typeof CategoryName.Type) => {
  const categories = await collectionNamed(CATEGORIES);
  const category = await request("collections.getRecord", {
    collectionId: categories.id,
    key: name,
  });
  if (category === null) return refuse(`There is no category ${name}: choose one from categories.`);
  const { fields } = await collectionNamed(name);
  const describe = (fields: ReadonlyArray<Field>): Schema.Json =>
    fields
      .filter((field) => field.type !== "foreignKey" && field.type !== "records")
      .map((field) => ({
        label: field.label,
        type: field.type,
        ...(field.description ? { description: field.description } : {}),
        ...(field.type === "number" && field.unit !== undefined ? { unit: field.unit } : {}),
        ...(field.type === "select"
          ? { options: field.options, ...(field.isMultiple ? { isMultiple: true } : {}) }
          : {}),
        ...(field.type === "group" ? { fields: describe(field.fields) } : {}),
      }));
  return JSON.stringify({
    category: name,
    rule: "An article of this category is described by exactly these fields, in this order. Its characteristics table in its review entry holds one row per field: the field's label as the characteristic, and the article's value as the value: a number followed by the field's unit, such as \"48 mm\", one or more of its options, or text. Give a row for each field the sources state and leave out the others, since a review entry with an empty value can't be confirmed; no other rows. Give the whole table in each article rather than in shared values, so its rows keep this order.",
    fields: describe(fields),
  });
};

/** Only the extraction destinations go into the prompt. The saved records stay with the tool. */
const extractionSchema = async () => {
  const [view, settings] = await Promise.all([getStep(), readSettings()]);
  const describeFields = (
    fields: ReadonlyArray<Field>,
    omitted: ReadonlyArray<string>,
  ): Schema.Json =>
    Object.fromEntries(
      fields
        .filter(({ id }) => !omitted.includes(id))
        .map((field) => {
          const { id, label, type, description } = field;
          return [
            id,
            {
              label,
              type,
              ...(description ? { description } : {}),
              ...(field.type === "select" ? { options: field.options } : {}),
              ...(field.type === "group"
                ? {
                    repeatable: field.repeatable,
                    fields: describeFields(field.fields, []),
                  }
                : {}),
            },
          ];
        }),
    );
  const targets = view.fields.flatMap(({ key, label, type, collection, isReviewed }) => {
    if (type !== "records" || collection === null || isReviewed) return [];
    const review = view.recordReviews.find(({ recordsFieldId }) => recordsFieldId === key);
    const group = view.fields.find(({ key }) => key === review?.groupFieldId);
    return [
      {
        recordsFieldId: key,
        label,
        values: describeFields(collection.fields, [
          collection.primaryKeyFieldId,
          ...Object.values(settings),
        ]),
        ...(group && review
          ? { review: describeFields(group.rowFields, [review.recordKeyFieldId]) }
          : {}),
      },
    ];
  });
  return targets;
};

/**
 * Where the reading of the PDF left the image, or, when another run read it, the image taken out of
 * the step's PDF again.
 */
const readImage = async (reference: RegExpExecArray) => {
  const directory = `/work/.t45-document-pages/${reference[1]}`;
  const path = `${directory}/${reference[2]}`;
  const isTaken = await NodeFSP.access(path).then(
    () => true,
    () => false,
  );
  if (!isTaken) {
    await NodeFSP.mkdir(directory, { recursive: true });
    await run("pdfimages", ["-png", `attachments/${reference[1]}`, `${directory}/image`]).catch(
      () => refuse(`There is no PDF image ${reference[0]}.`),
    );
  }
  const info = await NodeFSP.stat(path).catch(() =>
    refuse(`There is no PDF image ${reference[0]}.`),
  );
  if (!info.isFile() || info.size === 0 || info.size > ATTACHMENT_MAX_FILE_BYTES)
    return refuse(`The size of PDF image ${reference[0]} is invalid.`);
  return NodeFSP.readFile(path);
};

/** A PDF of the step, which the runner put in the attachments folder. */
const readStepFile = async (id: string) => {
  const info = await NodeFSP.stat(`attachments/${id}`).catch(() =>
    refuse(`The step's file ${id} isn't available.`),
  );
  if (!info.isFile() || info.size === 0 || info.size > ATTACHMENT_MAX_FILE_BYTES)
    return refuse(`The size of the step's file ${id} is invalid.`);
  return NodeFSP.readFile(`attachments/${id}`);
};

interface FileUpload {
  readonly fieldKey: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly name: string;
  readonly type: "image" | "file";
  readonly mimeType: string;
}

const upload = async (
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  type: "image" | "file",
  mimeType: string,
) => {
  const params = new URLSearchParams({ type, name, mimeType });
  const response = await fetch(apiUrl(`/api/attachments?${params}`), {
    method: "POST",
    headers: apiHeaders,
    body: bytes,
  });
  if (!response.ok) return refuse(`${name} could not be attached.`);
  return decodeUpload(await response.json()).attachmentId;
};

const isObject = (value: Schema.Json | undefined): value is ExtractedValues =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const withSharedValues = (
  shared: ExtractedValues = {},
  specific: ExtractedValues = {},
): ExtractedValues => ({
  ...shared,
  ...Object.fromEntries(
    Object.entries(specific).map(([key, value]) => {
      const common = shared[key];
      if (Array.isArray(common) && Array.isArray(value)) return [key, [...common, ...value]];
      if (isObject(common) && isObject(value)) return [key, withSharedValues(common, value)];
      return [key, value];
    }),
  ),
});

/** Field paths and row IDs belong to the RPC, so only this tool constructs them. */
const flatten = (
  fields: ReadonlyArray<Field>,
  values: ExtractedValues,
  prefix = "",
): ReadonlyArray<readonly [string, Schema.Json]> =>
  Object.entries(values).flatMap(([id, value]) => {
    const field = fields.find((item) => item.id === id);
    const key = prefix + id;
    if (field === undefined)
      return refuse(
        id === "review"
          ? "Give review beside an article's values, not inside them."
          : `Unknown field ${key}: use the field IDs the extraction fields list.`,
      );
    if (field.type !== "group" || value === null) return [[key, value] as const];
    if (!field.repeatable) {
      if (!isObject(value)) return refuse(`${key} takes an object.`);
      return flatten(field.fields, value, `${key}.`);
    }
    if (!Array.isArray(value) || !value.every(isObject))
      return refuse(`${key} takes an array of row objects.`);
    const rows = value.map((_, index) => `row-${String(index + 1).padStart(3, "0")}`);
    return [
      [key, rows],
      ...value.flatMap((row, index) => flatten(field.fields, row, `${key}.${rows[index]}.`)),
    ];
  });

const discrepancyComment = (
  records: ReadonlyArray<Pick<typeof Article.Type, "sourceId" | "discrepancies">>,
  files: StepView["files"],
) => {
  const filenames = new Set(files.map(({ name }) => name));
  const blocks = records.flatMap(({ sourceId, discrepancies }) =>
    (discrepancies ?? []).map(({ field, first, second, question }) => {
      const canonical = (value: string) =>
        value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
      if (
        !filenames.has(first.file) ||
        !filenames.has(second.file) ||
        canonical(first.value) === canonical(second.value)
      )
        return refuse(
          `${sourceId}: cite two different values for ${field} from PDFs attached to this step.`,
        );
      return [
        `**${sourceId} · ${field}**`,
        ...[first, second].map(({ file, page, value }) => `- ${file} (${page}) — ${value}`),
        "",
        question,
      ].join("\n");
    }),
  );
  return blocks.join("\n\n");
};

/** The articles left out, one line each, for a comment on the step. */
const skippedComment = (skipped: NonNullable<typeof Batch.Type.skipped>) =>
  skipped
    .map(({ sourceId, title, reason }) => `- **${sourceId}** · ${title}: ${reason}`)
    .join("\n");

const saveRecords = async ({ recordsFieldId, groups, skipped = [] }: typeof Batch.Type) => {
  const records = groups.flatMap(({ sharedValues, sharedReview, articles }) =>
    articles.map((article) => ({
      ...article,
      values: withSharedValues(sharedValues, article.values),
      review:
        sharedReview === undefined && article.review === undefined
          ? undefined
          : withSharedValues(sharedReview, article.review),
    })),
  );
  if (records.length === 0 && skipped.length === 0)
    return refuse("Give the articles in groups, or those left out in skipped.");
  const view = await getStep();
  const target = view.fields.find(({ key }) => key === recordsFieldId);
  if (target?.type !== "records" || target.isReviewed || target.collection === null)
    return refuse("Choose a writable records field on this step.");
  const { id: collectionId, fields, primaryKeyFieldId } = target.collection;
  const settings = await readSettings();
  const { ticketIdField, sourceIdField } = settings;
  const boundFields = Object.values(settings);
  if (new Set([primaryKeyFieldId, ...boundFields]).size !== boundFields.length + 1)
    return refuse("Identifier bindings must use distinct fields, separate from the record key.");
  for (const [setting, fieldId] of Object.entries(settings)) {
    if (!fields.some(({ id, type }) => id === fieldId && type === "text"))
      return refuse(`The configured ${setting} ${fieldId} must be a text field of the collection.`);
  }
  const review = view.recordReviews.find(({ recordsFieldId: id }) => id === recordsFieldId);
  const group = view.fields.find(({ key }) => key === review?.groupFieldId);
  const keys = records.map(({ sourceId }) => `analysis-${view.ticket.id}-${sourceId}`);
  if (new Set(keys).size !== keys.length) return refuse("Give each article identifier once.");
  const comment = discrepancyComment(records, view.files);

  const existing = new Map(target.records.map((record) => [record.key, record]));
  const reviewRows = group === undefined ? [] : [...rowIds(view.step.values[group.key])];
  const prepared = [];
  for (const [index, record] of records.entries()) {
    const key = keys[index]!;
    const entry = review?.entries.find(({ recordKey }) => recordKey === key);
    if (entry?.isConfirmed) continue;
    if (entry?.hasDuplicateEntries)
      return refuse(`${record.sourceId} has more than one review entry.`);
    const extractedValues = Object.fromEntries(
      Object.entries(record.values).filter(([id]) => !boundFields.includes(id)),
    );
    const merged = flatten(fields, extractedValues).reduce(
      (values, [fieldKey, value]) => withFieldValue(fields, values, fieldKey, value),
      existing.get(key)?.values ?? {},
    );
    const values = {
      ...merged,
      ...(ticketIdField === undefined ? {} : { [ticketIdField]: view.ticket.id }),
      ...(sourceIdField === undefined || record.isSourceIdGenerated
        ? {}
        : { [sourceIdField]: record.sourceId }),
      [primaryKeyFieldId]: key,
    };
    // A file field takes a PDF page image, or a copy of one of the step's PDFs.
    const files = await Promise.all(
      fileKeys(fields, values).flatMap((fieldKey): ReadonlyArray<Promise<FileUpload>> => {
        const value = values[fieldKey];
        if (typeof value !== "string") return [];
        const reference = imageReference.exec(value);
        if (reference !== null)
          return [
            readImage(reference).then((bytes) => ({
              fieldKey,
              bytes,
              name: reference[2]!,
              type: "image",
              mimeType: "image/png",
            })),
          ];
        const stepFile = view.files.find(({ id }) => id === value);
        if (stepFile === undefined) return [];
        return [
          readStepFile(stepFile.id).then((bytes) => ({
            fieldKey,
            bytes,
            name: stepFile.name,
            type: "file",
            mimeType: "application/pdf",
          })),
        ];
      }),
    );
    // Resolve image references before validation using the shape of the attachment IDs they become.
    const checked = {
      ...values,
      ...Object.fromEntries(
        files.map(({ fieldKey }) => [fieldKey, "00000000-0000-0000-0000-000000000000.png"]),
      ),
    };
    const recordError = recordProblem(target.collection, checked);
    if (recordError !== null) return refuse(`${record.sourceId}: ${recordError}`);

    if (group === undefined || review === undefined) {
      if (record.review !== undefined) return refuse("This records field has no review group.");
      prepared.push({ key, values, files, review: undefined });
      continue;
    }
    if (record.review === undefined)
      return refuse(
        `Give review for ${record.sourceId}, using these child IDs: ${group.rowFields
          .filter(({ id }) => id !== review.recordKeyFieldId)
          .map(({ id, label }) => `${id} (${label})`)
          .join(", ")}.`,
      );
    const reviewValues = [
      ...flatten(group.rowFields, record.review).filter(([, value]) => holdsData(value)),
      [review.recordKeyFieldId, key] as const,
    ];
    const reviewError = valuesProblem(group.rowFields, Object.fromEntries(reviewValues));
    if (reviewError !== null) return refuse(`${record.sourceId}: ${reviewError}`);
    const rowId = entry?.rowId ?? generateId();
    if (!reviewRows.includes(rowId)) reviewRows.push(rowId);
    prepared.push({ key, values, files, review: { rowId, values: reviewValues } });
  }

  for (const record of prepared) {
    const attachments = await Promise.all(
      record.files.map(
        async ({ fieldKey, bytes, name, type, mimeType }) =>
          [fieldKey, await upload(name, bytes, type, mimeType)] as const,
      ),
    );
    await request("collections.saveRecord", {
      collectionId,
      values: { ...record.values, ...Object.fromEntries(attachments) },
    });
  }
  const set = (fieldKey: string, value: unknown) =>
    request("workflows.setStepField", { ...step, fieldKey, value });
  await set(target.key, [...new Set([...recordKeys(view.step.values[target.key]), ...keys])]);
  if (group !== undefined && prepared.some((record) => record.review !== undefined)) {
    await set(group.key, reviewRows);
    for (const { review: entry } of prepared) {
      if (entry === undefined) continue;
      for (const [fieldKey, value] of entry.values)
        await set(`${group.key}.${entry.rowId}.${fieldKey}`, value);
    }
  }
  const leftOut = skippedComment(skipped);
  if (leftOut !== "" && !view.comments.some(({ body }) => body === leftOut))
    await request("workflows.commentOnStep", { ...step, body: leftOut });
  if (comment !== "" && !view.comments.some(({ body }) => body === comment))
    await request("workflows.commentOnStep", { ...step, body: comment });
  await NodeFSP.mkdir(".t45-document-pages", { recursive: true });
  await NodeFSP.writeFile(".t45-document-pages/saved", "");
  return `Saved ${keys.length} articles${skipped.length > 0 ? `, left out ${skipped.length}` : ""}. Extraction is complete.`;
};

if (process.argv[2] === "--schema") {
  process.stdout.write(JSON.stringify(await extractionSchema()));
} else
  serve({
    name: "extraction-tools",
    tools: [
      {
        name: "save_records",
        description:
          'Save all articles once. Put identical family facts in sharedValues and sharedReview, and variant-specific facts in each article. Article values override shared scalar values, and repeatable rows are combined. Give sourceId as the printed article code. Use field IDs in values and review. A repeatable group takes an array of objects, e.g. {"images":[{"image_file":"pdf-image:<attachment ID>/image-000.png"}]}. A file field takes a pdf-image reference, or the attachment ID of one of the source PDFs to keep a copy of it. A review entry takes an object of child fields, including its Brief and characteristics when configured. The tool assigns all row IDs, record keys and configured ticket references. Omit unsupported facts. Finish after the tool reports success.',
        inputSchema: { ...document.schema, $defs: document.definitions },
        call: async (input) => saveRecords(decodeBatch(input)),
      },
      {
        name: "fields",
        description:
          "The fields of the articles and of their review entries, by ID, as save_records takes them in values and review.",
        inputSchema: { type: "object", properties: {} },
        call: async () => JSON.stringify(await extractionSchema()),
      },
      {
        name: "categories",
        description:
          "List the product categories, each with its Name and a Description of the products it holds. Choose by its Description the category whose fields describe an article, then read those fields with category_schema. This choice fills no field of the article: its own category field keeps the kind of article it is, such as Kreppband.",
        inputSchema: { type: "object", properties: {} },
        call: listCategories,
      },
      {
        name: "category_schema",
        description:
          "The specification fields of one category, by its Name from categories: each field's label, type, unit, options and description. These are the characteristics an article of that category is described by.",
        inputSchema: { ...categoryNameDocument.schema, $defs: categoryNameDocument.definitions },
        call: async (input) => categorySchema(decodeCategoryName(input)),
      },
    ],
    failure: "The document extraction tool failed.",
  });
