/**
 * A `Collection` is a durable, shared set of records that people and agents reuse across tasks,
 * such as Amazon listings by ASIN. An admin defines its fields; one top-level text or link field is
 * its primary key, whose value identifies a record within the collection.
 */
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import {
  Field,
  FieldPathSegment,
  Fields,
  FieldValues,
  foreignKeys,
  Layout,
  fieldValueProblem,
  LayoutFieldId,
  RecordTableColumns as CollectionColumnOrder,
  valuesProblem,
} from "./Field.ts";
import type { Role, State } from "./User.ts";
import { StringId, Title, TrimmedNonEmptyString } from "./primitives.ts";

export { CollectionColumnOrder };

/** A collection's primary key is one of its own top-level text or link fields. */
export const primaryKeyRefusal = (collection: {
  readonly fields: ReadonlyArray<Field>;
  readonly primaryKeyFieldId: string;
}) =>
  collection.fields.some(
    (field) =>
      field.id === collection.primaryKeyFieldId &&
      (field.type === "text" || field.type === "foreignKey"),
  )
    ? null
    : ("invalid_primary_key" as const);

/**
 * How a collection's records show: the table and form any set of fields has, and, as a collection's
 * own, its records as cards in a grid and each on a page of its own.
 */
export const CollectionLayout = Schema.Struct({
  ...Layout.fields,
  isUpdatedAtVisible: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Show the Last update column in tables. Shown by default.",
    }),
  ),
  display: Schema.optionalKey(
    Schema.Struct({
      image: Schema.optionalKey(
        LayoutFieldId.annotate({
          description:
            "A file field, or a group holding one, whose images show on a record's card and in its page's gallery.",
        }),
      ),
      title: Schema.optionalKey(
        LayoutFieldId.annotate({
          description:
            "The field naming a record on its card and page; the primary key without it.",
        }),
      ),
      subtitle: Schema.optionalKey(
        LayoutFieldId.annotate({ description: "A field shown smaller under the title." }),
      ),
      highlight: Schema.optionalKey(
        LayoutFieldId.annotate({
          description: "A field shown large, such as a price, with its unit and decimals.",
        }),
      ),
      badges: Schema.optionalKey(
        Schema.Array(LayoutFieldId)
          .annotate({ description: "Up to three select fields shown as badges." })
          .check(Schema.isMaxLength(3)),
      ),
    }).annotate({
      description:
        "Which fields play which part on a record's card and page. Without it, the primary key titles a record and the first field holding files shows its images.",
    }),
  ),
  cards: Schema.optionalKey(
    Schema.Struct({
      size: Schema.optionalKey(
        Schema.Literals(["small", "medium", "large"]).annotate({
          description: "How wide the cards are; medium without it.",
        }),
      ),
      imageRatio: Schema.optionalKey(
        Schema.Literals(["square", "portrait", "landscape"]).annotate({
          description: "The shape of a card's image; square without it.",
        }),
      ),
      imageFit: Schema.optionalKey(
        Schema.Literals(["contain", "cover"]).annotate({
          description: "contain shows the whole image, cover crops it to fill; contain without it.",
        }),
      ),
      extra: Schema.optionalKey(
        Schema.Array(LayoutFieldId)
          .annotate({ description: "Up to three more fields, as small lines under the title." })
          .check(Schema.isMaxLength(3)),
      ),
    }).annotate({ description: "The records as cards in a grid." }),
  ),
  page: Schema.optionalKey(
    Schema.Struct({
      template: Schema.Literals(["form", "showcase"]).annotate({
        description:
          "form: the record's editable form. showcase: its images as a gallery beside its title, highlight, badges and other values, long text below, editable on demand.",
      }),
      description: Schema.optionalKey(
        LayoutFieldId.annotate({
          description:
            "A text field shown as Markdown after the highlight and before other values.",
        }),
      ),
      hiddenFields: Schema.optionalKey(
        Schema.UniqueArray(LayoutFieldId).annotate({
          description: "Fields omitted from the showcase. They stay available in the form.",
        }),
      ),
    }).annotate({ description: "A record on a page of its own; its form without it." }),
  ),
  defaultView: Schema.optionalKey(
    Schema.Literals(["table", "cards"]).annotate({
      description: "How the collection's page first lists its records; a table without it.",
    }),
  ),
  search: Schema.optionalKey(
    Schema.Struct({
      fields: Schema.optionalKey(
        Schema.Array(LayoutFieldId).annotate({
          description:
            "The fields a search looks for its words in; every text value of a record without it.",
        }),
      ),
      filters: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            field: LayoutFieldId,
            iconLink: Schema.optionalKey(
              LayoutFieldId.annotate({
                description:
                  "A URL field: each value of the filter shows the icon of the site its records link to there.",
              }),
            ),
          }),
        ).annotate({
          description:
            "The filters shown above the records, in order: a select, yes/no or text field picks one of its values, a number or date field a range.",
        }),
      ),
    }).annotate({ description: "How people find the collection's records." }),
  ),
});
export type CollectionLayout = typeof CollectionLayout.Type;

