import {
  MESSAGE_MAX_ATTACHMENTS,
  PastedTextAttachmentSource,
} from "@t45/contracts/models/Attachment";
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
import { readFileAsDataUrl } from "./lib/imageCompression";
import { browserStorage, createDeferredStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";
import type { QuestionDraftKey } from "./questionDrafts";
import { type ChatFileAttachment, type ChatImageAttachment } from "./types";

const COMPOSER_DRAFT_STORAGE_KEY = "t45:composer-drafts:v1";
const COMPOSER_DRAFT_STORAGE_VERSION = 15;

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

const PersistedImage = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
});
type PersistedImage = typeof PersistedImage.Type;

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File;
}

export interface ComposerFileAttachment extends Omit<ChatFileAttachment, "previewUrl"> {
  file: File | null;
  uploadedAttachmentId?: string;
}

export type ComposerAttachment = ComposerImageAttachment | ComposerFileAttachment;

/**
 * A hydrated draft file whose upload never finished before the reload has
 * neither bytes (`file` is only ever null after hydration) nor a server-side
 * upload. The composer renders it as a needs-reattach row: the user must
 * attach the file again or remove it before sending.
 */
export function composerFileNeedsReattach(file: ComposerFileAttachment): boolean {
  return file.file === null && file.uploadedAttachmentId === undefined;
}

/**
 * A draft's file as it persists: its `File` handle cannot serialize, so one whose upload never
 * finished persists without an upload id and hydrates as a needs-reattach row instead of vanishing.
 */
const PersistedFile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  uploadedAttachmentId: Schema.optionalKey(Schema.String),
  source: Schema.optional(PastedTextAttachmentSource),
});

const PersistedDraft = Schema.Struct({
  prompt: Schema.String,
  images: Schema.Array(PersistedImage),
  files: Schema.Array(PersistedFile),
  inputId: Schema.NullOr(Schema.String),
});
type PersistedDraft = typeof PersistedDraft.Type;

const PersistedComposerDraftStoreState = Schema.Struct({
  draftsByTarget: Schema.Record(Schema.String, PersistedDraft),
});
type PersistedComposerDraftStoreState = typeof PersistedComposerDraftStoreState.Type;

const PersistedComposerDraftStoreStorage = Schema.Struct({
  version: Schema.Number,
  state: PersistedComposerDraftStoreState,
});

/** What the composer holds for a chat (`ChatId`) or a question field (`QuestionDraftKey`). */
export interface ComposerDraft {
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  nonPersistedImageIds: string[];
  persistedImages: PersistedImage[];
  /**
   * The id a send of this content went out under. Any edit drops it, so a send repeated after a
   * lost answer, or after a reload, reuses it only while the content is unchanged and T45 keeps
   * one input.
   */
  inputId: string | null;
}

const holdsAttachments = (draft: ComposerDraft) =>
  draft.images.length + draft.files.length + draft.persistedImages.length > 0;

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
  setFileUpload: (fileId: string, attachmentId: string) => void;
  markFileUploadMissing: (fileId: string, attachmentId: string) => boolean;
  syncPersistedImages: (target: ComposerTarget, images: PersistedImage[]) => Promise<void>;
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
  nonPersistedImageIds: [],
  persistedImages: [],
  inputId: null,
});

type AttachmentSignature = Pick<ComposerFileAttachment, "mimeType" | "sizeBytes" | "name">;

/**
 * Duplicate detection by metadata, not `File.lastModified`: an image hydrated from
 * localStorage gets a fresh `lastModified`.
 */
function attachmentDedupKey(attachment: AttachmentSignature): string {
  return `${attachment.mimeType}\u0000${attachment.sizeBytes}\u0000${attachment.name}`;
}

export function composerFileMatchesReattachMarker(
  marker: AttachmentSignature,
  file: AttachmentSignature,
): boolean {
  return attachmentDedupKey(marker) === attachmentDedupKey(file);
}

/** Hydrated images preview from their data URL, which has nothing to revoke. */
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
    images: draft.persistedImages,
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

const decodeStoredComposerDrafts = Schema.decodeSync(
  Schema.fromJsonString(PersistedComposerDraftStoreStorage),
);

