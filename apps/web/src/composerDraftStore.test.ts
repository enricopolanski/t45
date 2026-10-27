import { MESSAGE_MAX_ATTACHMENTS } from "@t45/contracts/models/Attachment";
import type { ChatId } from "@t45/contracts/models/Chat";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  composerFileNeedsReattach,
  partializeComposerDraftStoreState,
  useComposerDraftStore,
} from "./composerDraftStore";
import { createDeferredStorage } from "./lib/storage";
import { testChatId } from "./state/chats.testkit";

function makeImage(input: {
  id: string;
  previewUrl: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  lastModified?: number;
}): ComposerImageAttachment {
  const name = input.name ?? "image.png";
  const mimeType = input.mimeType ?? "image/png";
  const sizeBytes = input.sizeBytes ?? 4;
  const lastModified = input.lastModified ?? 1_700_000_000_000;
  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified,
  });
  return {
    type: "image",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  };
}

function makeFile(id: string): ComposerFileAttachment {
  const file = new File(["report"], "report.pdf", { type: "application/pdf" });
  return {
    type: "file",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
  };
}

function resetComposerDraftStore() {
  useComposerDraftStore.setState({ draftsByTarget: {} });
}

function draftFor(chatId: ChatId) {
  return useComposerDraftStore.getState().draftsByTarget[chatId];
}

