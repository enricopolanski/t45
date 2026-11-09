import { MESSAGE_MAX_ATTACHMENTS } from "@t45/contracts/models/Attachment";
import type { ChatId } from "@t45/contracts/models/Chat";
import {
  formatComposerContextReference,
  replaceComposerContextReferences,
} from "@t45/core/composerContextReferences";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import {
  attachmentContextReference,
  contextIdFor,
  ensureInlineContextReferences,
  removeContextReferences,
} from "./lib/composerContextReferences";
import { attachmentUrl } from "./lib/attachmentUrl";
import { browserStorage, createDeferredStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";
import type { QuestionDraftKey } from "./questionDrafts";
import { type ChatFileAttachment, type ChatImageAttachment } from "./types";

const COMPOSER_DRAFT_STORAGE_KEY = "t45:composer-drafts:v1";
const COMPOSER_DRAFT_STORAGE_VERSION = 16;

const COMPOSER_PERSIST_DEBOUNCE_MS = 300;

type ComposerPersistState =
  | { capturedState: ComposerDraftStoreState }
  | PersistedComposerDraftStoreState;

const composerStorage = browserStorage();
const composerDebouncedStorage = createDeferredStorage<StorageValue<ComposerPersistState>>(
  composerStorage,
  (value) =>
    JSON.stringify({
      state:
        "capturedState" in value.state
          ? partializeComposerDraftStoreState(value.state.capturedState)
          : value.state,
      version: value.version,
    }),
  COMPOSER_PERSIST_DEBOUNCE_MS,
);

const composerPersistStorage: PersistStorage<ComposerPersistState> = {
  getItem: (name) => {
    const raw = composerDebouncedStorage.getItem(name);
    if (typeof raw !== "string") {
      return null;
    }
    return JSON.parse(raw) as StorageValue<ComposerPersistState>;
  },
  setItem: (name, value) => composerDebouncedStorage.setItem(name, value),
  removeItem: (name) => composerDebouncedStorage.removeItem(name),
};

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    composerDebouncedStorage.flush();
  });
}

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File | null;
  uploadedAttachmentId?: string;
}

export interface ComposerFileAttachment extends Omit<ChatFileAttachment, "previewUrl"> {
  file: File | null;
  uploadedAttachmentId?: string;
}

export type ComposerAttachment = ComposerImageAttachment | ComposerFileAttachment;

/**
 * A hydrated draft attachment whose upload never finished before the reload has
 * neither bytes (`file` is only ever null after hydration) nor a server-side
 * upload. The composer renders it as a needs-reattach row: the user must
 * attach the file again or remove it before sending.
 */
export function composerAttachmentNeedsReattach(file: ComposerAttachment): boolean {
  return file.file === null && file.uploadedAttachmentId === undefined;
}

/**
 * A draft attachment as it persists: its `File` handle cannot serialize, so one whose upload never
 * finished persists without an upload id and hydrates as a needs-reattach row instead of vanishing.
 */
const PersistedAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  uploadedAttachmentId: Schema.optionalKey(Schema.String),
});

const PersistedDraft = Schema.Struct({
  prompt: Schema.String,
  images: Schema.Array(PersistedAttachment),
  files: Schema.Array(PersistedAttachment),
  inputId: Schema.NullOr(Schema.String),
});
type PersistedDraft = typeof PersistedDraft.Type;

const PersistedComposerDraftStoreState = Schema.Struct({
  draftsByTarget: Schema.Record(Schema.String, PersistedDraft),
});
type PersistedComposerDraftStoreState = typeof PersistedComposerDraftStoreState.Type;

/** What the composer holds for a chat (`ChatId`) or a question field (`QuestionDraftKey`). */
export interface ComposerDraft {
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  /**
   * The id a send of this content went out under. Any edit drops it, so a send repeated after a
   * lost answer, or after a reload, reuses it only while the content is unchanged and T45 keeps
   * one input.
   */
  inputId: string | null;
}

const holdsAttachments = (draft: ComposerDraft) => draft.images.length + draft.files.length > 0;

const isEmptyDraft = (draft: ComposerDraft) =>
  draft.prompt.length === 0 && !holdsAttachments(draft);

/**
 * A composer's identity: a chat's own draft by its `ChatId`, a question field's by its
 * `QuestionDraftKey`. Neither can take the other's form, so one key space holds both.
 */
export type ComposerTarget = ChatId | QuestionDraftKey;

