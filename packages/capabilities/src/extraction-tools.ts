// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Runs inside the agent VM.
import * as NodeFSP from "node:fs/promises";
import { ATTACHMENT_MAX_FILE_BYTES } from "@t45/contracts/models/Attachment";
import { recordProblem } from "@t45/contracts/models/Collection";
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
  groups: Schema.NonEmptyArray(
    Schema.Struct({
      sharedValues: Schema.optionalKey(ExtractedValues),
      sharedReview: Schema.optionalKey(ExtractedValues),
      articles: Schema.NonEmptyArray(Article),
    }),
  ),
});
const decodeBatch = Schema.decodeUnknownSync(Batch);
const document = Schema.toJsonSchemaDocument(Batch);
const decodeUpload = Schema.decodeUnknownSync(AttachmentUploadResult);
const imageReference = /^pdf-image:(document-[1-9]\d*)\/(image-\d{3,}\.png)$/u;
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

const readImage = async (reference: RegExpExecArray) => {
  const path = `/work/.t45-document-pages/${reference[1]}/${reference[2]}`;
  const info = await NodeFSP.stat(path).catch(() =>
    refuse(`There is no PDF image ${reference[0]}.`),
  );
  if (!info.isFile() || info.size === 0 || info.size > ATTACHMENT_MAX_FILE_BYTES)
    return refuse(`The size of PDF image ${reference[0]} is invalid.`);
  return NodeFSP.readFile(path);
};

const uploadImage = async (name: string, bytes: Uint8Array<ArrayBuffer>) => {
  const params = new URLSearchParams({ type: "image", name, mimeType: "image/png" });
  const response = await fetch(apiUrl(`/api/attachments?${params}`), {
    method: "POST",
    headers: apiHeaders,
    body: bytes,
  });
  if (!response.ok) return refuse(`The PDF image ${name} could not be attached.`);
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
    if (field === undefined) return refuse(`Unknown field ${key}.`);
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

const saveRecords = async ({ recordsFieldId, groups }: typeof Batch.Type) => {
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
    const files = await Promise.all(
      fileKeys(fields, values).flatMap((fieldKey) => {
        const value = values[fieldKey];
        const reference = typeof value === "string" ? imageReference.exec(value) : null;
        if (reference === null) return [];
        return [readImage(reference).then((bytes) => ({ fieldKey, bytes, name: reference[2]! }))];
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
        async ({ fieldKey, bytes, name }) => [fieldKey, await uploadImage(name, bytes)] as const,
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
  if (comment !== "" && !view.comments.some(({ body }) => body === comment))
    await request("workflows.commentOnStep", { ...step, body: comment });
  await NodeFSP.writeFile(".t45-document-pages/saved", "");
  return `Saved ${keys.length} articles. Extraction is complete.`;
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
          'Save all articles once. Put identical family facts in sharedValues and sharedReview, and variant-specific facts in each article. Article values override shared scalar values, and repeatable rows are combined. Give sourceId as the printed article code. Use field IDs in values and review. A repeatable group takes an array of objects, e.g. {"images":[{"image_file":"pdf-image:document-1/image-000.png"}]}. A review entry takes an object of child fields, including its Brief and characteristics when configured. The tool assigns all row IDs, record keys and configured ticket references. Omit unsupported facts. Finish after the tool reports success.',
        inputSchema: { ...document.schema, $defs: document.definitions },
        call: async (input) => saveRecords(decodeBatch(input)),
      },
    ],
    failure: "The document extraction tool failed.",
  });