describe("composerDraftStore addImages", () => {
  const chatId = testChatId(3);
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("deduplicates identical images in one batch by file signature", () => {
    const first = makeImage({
      id: "img-1",
      previewUrl: "blob:first",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 12,
      lastModified: 12345,
    });
    const duplicate = makeImage({
      id: "img-2",
      previewUrl: "blob:duplicate",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 12,
      lastModified: 12345,
    });

    useComposerDraftStore.getState().addImages(chatId, [first, duplicate]);

    const draft = draftFor(chatId);
    expect(draft?.images.map((image) => image.id)).toEqual(["img-1"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:duplicate");
  });

  it("deduplicates against existing images across calls by file signature", () => {
    const first = makeImage({
      id: "img-a",
      previewUrl: "blob:a",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 9,
      lastModified: 777,
    });
    const duplicateLater = makeImage({
      id: "img-b",
      previewUrl: "blob:b",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 9,
      lastModified: 999,
    });

    expect(useComposerDraftStore.getState().addImages(chatId, [first])).toEqual(["img-a"]);
    expect(useComposerDraftStore.getState().addImages(chatId, [duplicateLater])).toEqual([]);

    const draft = draftFor(chatId);
    expect(draft?.images.map((image) => image.id)).toEqual(["img-a"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:b");
  });

  it("leaves out an image whose id the draft already has", () => {
    const first = makeImage({ id: "img-same", previewUrl: "blob:first" });
    const duplicate = makeImage({
      id: "img-same",
      previewUrl: "blob:duplicate",
      name: "different.png",
    });

    expect(useComposerDraftStore.getState().addImages(chatId, [first])).toEqual(["img-same"]);
    expect(useComposerDraftStore.getState().addImages(chatId, [duplicate])).toEqual([]);
    expect(draftFor(chatId)?.images).toEqual([first]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:duplicate");
  });

  it("does not revoke blob URLs that are still used by an accepted duplicate image", () => {
    const first = makeImage({
      id: "img-shared",
      previewUrl: "blob:shared",
    });
    const duplicateSameUrl = makeImage({
      id: "img-shared",
      previewUrl: "blob:shared",
    });

    useComposerDraftStore.getState().addImages(chatId, [first, duplicateSameUrl]);

    const draft = draftFor(chatId);
    expect(draft?.images.map((image) => image.id)).toEqual(["img-shared"]);
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:shared");
  });
});

describe("composerDraftStore clearComposerContent", () => {
  const chatId = testChatId(4);
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("does not revoke blob preview URLs when clearing composer content", () => {
    const first = makeImage({
      id: "img-optimistic",
      previewUrl: "blob:optimistic",
    });
    useComposerDraftStore.getState().addImages(chatId, [first]);

    useComposerDraftStore.getState().clearComposerContent(chatId);

    const draft = draftFor(chatId);
    expect(draft).toBeUndefined();
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:optimistic");
  });
});

describe("composerDraftStore input ids", () => {
  const chatId = testChatId(5);

  beforeEach(resetComposerDraftStore);

  it("reuses the input id for unchanged content, across a reload, until the sent content is cleared", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(chatId, "Run the tests");
    const inputId = store.claimInputId(chatId);
    expect(store.claimInputId(chatId)).toBe(inputId);

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const reloaded = persistApi
      .getOptions()
      .merge(
        partializeComposerDraftStoreState(useComposerDraftStore.getState()),
        useComposerDraftStore.getState(),
      );
    expect(reloaded.draftsByTarget[chatId]?.inputId).toBe(inputId);

    expect(store.clearSentContent(chatId, inputId)).toBe(true);
    expect(draftFor(chatId)).toBeUndefined();
    store.setPrompt(chatId, "Run the tests");
    expect(store.claimInputId(chatId)).not.toBe(inputId);
  });

  it("gives edited content a new id and keeps what was written while the send awaited its answer", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(chatId, "Submitted message");
    const sent = store.claimInputId(chatId);
    store.setPrompt(chatId, "Written while sending");

    expect(store.clearSentContent(chatId, sent)).toBe(false);
    expect(draftFor(chatId)?.prompt).toBe("Written while sending");
    const next = store.claimInputId(chatId);
    expect(next).not.toBe(sent);
    store.addFiles(chatId, [makeFile("file-1")]);
    expect(store.claimInputId(chatId)).not.toBe(next);
  });

  it("forgets an id T45 refused, but not one an edit already replaced", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(chatId, "Message");
    const refused = store.claimInputId(chatId);
    store.forgetInputId(chatId, refused);
    const next = store.claimInputId(chatId);
    expect(next).not.toBe(refused);

    store.forgetInputId(chatId, refused);
    expect(store.claimInputId(chatId)).toBe(next);
    expect(draftFor(chatId)?.prompt).toBe("Message");
  });
});

describe("composerDraftStore file attachments", () => {
  const chatId = testChatId(8);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("persists uploaded file references without including file contents", () => {
    const store = useComposerDraftStore.getState();
    store.addFiles(chatId, [{ ...makeFile("file-1"), source: { _tag: "pasted-text" as const } }]);
    store.setFileUpload("file-1", "pending-report-pdf");

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const options = persistApi.getOptions();
    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());

    expect(persisted.draftsByTarget[chatId]?.files).toEqual([
      {
        id: "file-1",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 6,
        uploadedAttachmentId: "pending-report-pdf",
        source: { _tag: "pasted-text" },
      },
    ]);

    const hydrated = options.merge(persisted, useComposerDraftStore.getState());
    expect(hydrated.draftsByTarget[chatId]?.files).toEqual([
      {
        type: "file",
        id: "file-1",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 6,
        file: null,
        uploadedAttachmentId: "pending-report-pdf",
        source: { _tag: "pasted-text" },
      },
    ]);
  });

  it("persists a pending file as a needs-reattach marker instead of dropping it", () => {
    const store = useComposerDraftStore.getState();
    // No setFileUpload: the upload never finished, so there is no attachment
    // id and the File handle cannot serialize.
    store.addFiles(chatId, [makeFile("file-pending")]);

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const options = persistApi.getOptions();
    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());

    expect(persisted.draftsByTarget[chatId]?.files).toEqual([
      {
        id: "file-pending",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 6,
      },
    ]);

    const hydrated = options.merge(persisted, useComposerDraftStore.getState());
    const hydratedFiles = hydrated.draftsByTarget[chatId]?.files;
    expect(hydratedFiles).toEqual([
      {
        type: "file",
        id: "file-pending",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 6,
        file: null,
      },
    ]);
    expect(hydratedFiles?.every(composerFileNeedsReattach)).toBe(true);
  });

  it("marks only the matching byte-less upload as missing", () => {
    const store = useComposerDraftStore.getState();
    const hydrated: ComposerFileAttachment = {
      ...makeFile("file-hydrated"),
      file: null,
      uploadedAttachmentId: "pending-old",
    };
    const local: ComposerFileAttachment = {
      ...makeFile("file-local"),
      name: "local.txt",
      mimeType: "text/plain",
    };
    store.addFiles(chatId, [hydrated, local]);
    store.setFileUpload(hydrated.id, "pending-new");
    store.setFileUpload(local.id, "pending-local");

    expect(store.markFileUploadMissing(hydrated.id, "pending-old")).toBe(false);
    expect(store.markFileUploadMissing(local.id, "pending-local")).toBe(false);

    expect(store.getComposerDraft(chatId)?.files).toMatchObject([
      {
        id: hydrated.id,
        uploadedAttachmentId: "pending-new",
      },
      {
        id: local.id,
        file: local.file,
        uploadedAttachmentId: "pending-local",
      },
    ]);

    expect(store.markFileUploadMissing(hydrated.id, "pending-new")).toBe(true);
    const marker = store.getComposerDraft(chatId)?.files[0];
    expect(marker && composerFileNeedsReattach(marker)).toBe(true);
    expect(marker?.uploadedAttachmentId).toBeUndefined();
  });

  it("removes generic files when the composer is cleared", () => {
    const store = useComposerDraftStore.getState();
    store.addFiles(chatId, [makeFile("file-clear")]);

    store.clearComposerContent(chatId);

    expect(store.getComposerDraft(chatId)).toBeNull();
  });

  it("enforces the combined file and image limit across separate updates", () => {
    const store = useComposerDraftStore.getState();
    const images = Array.from({ length: MESSAGE_MAX_ATTACHMENTS - 1 }, (_, index) =>
      makeImage({
        id: `image-${index}`,
        name: `image-${index}.png`,
        previewUrl: `blob:image-${index}`,
      }),
    );
    store.addImages(chatId, images);
    store.addFiles(chatId, [
      makeFile("file-accepted"),
      { ...makeFile("file-overflow"), name: "other.pdf" },
    ]);
    expect(
      store.addImages(chatId, [
        makeImage({ id: "image-overflow", name: "overflow.png", previewUrl: "blob:overflow" }),
      ]),
    ).toEqual([]);

    const draft = store.getComposerDraft(chatId);
    expect(draft?.images).toHaveLength(MESSAGE_MAX_ATTACHMENTS - 1);
    expect(draft?.files.map((file) => file.id)).toEqual(["file-accepted"]);
  });

  it("replaces a needs-reattach marker when the same file is picked again", () => {
    const store = useComposerDraftStore.getState();
    // A hydrated marker: same metadata as the original pick, no bytes and no
    // server-side upload.
    const marker: ComposerFileAttachment = { ...makeFile("file-marker"), file: null };
    store.addFiles(chatId, [marker]);
    expect(store.getComposerDraft(chatId)?.files.every(composerFileNeedsReattach)).toBe(true);

    // Following the "Attach again" instruction produces a fresh id with the
    // exact metadata the dedup key hashes.
    const repicked = makeFile("file-repicked");
    store.addFiles(chatId, [repicked]);

    const files = store.getComposerDraft(chatId)?.files;
    expect(files?.map((file) => file.id)).toEqual(["file-repicked"]);
    expect(files?.[0]?.file).not.toBeNull();
    expect(files?.some(composerFileNeedsReattach)).toBe(false);
  });

  it("still dedupes a re-pick against a file that does not need reattaching", () => {
    const store = useComposerDraftStore.getState();
    store.addFiles(chatId, [makeFile("file-original")]);

    store.addFiles(chatId, [makeFile("file-duplicate")]);

    expect(store.getComposerDraft(chatId)?.files.map((file) => file.id)).toEqual(["file-original"]);
  });

  it("keeps same-name videos with different MIME types", () => {
    const store = useComposerDraftStore.getState();
    const mp4 = new File(["report"], "clip", { type: "video/mp4" });
    const webm = new File(["report"], "clip", { type: "video/webm" });

    store.addFiles(chatId, [
      {
        type: "file",
        id: "video-mp4",
        name: mp4.name,
        mimeType: mp4.type,
        sizeBytes: mp4.size,
        file: mp4,
      },
      {
        type: "file",
        id: "video-webm",
        name: webm.name,
        mimeType: webm.type,
        sizeBytes: webm.size,
        file: webm,
      },
    ]);

    expect(store.getComposerDraft(chatId)?.files.map((file) => file.id)).toEqual([
      "video-mp4",
      "video-webm",
    ]);
  });

  it("keeps the remaining file slot available after a duplicate is skipped", () => {
    const store = useComposerDraftStore.getState();
    store.addImages(
      chatId,
      Array.from({ length: MESSAGE_MAX_ATTACHMENTS - 2 }, (_, index) =>
        makeImage({
          id: `image-${index}`,
          name: `image-${index}.png`,
          previewUrl: `blob:image-${index}`,
        }),
      ),
    );
    store.addFiles(chatId, [makeFile("file-original")]);
    store.addFiles(chatId, [
      makeFile("file-duplicate"),
      { ...makeFile("file-unique"), name: "unique.pdf" },
    ]);

    expect(store.getComposerDraft(chatId)?.files.map((file) => file.id)).toEqual([
      "file-original",
      "file-unique",
    ]);
  });
});

