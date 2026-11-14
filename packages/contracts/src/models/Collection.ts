/**
 * A `Collection` is a durable, shared set of records that people and agents reuse across tasks,
 * such as Amazon listings by ASIN. An admin defines its fields; one top-level text field is its
 * primary key, whose value identifies a record within the collection.
 */
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { Field, FieldPathSegment, Fields, FieldValues, valuesProblem } from "./Field.ts";
import type { Role, State } from "./User.ts";
import { StringId, Title, TrimmedNonEmptyString } from "./primitives.ts";

/** A collection's primary key is one of its own top-level text fields. */
export const primaryKeyRefusal = (collection: {
  readonly fields: ReadonlyArray<Field>;
  readonly primaryKeyFieldId: string;
}) =>
  collection.fields.some(
    (field) => field.id === collection.primaryKeyFieldId && field.type === "text",
  )
    ? null
    : ("invalid_primary_key" as const);

export class Collection extends Schema.Opaque<Collection>()(
  Schema.Struct({
    id: StringId,
    title: Title,
    fields: Fields,
    primaryKeyFieldId: FieldPathSegment,
    /** The members, besides admins, who see and edit its records. */
    memberUserIds: Schema.UniqueArray(StringId),
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }).check(
    Schema.makeFilter((collection) => primaryKeyRefusal(collection) === null, {
      expected: "a primary key that is one of the collection's own text fields",
    }),
  ),
) {}

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

const isSameField = Schema.toEquivalence(Field);

/**
 * Once a collection has records, its fields only grow: every field it had stays as it was, and
 * its primary key stays the same.
 */
export const fieldsChangeRefusal = (
  before: Pick<Collection, "fields" | "primaryKeyFieldId">,
  after: Pick<Collection, "fields" | "primaryKeyFieldId">,
) =>
  after.primaryKeyFieldId === before.primaryKeyFieldId &&
  before.fields.every((field) => {
    const kept = after.fields.find((candidate) => candidate.id === field.id);
    return kept !== undefined && isSameField(field, kept);
  })
    ? null
    : ("fields_locked" as const);

const REFUSALS = {
  invalid_primary_key:
    "Choose one of the collection's own top-level text fields as its primary key.",
  invalid_record: "Those values don't fit the collection's fields.",
  fields_locked: "This collection has records: you can only add new fields.",
  invalid_attachment: "That file can't be attached here.",
  invalid_filter:
    "Filter on one of the collection's top-level text, number, yes/no, date or select fields.",
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