export const CollectionExtension = Schema.Struct({
  parentCollectionId: StringId,
  categoryFieldId: FieldPathSegment,
  categoryValue: TrimmedNonEmptyString,
});
export type CollectionExtension = typeof CollectionExtension.Type;

/** Bounds a number or date field's value lies within, both included; either can be left open. */
const RecordFilterRange = Schema.Struct({
  min: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
  max: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
});

/** What top-level fields' values must be, all of them: exactly a value, or within a range. */
export const RecordFilters = Schema.Record(
  FieldPathSegment,
  Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, RecordFilterRange]),
);

/** Why `filters` don't fit `fields`, or null when every one does. */
export const filtersProblem = (
  fields: ReadonlyArray<Field>,
  filters: typeof RecordFilters.Type,
) => {
  for (const [fieldId, filter] of Object.entries(filters)) {
    const field = fields.find(({ id }) => id === fieldId);
    if (field === undefined || ["group", "file", "records"].includes(field.type))
      return `${fieldId} isn't one.`;
    if (typeof filter !== "object") {
      // A multiple-choice select matches records whose list holds the option.
      const problem = fieldValueProblem(
        field.type === "select" ? { ...field, isMultiple: false } : field,
        fieldId,
        filter,
      );
      if (problem !== null) return problem;
      continue;
    }
    if (field.type !== "number" && field.type !== "date")
      return `${fieldId} takes a value, not a range: only number and date fields take ranges.`;
    for (const bound of [filter.min, filter.max]) {
      if (bound === undefined) continue;
      const problem = fieldValueProblem(field, fieldId, bound);
      if (problem !== null) return problem;
    }
  }
  return null;
};

export class Collection extends Schema.Opaque<Collection>()(
  Schema.Struct({
    id: StringId,
    title: Title,
    fields: Fields,
    primaryKeyFieldId: FieldPathSegment,
    /** Table order; fields without an entry follow in their definition order. */
    columnOrder: Schema.optionalKey(CollectionColumnOrder),
    /**
     * How its records show; with table columns, they replace `columnOrder` and the fields'
     * `isDetailOnly`. It changes freely, records or not.
     */
    layout: Schema.optionalKey(
      CollectionLayout.annotate({ description: "How the collection's records are shown." }),
    ),
    /** Its records are technical details of the product keyed by their primary link. */
    extension: Schema.optionalKey(CollectionExtension),
    /** The members, besides admins, who see and edit its records. */
    memberUserIds: Schema.UniqueArray(StringId),
    /** Whether every active member can see the collection in the main menu and read its records. */
    isPublished: Schema.Boolean,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }).check(
    Schema.makeFilter((collection) => primaryKeyRefusal(collection) === null, {
      expected: "a primary key that is one of the collection's own text or link fields",
    }),
  ),
) {}

/** The link that makes each detail record share the key of its parent record. */
export const linksParentByKey = (
  collection: Pick<Collection, "fields" | "primaryKeyFieldId">,
  parentCollectionId: string,
) =>
  collection.fields.some(
    (field) =>
      field.id === collection.primaryKeyFieldId &&
      field.type === "foreignKey" &&
      field.collectionId === parentCollectionId,
  );

/** An extension applies to a category defined by a select on the parent. */
export const hasExtensionCategory = (
  parent: Pick<Collection, "fields">,
  { categoryFieldId, categoryValue }: CollectionExtension,
) =>
  parent.fields.some(
    (field) =>
      field.id === categoryFieldId &&
      field.type === "select" &&
      field.options.includes(categoryValue),
  );

export const matchesExtensionCategory = (
  values: FieldValues,
  { categoryFieldId, categoryValue }: CollectionExtension,
) => {
  const value = values[categoryFieldId];
  return Array.isArray(value) ? value.includes(categoryValue) : value === categoryValue;
};

