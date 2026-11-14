import type { CurrentActor } from "@t45/contracts/Authorization";
import type { Attachment } from "@t45/contracts/models/Attachment";
import {
  canEditRecords,
  type Collection,
  type CollectionRecord,
  fieldsChangeRefusal,
  primaryKeyRefusal,
  recordKeyOf,
  recordProblem,
  Refused,
} from "@t45/contracts/models/Collection";
import {
  fieldValueProblem,
  fileKeys,
  type FieldValues,
  holdsData,
} from "@t45/contracts/models/Field";
import { AttachmentId } from "@t45/contracts/models/Attachment";
import { COLLECTIONS_CAPABILITY_ID } from "@t45/contracts/resources/AgentTools";
import type { Collections } from "@t45/contracts/resources/Collections";
import { AccessDenied, NotFound } from "@t45/contracts/resources/errors";
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
import { CollectionRecordRepository } from "./CollectionRecordRepository.ts";
import { CollectionRepository } from "./CollectionRepository.ts";

type Caller = CurrentActor["Service"];
type Agent = Extract<Caller, { agentId: string }>;
type Payload<Tag extends string> = Rpc.Payload<
  Rpc.ExtractTag<RpcGroup.Rpcs<typeof Collections>, `collections.${Tag}`>
>;

const SEARCH_LIMIT = 25;
const isAttachmentId = Schema.is(AttachmentId);

const make = Effect.gen(function* () {
  const collections = yield* CollectionRepository;
  const records = yield* CollectionRecordRepository;
  const files = yield* AttachmentRepository;
  const users = yield* UserRepository;
  const agents = yield* AgentRepository;
  const crypto = yield* Crypto.Crypto;

  const requireCapability = Effect.fnUntraced(function* (agent: Agent) {
    if ((yield* agents.get(agent.agentId))?.capabilities.includes(COLLECTIONS_CAPABILITY_ID))
      return;
    return yield* new AccessDenied({ message: "This agent can't use collections." });
  });

  /**
   * Whether the caller reads the collection's records: a member by their access, an agent in a
   * chat by the access of the person chatting, and an automation by its capability.
   */
  const canRead = Effect.fnUntraced(function* (caller: Caller, collection: Collection) {
    if ("userId" in caller) return canEditRecords({ ...caller, id: caller.userId }, collection);
    if (caller.origin.kind === "automation") return true;
    const owner = yield* users.get(caller.origin.ownerUserId);
    return owner !== null && canEditRecords(owner, collection);
  });

  /** The collections whose definitions the caller sees: an agent with the capability, all. */
  const visible = Effect.fnUntraced(function* (caller: Caller) {
    const all = yield* collections.list;
    if (!("userId" in caller)) {
      yield* requireCapability(caller);
      return all;
    }
    return all.filter((collection) => canEditRecords({ ...caller, id: caller.userId }, collection));
  });

  const find = Effect.fnUntraced(function* (caller: Caller, collectionId: string) {
    const collection = (yield* visible(caller)).find(({ id }) => id === collectionId);
    return collection ?? (yield* new NotFound());
  });

  const findReadable = Effect.fnUntraced(function* (caller: Caller, collectionId: string) {
    const collection = yield* find(caller, collectionId);
    if (yield* canRead(caller, collection)) return collection;
    return yield* new AccessDenied({
      message: "Reading this collection's records needs the access of the person you chat with.",
    });
  });

  const viewOf = (record: CollectionRecord) =>
    files
      .forIds(Object.values(record.values).filter(isAttachmentId))
      .pipe(
        Effect.map((held) => ({ ...record, files: held.map(({ id, name }) => ({ id, name })) })),
      );

  const requireDraft = (draft: Pick<Collection, "fields" | "primaryKeyFieldId">) => {
    const reason = primaryKeyRefusal(draft);
    return reason === null ? Effect.void : Effect.fail(new Refused({ reason }));
  };

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

    create: Effect.fnUntraced(function* (input: Payload<"create">) {
      yield* requireDraft(input);
      const now = yield* DateTime.now;
      const collection = {
        id: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
        ...input,
        createdAt: now,
        updatedAt: now,
      };
      yield* collections.save(collection);
      return collection;
    }),

    update: Effect.fnUntraced(function* ({ collectionId, ...draft }: Payload<"update">) {
      const before = yield* collections.get(collectionId);
      if (before === null) return yield* new NotFound();
      yield* requireDraft(draft);
      const reason = (yield* records.hasAny(collectionId))
        ? fieldsChangeRefusal(before, draft)
        : null;
      if (reason !== null) return yield* new Refused({ reason });
      const collection = { ...before, ...draft, updatedAt: yield* DateTime.now };
      yield* collections.save(collection);
      return collection;
    }),

    getRecord: Effect.fnUntraced(function* (caller: Caller, input: Payload<"getRecord">) {
      yield* findReadable(caller, input.collectionId);
      const record = yield* records.get(input.collectionId, input.key);
      return record === null ? null : yield* viewOf(record);
    }),

    searchRecords: Effect.fnUntraced(function* (caller: Caller, input: Payload<"searchRecords">) {
      const collection = yield* findReadable(caller, input.collectionId);
      const filters = input.filters ?? {};
      for (const [fieldId, value] of Object.entries(filters)) {
        const field = collection.fields.find(({ id }) => id === fieldId);
        const problem =
          field === undefined || field.type === "group" || field.type === "file"
            ? `${fieldId} isn't one.`
            : fieldValueProblem(field, fieldId, value);
        if (problem !== null)
          return yield* new Refused({ reason: "invalid_filter", detail: problem });
      }
      const limit = input.limit ?? SEARCH_LIMIT;
      const text = input.text?.trim() ?? "";
      const found = yield* records.search({
        collectionId: collection.id,
        text: text === "" ? null : text,
        filters,
        offset: input.offset ?? 0,
        limit: limit + 1,
      });
      return {
        records: yield* Effect.forEach(found.slice(0, limit), viewOf),
        hasMore: found.length > limit,
      };
    }),

    /** Adds the record or replaces the one with its key; agents with the capability always may. */
    saveRecord: Effect.fnUntraced(function* (caller: Caller, input: Payload<"saveRecord">) {
      const collection = yield* find(caller, input.collectionId);
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
      const key = recordKeyOf(collection, values)!;
      const saved = yield* records.transaction(
        Effect.gen(function* () {
          const before = yield* records.get(collection.id, key);
          yield* settleFiles(
            collection,
            "userId" in caller ? caller.userId : caller.agentId,
            before?.values ?? {},
            values,
          );
          const now = yield* DateTime.now;
          return yield* records.save({
            collectionId: collection.id,
            key,
            values,
            createdAt: now,
            updatedAt: now,
          });
        }),
      );
      return yield* viewOf(saved);
    }),

    /** Whether the member opens a file a collection's record holds. */
    canReadFile: Effect.fnUntraced(function* (userId: string, file: Attachment) {
      const collection =
        file.collectionId === null ? null : yield* collections.get(file.collectionId);
      const user = yield* users.get(userId);
      return collection !== null && user !== null && canEditRecords(user, collection);
    }),
  };
});

export class CollectionService extends Context.Service<
  CollectionService,
  Effect.Success<typeof make>
>()("t45/collections/CollectionService") {}

export const layer = Layer.effect(CollectionService, make);
