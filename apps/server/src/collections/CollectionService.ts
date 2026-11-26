import { AccessDenied, type CurrentActor } from "@t45/contracts/auth/Authorization";
import type { Attachment } from "@t45/contracts/models/Attachment";
import {
  canEditRecords,
  canReadRecords,
  type Collection,
  type CollectionExtension,
  type CollectionRecord,
  fieldsChangeRefusal,
  filtersProblem,
  hasExtensionCategory,
  linksParentByKey,
  matchesExtensionCategory,
  primaryKeyRefusal,
  recordKeyOf,
  recordProblem,
  Refused,
  relinkProblem,
  removedFields,
  removedOptions,
} from "@t45/contracts/models/Collection";
import { fileKeys, type FieldValues, foreignKeys, holdsData } from "@t45/contracts/models/Field";
import { resolveRecordSearch } from "@t45/contracts/models/Layout";
import { AttachmentId } from "@t45/contracts/models/Attachment";
import {
  COLLECTIONS_CAPABILITY_ID,
  EXTRACTION_SAVING_CAPABILITY_ID,
} from "@t45/contracts/resources/AgentTools";
import type { Collections } from "@t45/contracts/resources/Collections";
import { NotFound } from "@t45/contracts/resources/errors";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import { AgentRepository } from "../agents/AgentRepository.ts";
import { AttachmentRepository } from "../attachments/AttachmentRepository.ts";
import { UserRepository } from "../org/UserRepository.ts";
import { TicketRepository } from "../workflows/TicketRepository.ts";
import { CollectionRecordRepository } from "./CollectionRecordRepository.ts";
import { CollectionRepository } from "./CollectionRepository.ts";

type Caller = CurrentActor["Service"];
type Agent = Extract<Caller, { agentId: string }>;
type Payload<Tag extends string> = Rpc.Payload<
  Rpc.ExtractTag<RpcGroup.Rpcs<typeof Collections>, `collections.${Tag}`>
>;

const SEARCH_LIMIT = 25;
const isAttachmentId = Schema.is(AttachmentId);

const withCategoryFilter = (collection: Collection, { categoryFieldId }: CollectionExtension) => {
  const search = collection.layout?.search;
  const filters = search?.filters ?? [];
  return filters.some(({ field }) => field === categoryFieldId)
    ? collection
    : {
        ...collection,
        layout: {
          ...collection.layout,
          search: { ...search, filters: [...filters, { field: categoryFieldId }] },
        },
      };
};

/** The top-level fields holding lists: multiple-choice selects. */
const listFieldIdsOf = (collection: Collection) =>
  collection.fields.flatMap((field) =>
    field.type === "select" && field.isMultiple === true ? [field.id] : [],
  );
const requireFieldValueQuery = Effect.fnUntraced(function* (
  collection: Collection,
  { fieldId, linkFieldId }: Omit<Payload<"listFieldValues">, "collectionId">,
) {
  if (!collection.fields.some((field) => field.id === fieldId))
    return yield* new Refused({ reason: "invalid_filter", detail: `${fieldId} isn't one.` });
  if (
    linkFieldId !== undefined &&
    !collection.fields.some((field) => field.id === linkFieldId && field.type === "url")
  )
    return yield* new Refused({
      reason: "invalid_filter",
      detail: `${linkFieldId} isn't a URL field.`,
    });
});