describe("composerDraftStore persisted draft sanitization", () => {
  const chatId = testChatId(3);

  beforeEach(resetComposerDraftStore);

  it("sanitizes malformed persisted drafts during merge", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        draftsByTarget: {
          [chatId]: {
            prompt: "",
            attachments: "not-an-array",
          },
        },
      },
      useComposerDraftStore.getInitialState(),
    );

    expect(mergedState.draftsByTarget[chatId]).toBeUndefined();
  });
});

describe("composerDraftStore clearDraft", () => {
  const chatId = testChatId(9);

  beforeEach(resetComposerDraftStore);

  it("revokes the image blob URLs of a deleted chat's draft", () => {
    const store = useComposerDraftStore.getState();
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const revokeSpy = vi.fn<(url: string) => void>();
    URL.revokeObjectURL = revokeSpy;

    try {
      store.addImages(chatId, [makeImage({ id: "img-project-clear", previewUrl: "blob:clear" })]);

      store.clearDraft(chatId);

      expect(draftFor(chatId)).toBeUndefined();
      expect(revokeSpy).toHaveBeenCalledWith("blob:clear");
    } finally {
      URL.revokeObjectURL = originalRevokeObjectUrl;
    }
  });
});

function createMockStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((name: string) => store.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => {
      store.set(name, value);
    }),
    removeItem: vi.fn((name: string) => {
      store.delete(name);
    }),
  };
}