/** The image ids the stored draft really holds: a write over the storage quota leaves them out. */
function readPersistedImageIds(key: string): ReadonlySet<string> {
  try {
    composerDebouncedStorage.flush();
  } catch {}
  try {
    const stored = composerStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
    const persisted = stored === null ? null : decodeStoredComposerDrafts(stored);
    if (persisted?.version !== COMPOSER_DRAFT_STORAGE_VERSION) return new Set();
    return new Set((persisted.state.draftsByTarget[key]?.images ?? []).map(({ id }) => id));
  } catch {
    return new Set();
  }
}

/** Persisted images are FileReader data URLs, which are always base64. */
function hydrateImage({ dataUrl, ...image }: PersistedImage): ComposerImageAttachment[] {
  const comma = dataUrl.indexOf(",");
  const payload = comma === -1 ? "" : dataUrl.slice(comma + 1);
  if (payload.length === 0) return [];
  try {
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    const file = new File([bytes], image.name, { type: image.mimeType });
    return [{ ...image, type: "image", previewUrl: dataUrl, file }];
  } catch {
    return [];
  }
}

function hydrateDraft(draft: PersistedDraft): ComposerDraft {
  return {
    prompt: draft.prompt,
    images: draft.images.flatMap(hydrateImage),
    files: draft.files.map((file) => ({ ...file, type: "file", file: null })),
    nonPersistedImageIds: [],
    persistedImages: [...draft.images],
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
      const updateDraftHoldingFile = (
        fileId: string,
        update: (draft: ComposerDraft) => ComposerDraft,
      ) =>
        set((state) => {
          const key = Object.keys(state.draftsByTarget).find((candidate) =>
            state.draftsByTarget[candidate]!.files.some((file) => file.id === fileId),
          );
          return key === undefined ? state : updatedDraft(state, key, update);
        });
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
        addImages: (target, images) => {
          let accepted: ComposerImageAttachment[] = [];
          updateDraft(target, (draft) => {
            const ids = new Set(draft.images.map((image) => image.id));
            const keys = new Set(draft.images.map(attachmentDedupKey));
            const previewUrls = new Set(draft.images.map((image) => image.previewUrl));
            accepted = [];
            for (const image of images) {
              const key = attachmentDedupKey(image);
              const full =
                draft.images.length + draft.files.length + accepted.length >=
                MESSAGE_MAX_ATTACHMENTS;
              if (ids.has(image.id) || keys.has(key) || full) {
                if (!previewUrls.has(image.previewUrl)) revokeObjectPreviewUrl(image.previewUrl);
                continue;
              }
              accepted.push(image);
              ids.add(image.id);
              keys.add(key);
              previewUrls.add(image.previewUrl);
            }
            return accepted.length === 0
              ? draft
              : { ...draft, images: [...draft.images, ...accepted], inputId: null };
          });
          if (accepted.length > 0) void persistImages(target);
          return accepted.map((image) => image.id);
        },
        removeImage: (target, imageId) => {
          updateDraft(target, (draft) => {
            const image = draft.images.find((candidate) => candidate.id === imageId);
            if (!image) return draft;
            revokeObjectPreviewUrl(image.previewUrl);
            return {
              ...draft,
              prompt: removeContextReferences(draft.prompt, contextIdFor("image", imageId)),
              images: draft.images.filter((candidate) => candidate !== image),
              nonPersistedImageIds: draft.nonPersistedImageIds.filter((id) => id !== imageId),
              persistedImages: draft.persistedImages.filter((saved) => saved.id !== imageId),
              inputId: null,
            };
          });
          void persistImages(target);
        },
        addFiles: (target, files, options) => {
          let acceptedIds: string[] = [];
          updateDraft(target, (draft) => {
            const knownIds = new Set(draft.files.map((file) => file.id));
            const knownFiles = new Map(draft.files.map((file) => [attachmentDedupKey(file), file]));
            const accepted: ComposerFileAttachment[] = [];
            const replacements = new Map<string, ComposerFileAttachment>();
            for (const file of files) {
              if (knownIds.has(file.id)) continue;
              const key = attachmentDedupKey(file);
              const duplicate = knownFiles.get(key);
              if (duplicate) {
                if (composerFileNeedsReattach(duplicate)) {
                  replacements.set(duplicate.id, file);
                  knownIds.add(file.id);
                  knownFiles.set(key, file);
                }
                continue;
              }
              if (
                draft.images.length + draft.files.length + accepted.length >=
                MESSAGE_MAX_ATTACHMENTS
              ) {
                break;
              }
              accepted.push(file);
              knownIds.add(file.id);
              knownFiles.set(key, file);
            }
            acceptedIds = accepted.map((file) => file.id);
            if (accepted.length === 0 && replacements.size === 0) return draft;
            const prompt = replaceComposerContextReferences(draft.prompt, (occurrence) => {
              const original = draft.files.find(
                (file) => attachmentContextReference(file).contextId === occurrence.contextId,
              );
              const replacement = original && replacements.get(original.id);
              return replacement
                ? formatComposerContextReference(attachmentContextReference(replacement))
                : occurrence.source;
            });
            return {
              ...draft,
              prompt: options?.appendReference
                ? ensureInlineContextReferences(
                    prompt,
                    [...accepted, ...replacements.values()].map(attachmentContextReference),
                  )
                : prompt,
              files: [...draft.files.map((file) => replacements.get(file.id) ?? file), ...accepted],
              inputId: null,
            };
          });
          return acceptedIds;
        },
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
        setFileUpload: (fileId, attachmentId) =>
          updateDraftHoldingFile(fileId, (draft) =>
            draft.files.some(
              (file) => file.id === fileId && file.uploadedAttachmentId !== attachmentId,
            )
              ? {
                  ...draft,
                  files: draft.files.map((file) =>
                    file.id === fileId ? { ...file, uploadedAttachmentId: attachmentId } : file,
                  ),
                }
              : draft,
          ),
        markFileUploadMissing: (fileId, attachmentId) => {
          let marked = false;
          updateDraftHoldingFile(fileId, (draft) => {
            marked = draft.files.some(
              (file) =>
                file.id === fileId &&
                file.file === null &&
                file.uploadedAttachmentId === attachmentId,
            );
            if (!marked) return draft;
            return {
              ...draft,
              files: draft.files.map((file) => {
                if (file.id !== fileId) return file;
                const { uploadedAttachmentId: _expired, ...marker } = file;
                return marker;
              }),
            };
          });
          return marked;
        },
        syncPersistedImages: async (target, images) => {
          const ids = new Set(images.map((image) => image.id));
          updateDraft(target, (draft) =>
            draft.images.length === 0
              ? draft
              : {
                  ...draft,
                  persistedImages: images,
                  nonPersistedImageIds: draft.nonPersistedImageIds.filter((id) => !ids.has(id)),
                },
          );
          await Promise.resolve();
          const saved = readPersistedImageIds(target);
          updateDraft(target, (draft) => {
            const draftIds = new Set(draft.images.map((image) => image.id));
            return {
              ...draft,
              persistedImages: images.filter(({ id }) => draftIds.has(id) && saved.has(id)),
              nonPersistedImageIds: [...draftIds].filter((id) => !saved.has(id)),
            };
          });
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

const persistRuns = new Map<ComposerTarget, symbol>();

/**
 * Saves the bytes of a draft's unsaved images, so they survive a reload; a newer call for the
 * draft takes over. One the browser can't read, or that the storage quota can't hold, is marked
 * as not saved.
 */
async function persistImages(target: ComposerTarget) {
  const before = composerDraftStore.getState().getComposerDraft(target);
  const saved = new Set(before?.persistedImages.map((image) => image.id));
  const unsaved = before?.images.filter((image) => !saved.has(image.id)) ?? [];
  if (unsaved.length === 0) return;
  const run = Symbol();
  persistRuns.set(target, run);
  const read = await Promise.all(
    unsaved.map((image) =>
      readFileAsDataUrl(image.file).then(
        (dataUrl) => ({
          id: image.id,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          dataUrl,
        }),
        () => null,
      ),
    ),
  );
  if (persistRuns.get(target) !== run) return;
  persistRuns.delete(target);
  const draft = composerDraftStore.getState().getComposerDraft(target);
  if (!draft) return;
  const byId = new Map(
    [...draft.persistedImages, ...read.filter((image) => image !== null)].map((image) => [
      image.id,
      image,
    ]),
  );
  await composerDraftStore.getState().syncPersistedImages(
    target,
    draft.images.flatMap((image) => byId.get(image.id) ?? []),
  );
}

export function useComposerDraft(target: ComposerTarget): ComposerDraft {
  return useComposerDraftStore((state) => state.draftsByTarget[target] ?? EMPTY_DRAFT);
}