const make = Effect.gen(function* () {
  const collections = yield* CollectionRepository;
  const records = yield* CollectionRecordRepository;
  const files = yield* AttachmentRepository;
  const users = yield* UserRepository;
  const agents = yield* AgentRepository;
  const tickets = yield* TicketRepository;
  const crypto = yield* Crypto.Crypto;

  const requireCapability = Effect.fnUntraced(function* (agent: Agent) {
    const capabilities = (yield* agents.get(agent.agentId))?.capabilities ?? [];
    if (
      capabilities.includes(COLLECTIONS_CAPABILITY_ID) ||
      capabilities.includes(EXTRACTION_SAVING_CAPABILITY_ID)
    )
      return;
    return yield* new AccessDenied({ message: "This agent can't use collections." });
  });

  /**
   * Whether the caller reads the collection's records: a member by their access, an agent in a
   * chat by the access of the person chatting, and an automation by its capability.
   */
  const accessCollection = (collection: Collection) =>
    collection.extension === undefined
      ? Effect.succeed(collection)
      : collections.get(collection.extension.parentCollectionId);

  const canRead = Effect.fnUntraced(function* (caller: Caller, target: Collection) {
    const collection = yield* accessCollection(target);
    if (collection === null) return false;
    if ("userId" in caller) return canReadRecords({ ...caller, id: caller.userId }, collection);
    if (caller.origin.kind === "automation") return true;
    const owner = yield* users.get(caller.origin.ownerUserId);
    return owner !== null && canReadRecords(owner, collection);
  });

  /** Whether the caller creates collections: an admin, or an agent in an admin's chat. */
  const canCreate = Effect.fnUntraced(function* (caller: Caller) {
    if ("userId" in caller) return caller.role === "admin";
    yield* requireCapability(caller);
    if (caller.origin.kind === "automation") return false;
    return (yield* users.get(caller.origin.ownerUserId))?.role === "admin";
  });

  /** The collections whose definitions the caller sees: an agent with the capability, all. */
  const visible = Effect.fnUntraced(function* (caller: Caller) {
    const all = yield* collections.list;
    if (!("userId" in caller)) {
      yield* requireCapability(caller);
      return all;
    }
    const byId = new Map(all.map((collection) => [collection.id, collection]));
    return all.filter((collection) => {
      const owner =
        collection.extension === undefined
          ? collection
          : byId.get(collection.extension.parentCollectionId);
      return owner !== undefined && canReadRecords({ ...caller, id: caller.userId }, owner);
    });
  });

  const find = Effect.fnUntraced(function* (caller: Caller, collectionId: string) {
    if (!("userId" in caller)) yield* requireCapability(caller);
    const collection = yield* collections.get(collectionId);
    if (collection === null || ("userId" in caller && !(yield* canRead(caller, collection))))
      return yield* new NotFound();
    return collection;
  });

  const findReadable = Effect.fnUntraced(function* (caller: Caller, collectionId: string) {
    const collection = yield* find(caller, collectionId);
    if ("userId" in caller || (yield* canRead(caller, collection))) return collection;
    return yield* new AccessDenied({
      message: "Reading this collection's records needs the access of the person you chat with.",
    });
  });

  const requireWritable = Effect.fnUntraced(function* (caller: Caller, collectionId: string) {
    const collection = yield* find(caller, collectionId);
    if ("userId" in caller) {
      const owner = yield* accessCollection(collection);
      if (owner === null || !canEditRecords({ ...caller, id: caller.userId }, owner))
        return yield* new AccessDenied({ message: "You can only read this collection's records." });
    }
    return collection;
  });

  const viewOf = (record: CollectionRecord) =>
    files
      .forIds(Object.values(record.values).filter(isAttachmentId))
      .pipe(
        Effect.map((held) => ({ ...record, files: held.map(({ id, name }) => ({ id, name })) })),
      );

  const requireDraft = Effect.fnUntraced(function* (
    draft: Pick<Collection, "fields" | "primaryKeyFieldId">,
  ) {
    const reason = primaryKeyRefusal(draft);
    if (reason !== null) return yield* new Refused({ reason });
    for (const field of draft.fields)
      if (field.type === "foreignKey" && (yield* collections.get(field.collectionId)) === null)
        return yield* new Refused({
          reason: "invalid_link",
          detail: `${field.id} links collection ${field.collectionId}, which doesn't exist.`,
        });
  });

  /** Hands the record's new files to the collection and lets go of those it no longer holds. */
  const settleFiles = Effect.fnUntraced(function* (
    collection: Collection,
    actorId: string,
    before: FieldValues,
    after: FieldValues,
  ) {
    for (const key of fileKeys(collection.fields, after)) {
      const id = after[key];
      if (before[key] === id || !isAttachmentId(id)) continue;
      const claimed = yield* files.claimForCollection({
        id,
        actor: actorId,
        collectionId: collection.id,
        fieldKey: key,
      });
      if (claimed === null || claimed.sizeBytes === 0)
        return yield* new Refused({
          reason: "invalid_attachment",
          detail: `${key} needs a file you uploaded and haven't used elsewhere.`,
        });
    }
    const kept = new Set(Object.values(after));
    for (const key of fileKeys(collection.fields, before)) {
      const id = before[key];
      if (isAttachmentId(id) && !kept.has(id)) yield* files.detach(id);
    }
  });

  return {
    list: visible,
    get: find,

    reorderColumns: ({ collectionId, columnOrder }: Payload<"reorderColumns">) =>
      records.transaction(
        Effect.gen(function* () {
          const before = yield* collections.get(collectionId);
          if (before === null) return yield* new NotFound();
          const collection = { ...before, columnOrder, updatedAt: yield* DateTime.now };
          yield* collections.save(collection);
          return collection;
        }),
      ),

    create: Effect.fnUntraced(function* (caller: Caller, input: Payload<"create">) {
      if (!(yield* canCreate(caller)))
        return yield* new AccessDenied({
          message: "Creating a collection needs an admin, or an agent chatting with one.",
        });
      yield* requireDraft(input);
      const now = yield* DateTime.now;
      const collection = {
        id: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
        ...input,
        isPublished: input.isPublished ?? false,
        createdAt: now,
        updatedAt: now,
      };
      yield* collections.save(collection);
      return collection;
    }),

    setExtension: ({ collectionId, extension }: Payload<"setExtension">) =>
      records.transaction(
        Effect.gen(function* () {
          const child = yield* collections.get(collectionId);
          const parent = yield* collections.get(extension.parentCollectionId);
          if (child === null || parent === null) return yield* new NotFound();
          if (
            child.id === parent.id ||
            parent.extension !== undefined ||
            (yield* collections.listExtensions(child.id)).length > 0 ||
            !linksParentByKey(child, parent.id) ||
            !hasExtensionCategory(parent, extension)
          )
            return yield* new Refused({ reason: "invalid_extension" });

          const updatedAt = yield* DateTime.now;
          const next = { ...child, extension, updatedAt };
          yield* collections.save(next);
          const withFilter = withCategoryFilter(parent, extension);
          if (withFilter !== parent) yield* collections.save({ ...withFilter, updatedAt });
          return next;
        }),
      ),

    update: ({ collectionId, ...draft }: Payload<"update">) =>
      records.transaction(
        Effect.gen(function* () {
          const before = yield* collections.get(collectionId);
          if (before === null) return yield* new NotFound();
          yield* requireDraft(draft);
          if (
            before.extension !== undefined &&
            !linksParentByKey(draft, before.extension.parentCollectionId)
          )
            return yield* new Refused({ reason: "invalid_extension" });
          const extensions = yield* collections.listExtensions(collectionId);
          for (const { extension } of extensions)
            if (extension !== undefined && !hasExtensionCategory(draft, extension))
              return yield* new Refused({
                reason: "invalid_extension",
                detail: "A subcollection uses that category.",
              });
          if (yield* records.hasAny(collectionId)) {
            const reason = fieldsChangeRefusal(before, draft);
            if (reason !== null) return yield* new Refused({ reason });
            for (const field of removedFields(before.fields, draft.fields))
              if (yield* records.holdsField(collectionId, field.id))
                return yield* new Refused({
                  reason: "fields_locked",
                  detail: `Records hold ${field.label}.`,
                });
            for (const { field, option } of removedOptions(before.fields, draft.fields)) {
              const held = yield* records.listValues(collectionId, {
                fieldId: field.id,
                isList: field.isMultiple === true,
              });
              if (held.some(({ value }) => value === option))
                return yield* new Refused({
                  reason: "fields_locked",
                  detail: `Records hold ${option} in ${field.label}.`,
                });
            }
          }
          const collection = extensions.reduce<Collection>(
            (parent, { extension }) =>
              extension === undefined ? parent : withCategoryFilter(parent, extension),
            { ...before, ...draft, updatedAt: yield* DateTime.now },
          );
          yield* collections.save(collection);
          return collection;
        }),
      ),

    getRecord: Effect.fnUntraced(function* (caller: Caller, input: Payload<"getRecord">) {
      yield* findReadable(caller, input.collectionId);
      const record = yield* records.get(input.collectionId, input.key);
      return record === null ? null : yield* viewOf(record);
    }),

    getRecordExtensions: Effect.fnUntraced(function* (
      caller: Caller,
      input: Payload<"getRecordExtensions">,
    ) {
      yield* findReadable(caller, input.collectionId);
      const parent = yield* records.get(input.collectionId, input.key);
      if (parent === null) return [];
      const children = (yield* collections.listExtensions(input.collectionId)).filter(
        ({ extension }) =>
          extension !== undefined && matchesExtensionCategory(parent.values, extension),
      );
      return yield* Effect.forEach(children, (collection) =>
        Effect.gen(function* () {
          const record = yield* records.get(collection.id, input.key);
          return { collection, record: record === null ? null : yield* viewOf(record) };
        }),
      );
    }),

    searchRecords: Effect.fnUntraced(function* (caller: Caller, input: Payload<"searchRecords">) {
      const collection = yield* findReadable(caller, input.collectionId);
      const filters = input.filters ?? {};
      const problem = filtersProblem(collection.fields, filters);
      if (problem !== null)
        return yield* new Refused({ reason: "invalid_filter", detail: problem });
      for (const field of input.filterChoices ?? [])
        yield* requireFieldValueQuery(collection, field);
      const limit = input.limit ?? SEARCH_LIMIT;
      // Fields named in the request replace the layout's, as the layout editor previews them.
      const searched = resolveRecordSearch(
        input.fields === undefined
          ? collection
          : { fields: collection.fields, layout: { search: { fields: input.fields } } },
      ).fields;
      const search = {
        collectionId: collection.id,
        words: (input.text ?? "").split(/\s+/u).filter((word) => word !== ""),
        fields: searched?.map((field) => field.id) ?? null,
        filters,
        listFieldIds: listFieldIdsOf(collection),
      };
      const {
        records: found,
        matchCount,
        totalCount,
        filterChoices,
      } = yield* records.searchPage(
        { ...search, offset: input.offset ?? 0, limit: limit + 1 },
        input.filterChoices ?? [],
      );
      return {
        records: yield* Effect.forEach(found.slice(0, limit), viewOf),
        hasMore: found.length > limit,
        matchCount,
        totalCount,
        ...(input.filterChoices === undefined ? {} : { filterChoices }),
      };
    }),

    listFieldValues: Effect.fnUntraced(function* (
      caller: Caller,
      input: Payload<"listFieldValues">,
    ) {
      const collection = yield* findReadable(caller, input.collectionId);
      yield* requireFieldValueQuery(collection, input);
      return yield* records.listValues(collection.id, {
        ...input,
        isList: listFieldIdsOf(collection).includes(input.fieldId),
      });
    }),

    /** Adds the record or replaces the one with its key; agents with the capability always may. */
    saveRecord: Effect.fnUntraced(function* (caller: Caller, input: Payload<"saveRecord">) {
      const collection = yield* requireWritable(caller, input.collectionId);
      const values = Object.fromEntries(
        Object.entries(input.values).flatMap(([key, value]) =>
          holdsData(value)
            ? [
                [
                  key,
                  typeof value === "string" && key === collection.primaryKeyFieldId
                    ? value.trim()
                    : value,
                ],
              ]
            : [],
        ),
      );
      const problem = recordProblem(collection, values);
      if (problem !== null)
        return yield* new Refused({ reason: "invalid_record", detail: problem });
      for (const { field, recordKey } of foreignKeys(collection.fields, values)) {
        yield* findReadable(caller, field.collectionId);
        if ((yield* records.get(field.collectionId, recordKey)) === null)
          return yield* new Refused({
            reason: "invalid_link",
            detail: `${field.id}: collection ${field.collectionId} holds no record ${recordKey}.`,
          });
      }
      const key = recordKeyOf(collection, values)!;
      const saved = yield* records.transaction(
        Effect.gen(function* () {
          const before = yield* records.get(collection.id, key);
          const relinked = relinkProblem(collection.fields, before?.values ?? {}, values);
          if (relinked !== null)
            return yield* new Refused({ reason: "invalid_link", detail: relinked });
          yield* settleFiles(
            collection,
            "userId" in caller ? caller.userId : caller.agentId,
            before?.values ?? {},
            values,
          );
          const now = yield* DateTime.now;
          const savedRecord = yield* records.save({
            collectionId: collection.id,
            key,
            values,
            createdAt: now,
            updatedAt: now,
          });
          return savedRecord;
        }),
      );
      return yield* viewOf(saved);
    }),

    /**
     * Removes the record and lets go of its files, as saving it does; refused while a record of a
     * collection or a ticket's step links it, so no link is left without its record.
     */
    deleteRecord: Effect.fnUntraced(function* (caller: Caller, input: Payload<"deleteRecord">) {
      const collection = yield* requireWritable(caller, input.collectionId);
      yield* records.transaction(
        Effect.gen(function* () {
          const record = yield* records.get(collection.id, input.key);
          if (record === null) return yield* new NotFound();
          for (const linking of yield* collections.list)
            for (const field of linking.fields) {
              if (field.type !== "foreignKey" || field.collectionId !== collection.id) continue;
              const { matchCount } = yield* records.searchPage(
                {
                  collectionId: linking.id,
                  words: [],
                  fields: null,
                  filters: { [field.id]: input.key },
                  listFieldIds: [],
                  offset: 0,
                  limit: 1,
                },
                [],
              );
              if (matchCount > 0)
                return yield* new Refused({
                  reason: "linked",
                  detail: `${matchCount} in ${linking.title} through ${field.label}.`,
                });
            }
          const linkingTickets = yield* tickets.countLinking(collection.id, input.key);
          if (linkingTickets > 0)
            return yield* new Refused({
              reason: "linked",
              detail: `${linkingTickets} ticket${linkingTickets === 1 ? "" : "s"} in a step.`,
            });
          yield* settleFiles(
            collection,
            "userId" in caller ? caller.userId : caller.agentId,
            record.values,
            {},
          );
          yield* records.remove(collection.id, input.key);
        }),
      );
    }),

    /**
     * The collection, when the member by id or the agent reads its records, as linking them to a
     * step needs.
     */
    requireReadable: Effect.fnUntraced(function* (actor: string | Agent, collectionId: string) {
      if (typeof actor !== "string") return yield* findReadable(actor, collectionId);
      const user = yield* users.get(actor);
      const collection = yield* collections.get(collectionId);
      if (user !== null && collection !== null) {
        const owner = yield* accessCollection(collection);
        if (owner !== null && canReadRecords(user, owner)) return collection;
      }
      return yield* new NotFound();
    }),

    /** Whether the member opens a file a collection's record holds. */
    canReadFile: Effect.fnUntraced(function* (userId: string, file: Attachment) {
      const collection =
        file.collectionId === null ? null : yield* collections.get(file.collectionId);
      const user = yield* users.get(userId);
      if (collection === null || user === null) return false;
      const owner = yield* accessCollection(collection);
      return owner !== null && canReadRecords(user, owner);
    }),
  };
});

export class CollectionService extends Context.Service<
  CollectionService,
  Effect.Success<typeof make>
>()("t45/collections/CollectionService") {}

export const layer = Layer.effect(CollectionService, make);