describe("composer draft persistence", () => {
  it("defers attachment reads and serialization until typing stops, then restores the last draft", async () => {
    await useComposerDraftStore.persist.clearStorage();
    vi.useFakeTimers();
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      resetComposerDraftStore();
      const heavyChatId = testChatId(13);
      const typingChatId = testChatId(14);
      const heavyRef = heavyChatId;
      const typingRef = typingChatId;
      const heavyKey = heavyRef;
      useComposerDraftStore.getState().setPrompt(heavyRef, "Keep this image");
      const attachments = [
        {
          id: "heavy-image",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 49_152,
          dataUrl: `data:image/png;base64,${"AQID".repeat(16_384)}`,
        },
      ];
      let attachmentReads = 0;
      useComposerDraftStore.setState((state) => ({
        draftsByTarget: {
          ...state.draftsByTarget,
          [heavyKey]: {
            ...state.draftsByTarget[heavyKey]!,
            get persistedImages() {
              attachmentReads += 1;
              return attachments;
            },
          },
        },
      }));
      attachmentReads = 0;
      stringify.mockClear();

      for (let index = 1; index <= 20; index++) {
        useComposerDraftStore.getState().setPrompt(typingRef, `Draft ${index}`);
      }
      expect(attachmentReads).toBe(0);
      expect(stringify).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(300);
      expect(attachmentReads).toBe(1);
      expect(stringify).toHaveBeenCalledTimes(1);

      resetComposerDraftStore();
      await useComposerDraftStore.persist.rehydrate();
      expect(draftFor(typingChatId)?.prompt).toBe("Draft 20");
      expect(draftFor(heavyChatId)?.persistedImages).toEqual(attachments);
    } finally {
      stringify.mockRestore();
      await useComposerDraftStore.persist.clearStorage();
      vi.useRealTimers();
      resetComposerDraftStore();
    }
  });
});

