import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { AdminOnly } from "../Authorization.ts";
import { Attachment } from "../models/Attachment.ts";
import {
  Collection,
  CollectionColumnOrder,
  CollectionRecord,
  Refused,
} from "../models/Collection.ts";
import { FieldPathSegment, FieldValues } from "../models/Field.ts";
import { NonNegativeInt, StringId, TrimmedNonEmptyString } from "../models/primitives.ts";
import { AccessDenied, NotFound } from "./errors.ts";

const CollectionErrors = Schema.Union([Refused, NotFound, AccessDenied]);

/** A record with the files its file fields hold. */
export const CollectionRecordView = Schema.Struct({
  ...CollectionRecord.fields,
  files: Schema.Array(Schema.Struct(Struct.pick(Attachment.fields, ["id", "name"]))),
});
export type CollectionRecordView = typeof CollectionRecordView.Type;

/** What an admin sets of a collection. */
const CollectionDraft = Schema.Struct(
  Struct.pick(Collection.fields, ["title", "fields", "primaryKeyFieldId", "memberUserIds"]),
);

/** What members and agents do with collections' records; agents' collection tools call these. */
export const CollectionRecordOperations = RpcGroup.make(
  Rpc.make("list", {
    success: Schema.Array(Collection),
    error: AccessDenied,
  }),
  Rpc.make("get", {
    payload: { collectionId: StringId },
    success: Collection,
    error: CollectionErrors,
  }),
  Rpc.make("getRecord", {
    payload: {
      collectionId: StringId,
      key: TrimmedNonEmptyString.annotate({ description: "The record's primary key value." }),
    },
    /** Null when the collection holds no record with that key. */
    success: Schema.NullOr(CollectionRecordView),
    error: CollectionErrors,
  }),
  Rpc.make("searchRecords", {
    payload: {
      collectionId: StringId,
      /** Words any of a record's text values contain, ignoring case. */
      text: Schema.optionalKey(Schema.String),
      /** Values that top-level fields hold exactly, all of them. */
      filters: Schema.optionalKey(
        Schema.Record(
          FieldPathSegment,
          Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
        ),
      ),
      offset: Schema.optionalKey(NonNegativeInt),
      limit: Schema.optionalKey(
        NonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
      ),
    },
    success: Schema.Struct({
      records: Schema.Array(CollectionRecordView),
      /** Whether more records match after these. */
      hasMore: Schema.Boolean,
    }),
    error: CollectionErrors,
  }),
  Rpc.make("saveRecord", {
    payload: {
      collectionId: StringId,
      /**
       * The record's values by field key, its primary key included. They replace the record with
       * that key whole, or add it when there is none.
       */
      values: FieldValues,
    },
    success: CollectionRecordView,
    error: CollectionErrors,
  }),
).prefix("collections.");

export const Collections = RpcGroup.make(
  Rpc.make("create", {
    payload: CollectionDraft,
    success: Collection,
    error: CollectionErrors,
  }),
  Rpc.make("update", {
    payload: { collectionId: StringId, ...CollectionDraft.fields },
    success: Collection,
    error: CollectionErrors,
  }),
  Rpc.make("reorderColumns", {
    payload: { collectionId: StringId, columnOrder: CollectionColumnOrder },
    success: Collection,
    error: CollectionErrors,
  }),
)
  .prefix("collections.")
  // Middleware applies only to existing RPCs: admins define collections; records are shared.
  .middleware(AdminOnly)
  .merge(CollectionRecordOperations);