interface ComposerDraftStoreState {
  draftsByTarget: Record<string, ComposerDraft>;
  getComposerDraft: (target: ComposerTarget) => ComposerDraft | null;
  clearDraft: (target: ComposerTarget) => void;
  setPrompt: (target: ComposerTarget, prompt: string) => void;
  /** Returns the ids the draft accepted; duplicates and over-cap attachments are left out. */
  addImages: (target: ComposerTarget, images: ComposerImageAttachment[]) => string[];
  removeImage: (target: ComposerTarget, imageId: string) => void;
  /** Returns the ids of files appended; a re-pick that replaces a marker is not listed. */
  addFiles: (
    target: ComposerTarget,
    files: ComposerFileAttachment[],
    options?: { appendReference?: boolean },
  ) => string[];
  removeFile: (target: ComposerTarget, fileId: string) => void;
  setAttachmentUpload: (fileId: string, attachmentId: string) => void;
  markAttachmentUploadMissing: (fileId: string, attachmentId: string) => boolean;
  clearComposerContent: (target: ComposerTarget) => void;
  /** The id to send the draft's content under: the one a send of it already used, else a new one. */
  claimInputId: (target: ComposerTarget) => string;
  /** Drops `inputId` from the draft, unless an edit already did, so its next send gets a new one. */
  forgetInputId: (target: ComposerTarget, inputId: string) => void;
  /**
   * Clears the composer if it still holds what went out under `inputId`, and says whether it did:
   * what the member wrote meanwhile stays.
   */
  clearSentContent: (target: ComposerTarget, inputId: string) => boolean;
}

type DraftsState = Pick<ComposerDraftStoreState, "draftsByTarget">;

const EMPTY_PERSISTED_STATE: PersistedComposerDraftStoreState = Object.freeze({
  draftsByTarget: {},
});

/** The empty draft; every update copies it, so its arrays are never written to. */
const EMPTY_DRAFT: ComposerDraft = Object.freeze({
  prompt: "",
  images: [],
  files: [],
  inputId: null,
});

type AttachmentSignature = Pick<ComposerFileAttachment, "mimeType" | "sizeBytes" | "name">;

/** Metadata identifies re-picked files after a reload, when their original bytes are absent. */
function attachmentDedupKey(attachment: AttachmentSignature): string {
  return `${attachment.mimeType}\u0000${attachment.sizeBytes}\u0000${attachment.name}`;
}

export function composerAttachmentMatchesReattachMarker(
  marker: AttachmentSignature,
  file: AttachmentSignature,
): boolean {
  return attachmentDedupKey(marker) === attachmentDedupKey(file);
}

/** Restored images use server URLs, which have nothing to revoke. */
function revokeObjectPreviewUrl(previewUrl: string): void {
  if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
}

/** The state with the draft at `key` replaced by `update`'s, dropped once it holds nothing. */
function updatedDraft(
  state: DraftsState,
  key: string,
  update: (draft: ComposerDraft) => ComposerDraft,
): DraftsState {
  const current = state.draftsByTarget[key] ?? EMPTY_DRAFT;
  const next = update(current);
  if (next === current || (current === EMPTY_DRAFT && isEmptyDraft(next))) return state;
  const draftsByTarget = { ...state.draftsByTarget };
  if (isEmptyDraft(next)) delete draftsByTarget[key];
  else draftsByTarget[key] = next;
  return { draftsByTarget };
}

const decodePersistedDraft = Schema.decodeUnknownOption(PersistedDraft);

function persistedDraft(draft: ComposerDraft): PersistedDraft {
  return {
    prompt: draft.prompt,
    images: draft.images.map(
      ({ type: _type, file: _file, previewUrl: _preview, ...saved }) => saved,
    ),
    files: draft.files.map(({ type: _type, file: _file, ...persisted }) => persisted),
    inputId: draft.inputId,
  };
}

/** Select the persisted draft fields when the storage write is ready to flush. */
export function partializeComposerDraftStoreState(
  state: ComposerDraftStoreState,
): PersistedComposerDraftStoreState {
  return {
    draftsByTarget: Object.fromEntries(
      Object.entries(state.draftsByTarget).map(([key, draft]) => [key, persistedDraft(draft)]),
    ),
  };
}