describe("createDeferredStorage", () => {
  const serialize = vi.fn((value: string) => `s:${value}`);

  beforeEach(() => {
    vi.useFakeTimers();
    serialize.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("neither serializes nor writes until the debounce fires", () => {
    const base = createMockStorage();
    const storage = createDeferredStorage(base, serialize);

    storage.setItem("key", "v1");
    expect(serialize).not.toHaveBeenCalled();
    expect(base.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(299);
    expect(serialize).not.toHaveBeenCalled();
    expect(base.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "s:v1");
  });

  it("serializes and writes only the last value when setItem is called rapidly", () => {
    const base = createMockStorage();
    const storage = createDeferredStorage(base, serialize);

    storage.setItem("key", "v1");
    storage.setItem("key", "v2");
    storage.setItem("key", "v3");

    vi.advanceTimersByTime(300);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "s:v3");
  });

  it("removeItem cancels a pending setItem write", () => {
    const base = createMockStorage();
    const storage = createDeferredStorage(base, serialize);

    storage.setItem("key", "v1");
    storage.removeItem("key");

    vi.advanceTimersByTime(300);
    expect(serialize).not.toHaveBeenCalled();
    expect(base.setItem).not.toHaveBeenCalled();
    expect(base.removeItem).toHaveBeenCalledWith("key");
  });

  it("flush serializes and writes the pending value immediately", () => {
    const base = createMockStorage();
    const storage = createDeferredStorage(base, serialize);

    storage.setItem("key", "v1");
    expect(base.setItem).not.toHaveBeenCalled();

    storage.flush();
    expect(base.setItem).toHaveBeenCalledWith("key", "s:v1");

    // Timer should be cancelled; no duplicate write.
    vi.advanceTimersByTime(300);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledTimes(1);
  });

  it("flush is a no-op when nothing is pending", () => {
    const base = createMockStorage();
    const storage = createDeferredStorage(base, serialize);

    storage.flush();
    expect(base.setItem).not.toHaveBeenCalled();
  });

  it("flush after removeItem is a no-op", () => {
    const base = createMockStorage();
    const storage = createDeferredStorage(base, serialize);

    storage.setItem("key", "v1");
    storage.removeItem("key");
    storage.flush();

    expect(base.setItem).not.toHaveBeenCalled();
  });

  it("setItem works normally after removeItem cancels a pending write", () => {
    const base = createMockStorage();
    const storage = createDeferredStorage(base, serialize);

    storage.setItem("key", "v1");
    storage.removeItem("key");
    storage.setItem("key", "v2");

    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "s:v2");
  });
});

describe("composerDraftStore attachment references", () => {
  const chatId = testChatId(15);
  const fileLink = "[notes.txt](t45-context:file/file_file-1)";
  const imageLink = "[shot.png](t45-context:image/image_img-1)";

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("reports which attachments it accepted so only those get chips", () => {
    const store = useComposerDraftStore.getState();
    const file = {
      type: "file" as const,
      id: "file-1",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      file: null,
      uploadedAttachmentId: "p",
    };
    expect(store.addFiles(chatId, [file])).toEqual(["file-1"]);
    expect(store.addFiles(chatId, [{ ...file, id: "file-2" }])).toEqual([]);
    const image = makeImage({ id: "img-1", previewUrl: "blob:img-1", name: "shot.png" });
    expect(store.addImages(chatId, [image])).toEqual(["img-1"]);
    expect(
      store.addImages(chatId, [
        makeImage({ id: "img-2", previewUrl: "blob:img-2", name: "shot.png" }),
      ]),
    ).toEqual([]);
  });

  it("strips references when an image or file is removed", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(chatId, `see ${imageLink} and ${fileLink} ok`);
    store.addImages(chatId, [
      makeImage({ id: "img-1", previewUrl: "blob:img-1", name: "shot.png" }),
    ]);
    store.addFiles(chatId, [
      {
        type: "file",
        id: "file-1",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        file: null,
        uploadedAttachmentId: "pending-1",
      },
    ]);
    store.removeImage(chatId, "img-1");
    expect(draftFor(chatId)?.prompt).toBe(`see and ${fileLink} ok`);
    store.removeFile(chatId, "file-1");
    expect(draftFor(chatId)?.prompt).toBe("see and ok");
  });

  it("moves a needs-reattach marker's chip to the re-picked file", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(chatId, "see [notes.txt](t45-context:file/file_marker-1) ok");
    store.addFiles(chatId, [
      {
        type: "file",
        id: "marker-1",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        file: null,
      },
    ]);
    const acceptedIds = store.addFiles(chatId, [
      {
        type: "file",
        id: "fresh-1",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        file: new File(["abc"], "notes.txt", { type: "text/plain" }),
      },
    ]);
    const draft = draftFor(chatId);
    expect(acceptedIds).toEqual([]);
    expect(draft?.files.map((file) => file.id)).toEqual(["fresh-1"]);
    expect(draft?.prompt).toBe("see [notes.txt](t45-context:file/file_fresh-1) ok");
  });

  it("restores a file-only draft with a reference and preserves it through prompt edits", () => {
    const store = useComposerDraftStore.getState();
    store.addFiles(
      chatId,
      [
        {
          type: "file",
          id: "restored",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
          file: null,
          uploadedAttachmentId: "uploaded",
        },
      ],
      { appendReference: true },
    );
    const restored = draftFor(chatId)!;
    expect(restored.prompt).toBe("[notes.txt](t45-context:file/file_restored) ");
    store.setPrompt(chatId, `${restored.prompt}explain this`);
    const edited = draftFor(chatId)!;
    expect(edited.files.map((file) => file.id)).toEqual(["restored"]);
    expect(edited.prompt).toContain("t45-context:file/file_restored");
  });
});