/** One record of a collection, unique by its key, with its values by dotted field key. */
export class CollectionRecord extends Schema.Opaque<CollectionRecord>()(
  Schema.Struct({
    collectionId: StringId,
    key: TrimmedNonEmptyString,
    values: FieldValues,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
) {}

/** Admins and the members a collection lists see and edit its records. */
export const canEditRecords = (
  user: { readonly id: string; readonly role: Role; readonly state: State },
  collection: Pick<Collection, "memberUserIds">,
) =>
  user.state === "active" && (user.role === "admin" || collection.memberUserIds.includes(user.id));

export const canReadRecords = (
  user: Parameters<typeof canEditRecords>[0],
  collection: Pick<Collection, "memberUserIds" | "isPublished">,
) => user.state === "active" && (collection.isPublished || canEditRecords(user, collection));

/** A record's key: its primary key's value, trimmed; null when it has none. */
export const recordKeyOf = (
  collection: Pick<Collection, "primaryKeyFieldId">,
  values: FieldValues,
) => {
  const key = values[collection.primaryKeyFieldId];
  return typeof key === "string" && key.trim() !== "" ? key.trim() : null;
};

/** Why these values can't be a record of the collection, or null when they can. */
export const recordProblem = (
  collection: Pick<Collection, "fields" | "primaryKeyFieldId">,
  values: FieldValues,
) =>
  valuesProblem(collection.fields, values) ??
  (recordKeyOf(collection, values) === null
    ? `Give ${collection.primaryKeyFieldId}, the record's primary key.`
    : null);

/** Why saving `after` over `before` points a link to another record, or null: it is cleared first. */
export const relinkProblem = (
  fields: ReadonlyArray<Field>,
  before: FieldValues,
  after: FieldValues,
) => {
  const relinked = foreignKeys(fields, before).find(
    ({ field, recordKey }) => after[field.id] !== undefined && after[field.id] !== recordKey,
  );
  return relinked === undefined
    ? null
    : `${relinked.field.id} links ${relinked.recordKey}: clear it and save before linking another record.`;
};

const isSameField = Schema.toEquivalence(Field);
const encodeField = Schema.encodeSync(Field);
const decodeField = Schema.decodeSync(Field);

/** The field as it holds values, leaving out its display settings. */
const asHeld = (field: Field): Field =>
  decodeField(
    JSON.parse(
      JSON.stringify(encodeField(field), (key, value: unknown) =>
        [
          "isDetailOnly",
          "isMarkdown",
          "displayLinkOn",
          "decimals",
          "unit",
          "tones",
          "layout",
        ].includes(key)
          ? undefined
          : value,
      ),
    ),
  );

/**
 * Once a collection has records, its fields only grow: every field it had stays as it was, save
 * its display settings and a top-level select's options, and its primary key stays the same.
 * Fields and options can go only while no record holds them: see `removedFields` and
 * `removedOptions`.
 */
export const fieldsChangeRefusal = (
  before: Pick<Collection, "fields" | "primaryKeyFieldId">,
  after: Pick<Collection, "fields" | "primaryKeyFieldId">,
) =>
  after.primaryKeyFieldId === before.primaryKeyFieldId &&
  before.fields.every((field) => {
    const kept = after.fields.find((candidate) => candidate.id === field.id);
    return kept === undefined
      ? field.id !== before.primaryKeyFieldId
      : isSameField(
          asHeld(field),
          asHeld(
            kept.type === "select" && field.type === "select"
              ? { ...kept, options: field.options }
              : kept,
          ),
        );
  })
    ? null
    : ("fields_locked" as const);

/** The top-level fields of `before` that `after` no longer has. */
export const removedFields = (before: ReadonlyArray<Field>, after: ReadonlyArray<Field>) =>
  before.filter((field) => !after.some(({ id }) => id === field.id));

/** The options each top-level select of `before` no longer offers in `after`. */
export const removedOptions = (before: ReadonlyArray<Field>, after: ReadonlyArray<Field>) =>
  before.flatMap((field) => {
    const kept = after.find(({ id }) => id === field.id);
    return field.type === "select" && kept?.type === "select"
      ? field.options
          .filter((option) => !kept.options.includes(option))
          .map((option) => ({ field, option }))
      : [];
  });

const REFUSALS = {
  invalid_primary_key:
    "Choose one of the collection's own top-level text or link fields as its primary key.",
  invalid_record: "Those values don't fit the collection's fields.",
  fields_locked:
    "This collection has records: you can only add new fields, and remove fields or change options no record holds.",
  invalid_attachment: "That file can't be attached here.",
  invalid_extension: "A subcollection needs a primary link to its parent and a valid category.",
  linked: "Other records or tickets link this record: remove those links first.",
  invalid_link:
    "A link names one existing record of its collection, and changes to another only once cleared.",
  invalid_filter:
    "Filter on one of the collection's top-level text, URL, number, yes/no, date or select fields, with a range only on numbers and dates.",
};

export class Refused extends Schema.TaggedError<Refused>()("CollectionRefused", {
  reason: Schema.Literals(Struct.keys(REFUSALS)),
  /** What exactly didn't fit, for a person or an agent to correct it. */
  detail: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    return this.detail === undefined
      ? REFUSALS[this.reason]
      : `${REFUSALS[this.reason]} ${this.detail}`;
  }
}