function decodePersistedState(persisted: unknown): PersistedComposerDraftStoreState {
  if (!persisted || typeof persisted !== "object") return EMPTY_PERSISTED_STATE;
  const { draftsByTarget } = persisted as Partial<
    Record<keyof PersistedComposerDraftStoreState, unknown>
  >;
  if (!draftsByTarget || typeof draftsByTarget !== "object") return EMPTY_PERSISTED_STATE;
  return {
    draftsByTarget: Object.fromEntries(
      Object.entries(draftsByTarget as Record<string, unknown>).flatMap(([key, value]) =>
        Option.match(decodePersistedDraft(value), {
          onNone: () => [],
          onSome: (draft) => [[key, draft] as const],
        }),
      ),
    ),
  };
}

function hydrateDraft(draft: PersistedDraft): ComposerDraft {
  return {
    prompt: draft.prompt,
    images: draft.images.map((image) => ({
      ...image,
      type: "image",
      file: null,
      previewUrl: image.uploadedAttachmentId
        ? attachmentUrl({ id: image.uploadedAttachmentId, name: image.name })
        : "",
    })),
    files: draft.files.map((file) => ({ ...file, type: "file", file: null })),
    inputId: draft.inputId,
  };
}

const composerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    (set, get) => {
      const updateDraft = (
        target: ComposerTarget,
        update: (draft: ComposerDraft) => ComposerDraft,
      ) => set((state) => updatedDraft(state, target, update));
      const updateDraftHoldingAttachment = (
        fileId: string,
        update: (file: ComposerAttachment) => ComposerAttachment,
      ) =>
        set((state) => {
          const key = Object.keys(state.draftsByTarget).find((candidate) =>
            [
              ...state.draftsByTarget[candidate]!.images,
              ...state.draftsByTarget[candidate]!.files,
            ].some((file) => file.id === fileId),
          );
          return key === undefined
            ? state
            : updatedDraft(state, key, (draft) => {
                const current = [...draft.images, ...draft.files];
                const next = current.map((file) => (file.id === fileId ? update(file) : file));
                return next.every((file, index) => file === current[index])
                  ? draft
                  : {
                      ...draft,
                      images: next.filter((file) => file.type === "image"),
                      files: next.filter((file) => file.type === "file"),
                    };
              });
        });
      const addAttachments = (
        target: ComposerTarget,
        files: ComposerAttachment[],
        appendReference = false,
      ) => {
        let acceptedIds: string[] = [];
        updateDraft(target, (draft) => {
          const current = [...draft.images, ...draft.files];
          const knownIds = new Set(current.map((file) => file.id));
          const knownFiles = new Map(
            current.map((file) => [`${file.type}:${attachmentDedupKey(file)}`, file]),
          );
          const previewUrls = new Set(draft.images.map((image) => image.previewUrl));
          const accepted: ComposerAttachment[] = [];
          const replacements = new Map<string, ComposerAttachment>();
          for (const file of files) {
            if (knownIds.has(file.id)) {
              if (file.type === "image" && !previewUrls.has(file.previewUrl))
                revokeObjectPreviewUrl(file.previewUrl);
              continue;
            }
            const key = `${file.type}:${attachmentDedupKey(file)}`;
            const duplicate = knownFiles.get(key);
            if (duplicate) {
              if (composerAttachmentNeedsReattach(duplicate)) {
                replacements.set(duplicate.id, file);
                knownIds.add(file.id);
                knownFiles.set(key, file);
                if (file.type === "image") previewUrls.add(file.previewUrl);
              } else if (file.type === "image" && !previewUrls.has(file.previewUrl)) {
                revokeObjectPreviewUrl(file.previewUrl);
              }
              continue;
            }
            if (
              draft.images.length + draft.files.length + accepted.length >=
              MESSAGE_MAX_ATTACHMENTS
            ) {
              if (file.type === "image") revokeObjectPreviewUrl(file.previewUrl);
              continue;
            }
            accepted.push(file);
            knownIds.add(file.id);
            knownFiles.set(key, file);
            if (file.type === "image") previewUrls.add(file.previewUrl);
          }
          acceptedIds = accepted.map((file) => file.id);
          if (accepted.length === 0 && replacements.size === 0) return draft;
          const prompt = replaceComposerContextReferences(draft.prompt, (occurrence) => {
            const original = current.find(
              (file) => attachmentContextReference(file).contextId === occurrence.contextId,
            );
            const replacement = original && replacements.get(original.id);
            return replacement
              ? formatComposerContextReference(attachmentContextReference(replacement))
              : occurrence.source;
          });
          const next = [...current.map((file) => replacements.get(file.id) ?? file), ...accepted];
          return {
            ...draft,
            prompt: appendReference
              ? ensureInlineContextReferences(
                  prompt,
                  [...accepted, ...replacements.values()].map(attachmentContextReference),
                )
              : prompt,
            images: next.filter((file) => file.type === "image"),
            files: next.filter((file) => file.type === "file"),
            inputId: null,
          };
        });
        return acceptedIds;
      };
      return {
        draftsByTarget: {},
        getComposerDraft: (target) => get().draftsByTarget[target] ?? null,
        clearDraft: (target) =>
          set((state) => {
            const { [target]: removed, ...draftsByTarget } = state.draftsByTarget;
            if (removed === undefined) return state;
            for (const image of removed.images) revokeObjectPreviewUrl(image.previewUrl);
            return { draftsByTarget };
          }),
        setPrompt: (target, prompt) =>
          updateDraft(target, (draft) =>
            draft.prompt === prompt ? draft : { ...draft, prompt, inputId: null },
          ),
        addImages: (target, images) => addAttachments(target, images),
        removeImage: (target, imageId) => {
          updateDraft(target, (draft) => {
            const image = draft.images.find((candidate) => candidate.id === imageId);
            if (!image) return draft;
            revokeObjectPreviewUrl(image.previewUrl);
            return {
              ...draft,
              prompt: removeContextReferences(draft.prompt, contextIdFor("image", imageId)),
              images: draft.images.filter((candidate) => candidate !== image),
              inputId: null,
            };
          });
        },
        addFiles: (target, files, options) =>
          addAttachments(target, files, options?.appendReference),
        removeFile: (target, fileId) =>
          updateDraft(target, (draft) =>
            draft.files.some((file) => file.id === fileId)
              ? {
                  ...draft,
                  prompt: removeContextReferences(draft.prompt, contextIdFor("file", fileId)),
                  files: draft.files.filter((file) => file.id !== fileId),
                  inputId: null,
                }
              : draft,
          ),
        setAttachmentUpload: (fileId, attachmentId) =>
          updateDraftHoldingAttachment(fileId, (file) =>
            file.uploadedAttachmentId === attachmentId
              ? file
              : { ...file, uploadedAttachmentId: attachmentId },
          ),
        markAttachmentUploadMissing: (fileId, attachmentId) => {
          let marked = false;
          updateDraftHoldingAttachment(fileId, (file) => {
            if (file.file !== null || file.uploadedAttachmentId !== attachmentId) return file;
            marked = true;
            const { uploadedAttachmentId: _expired, ...marker } = file;
            return marker.type === "image" ? { ...marker, previewUrl: "" } : marker;
          });
          return marked;
        },
        clearComposerContent: (target) => updateDraft(target, () => EMPTY_DRAFT),
        claimInputId: (target) => {
          const claimed = get().getComposerDraft(target)?.inputId;
          if (claimed) return claimed;
          const inputId = randomUUID();
          updateDraft(target, (draft) => ({ ...draft, inputId }));
          return inputId;
        },
        forgetInputId: (target, inputId) =>
          updateDraft(target, (draft) =>
            draft.inputId === inputId ? { ...draft, inputId: null } : draft,
          ),
        clearSentContent: (target, inputId) => {
          if (get().getComposerDraft(target)?.inputId !== inputId) return false;
          get().clearComposerContent(target);
          return true;
        },
      };
    },
    {
      name: COMPOSER_DRAFT_STORAGE_KEY,
      version: COMPOSER_DRAFT_STORAGE_VERSION,
      storage: composerPersistStorage,
      migrate: () => EMPTY_PERSISTED_STATE,
      partialize: (state): ComposerPersistState => ({ capturedState: state }),
      merge: (persisted, current) => ({
        ...current,
        draftsByTarget: Object.fromEntries(
          Object.entries(decodePersistedState(persisted).draftsByTarget).flatMap(([key, saved]) => {
            const draft = hydrateDraft(saved);
            return isEmptyDraft(draft) ? [] : [[key, draft]];
          }),
        ),
      }),
    },
  ),
);

export const useComposerDraftStore = composerDraftStore;

export function useComposerDraft(target: ComposerTarget): ComposerDraft {
  return useComposerDraftStore((state) => state.draftsByTarget[target] ?? EMPTY_DRAFT);
}
