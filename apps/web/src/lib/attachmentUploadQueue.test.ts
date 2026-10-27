import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reachableAtom } from "../rpc/api";
import { appAtomRegistry } from "../state/atomRegistry";

import {
  composerFileNeedsReattach,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../composerDraftStore";
import { questionDraftKey } from "../questionDrafts";
import { testChatId } from "../state/chats.testkit";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock("../state/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});

import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseAttachmentUpload,
  releaseDraftAttachments,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "./attachmentUploadQueue";

type ProgressListener = (event: {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;
}) => void;

const uploadIds = new Map<string, string>();

function uploadedId(name: string): string {
  let id = uploadIds.get(name);
  if (id === undefined) {
    const suffix = String(uploadIds.size + 1).padStart(12, "0");
    id = `00000000-0000-4000-8000-${suffix}.${name.split(".").at(-1) ?? "bin"}`;
    uploadIds.set(name, id);
  }
  return id;
}

class TestXmlHttpRequest {
  static requests: TestXmlHttpRequest[] = [];

  status = 0;
  responseText = "";
  timeout = 0;
  method: string | null = null;
  url: string | null = null;
  readonly listeners = new Map<string, () => void>();
  progressListener: ProgressListener | null = null;

  readonly upload = {
    addEventListener: (_event: string, listener: ProgressListener) => {
      this.progressListener = listener;
    },
  };

  constructor() {
    TestXmlHttpRequest.requests.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(): void {}

  addEventListener(event: string, listener: () => void): void {
    this.listeners.set(event, listener);
  }

  send(): void {}

  abort(): void {
    this.listeners.get("abort")?.();
  }

  progress(loaded: number, total: number): void {
    this.progressListener?.({ lengthComputable: true, loaded, total });
  }

  /** A successful upload answers with a server attachment id, separate from the draft id. */
  complete(status = 201): void {
    this.status = status;
    if (status === 201) {
      const url = new URL(this.url!, "http://localhost");
      this.responseText = JSON.stringify({
        attachmentId: uploadedId(url.searchParams.get("name")!),
      });
    }
    this.listeners.get("load")?.();
  }
}

function makeImage(id: string): ComposerImageAttachment {
  const file = new File([new Uint8Array([1, 2, 3])], `${id}.png`, { type: "image/png" });
  return {
    type: "image",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: `blob:${id}`,
    file,
  };
}

function makeFile(id: string): ComposerFileAttachment {
  const file = new File([new Uint8Array([1, 2, 3])], `${id}.pdf`, {
    type: "application/pdf",
  });
  return {
    type: "file",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
  };
}

function setReachable(isReachable: boolean) {
  appAtomRegistry.set(reachableAtom, isReachable);
}

describe("attachmentUploadQueue", () => {
  beforeEach(() => {
    setReachable(true);
    TestXmlHttpRequest.requests = [];
    uploadIds.clear();
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("XMLHttpRequest", TestXmlHttpRequest);
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    for (const id of Object.keys(useAttachmentUploadStore.getState().uploadsByAttachmentId)) {
      releaseAttachmentUpload(id);
    }
    vi.unstubAllGlobals();
  });

  it.each([false, true])(
    "retries a failed file once the server is reachable again, including a late failure: %s",
    async (lateFailure) => {
      const image = makeFile("reconnect");
      startAttachmentUpload(image);
      await Promise.resolve();
      const firstSettled = awaitAttachmentUploads([image.id]);
      setReachable(false);
      if (lateFailure) setReachable(true);
      TestXmlHttpRequest.requests[0]!.complete(503);
      await firstSettled;
      if (!lateFailure) setReachable(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(TestXmlHttpRequest.requests).toHaveLength(2);
      const retrySettled = awaitAttachmentUploads([image.id]);
      TestXmlHttpRequest.requests[1]!.complete(503);
      await retrySettled;
      setReachable(true);
      await Promise.resolve();
      expect(TestXmlHttpRequest.requests).toHaveLength(2);
      expect(readAttachmentUpload(image.id)?.status).toBe("failed");

      setReachable(false);
      setReachable(true);
      await Promise.resolve();
      await Promise.resolve();
      const finalSettled = awaitAttachmentUploads([image.id]);
      TestXmlHttpRequest.requests[2]!.complete();
      await finalSettled;
      expect(getUploadedAttachments([image])).not.toBeNull();
      setReachable(false);
      setReachable(true);
      await Promise.resolve();
      expect(TestXmlHttpRequest.requests).toHaveLength(3);
    },
  );

  it("does not retry after the attachment is removed", async () => {
    const image = makeFile("removed");
    startAttachmentUpload(image);
    await Promise.resolve();
    const settled = awaitAttachmentUploads([image.id]);
    TestXmlHttpRequest.requests[0]!.complete(503);
    await settled;
    setReachable(false);
    setReachable(true);
    releaseAttachmentUpload(image.id);
    await Promise.resolve();
    expect(TestXmlHttpRequest.requests).toHaveLength(1);
    expect(readAttachmentUpload(image.id)).toBeUndefined();
  });

  it("uploads images immediately and sends attachment references", async () => {
    const image = makeImage("image-1");
    startAttachmentUpload(image);
    await Promise.resolve();

    const request = TestXmlHttpRequest.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/api/attachments?type=image&name=image-1.png&mimeType=image%2Fpng");
    request.progress(1, 3);
    expect(readAttachmentUpload(image.id)).toMatchObject({ status: "uploading", progress: 1 / 3 });

    const settled = awaitAttachmentUploads([image.id]);
    request.complete();
    await settled;

    expect(getUploadedAttachments([image])).toEqual([
      {
        type: "image",
        id: uploadedId("image-1.png"),
        name: "image-1.png",
        mimeType: "image/png",
        sizeBytes: 3,
      },
    ]);

    releaseDraftAttachments([image]);
    expect(readAttachmentUpload(image.id)).toBeUndefined();
  });

  it("uploads generic files and sends file attachment references", async () => {
    const file = {
      ...makeFile("report"),
      source: { _tag: "pasted-text" as const },
    };
    startAttachmentUpload(file);
    await Promise.resolve();

    expect(TestXmlHttpRequest.requests[0]?.url).toBe(
      "/api/attachments?type=file&name=report.pdf&mimeType=application%2Fpdf",
    );

    const settled = awaitAttachmentUploads([file.id]);
    TestXmlHttpRequest.requests[0]!.complete();
    await settled;

    expect(getUploadedAttachments([file])).toEqual([
      {
        type: "file",
        id: uploadedId("report.pdf"),
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 3,
        source: { _tag: "pasted-text" },
      },
    ]);
  });

  it("persists a background completion's ids to the draft with no composer mounted", async () => {
    const draftTarget = testChatId(1);
    const file = makeFile("background");
    const draftStore = useComposerDraftStore.getState();
    draftStore.addFiles(draftTarget, [file]);
    try {
      startAttachmentUpload(file);
      await Promise.resolve();

      const settled = awaitAttachmentUploads([file.id]);
      TestXmlHttpRequest.requests[0]!.complete();
      await settled;

      expect(useComposerDraftStore.getState().getComposerDraft(draftTarget)?.files).toMatchObject([
        {
          id: file.id,
          uploadedAttachmentId: uploadedId("background.pdf"),
        },
      ]);
    } finally {
      useComposerDraftStore.getState().clearComposerContent(draftTarget);
    }
  });

  it("stamps a finished upload onto a file put back into its draft", async () => {
    const draftTarget = testChatId(3);
    const file = makeFile("put-back");
    const store = useComposerDraftStore.getState();
    try {
      startAttachmentUpload(file);
      await Promise.resolve();
      const settled = awaitAttachmentUploads([file.id]);
      TestXmlHttpRequest.requests[0]!.complete();
      await settled;
      store.addFiles(draftTarget, [file]);
      expect(store.getComposerDraft(draftTarget)?.files[0]?.uploadedAttachmentId).toBeUndefined();

      startAttachmentUpload(file);
      expect(store.getComposerDraft(draftTarget)?.files[0]?.uploadedAttachmentId).toBe(
        uploadedId("put-back.pdf"),
      );
      expect(TestXmlHttpRequest.requests).toHaveLength(1);
    } finally {
      store.clearComposerContent(draftTarget);
    }
  });

  it("persists a retried question upload without a mounted composer", async () => {
    const draftTarget = questionDraftKey(testChatId(2), "request-1", "files");
    const file = makeFile("question-retry");
    const store = useComposerDraftStore.getState();
    store.addFiles(draftTarget, [file]);
    try {
      startAttachmentUpload(file);
      await Promise.resolve();
      let settled = awaitAttachmentUploads([file.id]);
      TestXmlHttpRequest.requests[0]!.complete(500);
      await settled;
      expect(store.getComposerDraft(draftTarget)?.files[0]?.uploadedAttachmentId).toBeUndefined();
      retryAttachmentUpload(file);
      await Promise.resolve();
      settled = awaitAttachmentUploads([file.id]);
      TestXmlHttpRequest.requests[1]!.complete();
      await settled;
      expect(store.getComposerDraft(draftTarget)?.files[0]).toMatchObject({
        uploadedAttachmentId: uploadedId("question-retry.pdf"),
      });
    } finally {
      store.clearComposerContent(draftTarget);
    }
  });

  it("verifies an uploaded file reference before restoring it", async () => {
    const file: ComposerFileAttachment = {
      ...makeFile("restored"),
      file: null,
      uploadedAttachmentId: uploadedId("restored.pdf"),
    };

    startAttachmentUpload(file);
    await awaitAttachmentUploads([file.id]);

    expect(readAttachmentUpload(file.id)).toEqual({
      status: "ready",
      attachmentId: uploadedId("restored.pdf"),
    });
    expect(mocks.fetch).toHaveBeenCalledWith(
      `/api/attachments/${uploadedId("restored.pdf")}/${uploadedId("restored.pdf")}`,
      { method: "HEAD", cache: "no-store" },
    );
    expect(TestXmlHttpRequest.requests).toHaveLength(0);
  });

  it("turns an expired persisted file into a marker that a re-pick can replace", async () => {
    const draftTarget = testChatId(3);
    const file: ComposerFileAttachment = {
      ...makeFile("expired"),
      file: null,
      uploadedAttachmentId: uploadedId("old-expired.pdf"),
    };
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    useComposerDraftStore.getState().addFiles(draftTarget, [file]);

    try {
      startAttachmentUpload(file);
      await awaitAttachmentUploads([file.id]);

      const marker = useComposerDraftStore.getState().getComposerDraft(draftTarget)?.files[0];
      expect(readAttachmentUpload(file.id)).toBeUndefined();
      expect(marker?.uploadedAttachmentId).toBeUndefined();
      expect(marker && composerFileNeedsReattach(marker)).toBe(true);

      const replacementBytes = new File([new Uint8Array([1, 2, 3])], file.name, {
        type: file.mimeType,
      });
      const replacement: ComposerFileAttachment = {
        type: "file",
        id: "expired-repicked",
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        file: replacementBytes,
      };
      useComposerDraftStore.getState().addFiles(draftTarget, [replacement]);
      expect(useComposerDraftStore.getState().getComposerDraft(draftTarget)?.files).toMatchObject([
        { id: replacement.id, file: replacementBytes },
      ]);

      startAttachmentUpload(replacement);
      await Promise.resolve();
      const settled = awaitAttachmentUploads([replacement.id]);
      TestXmlHttpRequest.requests[0]!.complete();
      await settled;

      expect(useComposerDraftStore.getState().getComposerDraft(draftTarget)?.files).toMatchObject([
        {
          id: replacement.id,
          uploadedAttachmentId: uploadedId("expired.pdf"),
        },
      ]);
    } finally {
      useComposerDraftStore.getState().clearComposerContent(draftTarget);
    }
  });

  it("uploads the original file again when its persisted server upload expired", async () => {
    const file: ComposerFileAttachment = {
      ...makeFile("recoverable"),
      uploadedAttachmentId: uploadedId("old-expired.pdf"),
    };
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));

    startAttachmentUpload(file);
    // The verify-then-reupload path crosses several awaits before the
    // transfer starts; drain microtasks until the XHR exists.
    for (let hop = 0; hop < 20 && TestXmlHttpRequest.requests.length === 0; hop += 1) {
      await Promise.resolve();
    }

    const settled = awaitAttachmentUploads([file.id]);
    TestXmlHttpRequest.requests[0]!.complete();
    await settled;

    expect(readAttachmentUpload(file.id)).toMatchObject({
      status: "ready",
      attachmentId: uploadedId("recoverable.pdf"),
    });
  });

  it("keeps the persisted upload when retrying after a transient verification failure", async () => {
    const draftTarget = testChatId(4);
    const file: ComposerFileAttachment = {
      ...makeFile("flaky"),
      file: null,
      uploadedAttachmentId: uploadedId("flaky.pdf"),
    };
    mocks.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    useComposerDraftStore.getState().addFiles(draftTarget, [file]);

    try {
      startAttachmentUpload(file);
      await awaitAttachmentUploads([file.id]);
      expect(readAttachmentUpload(file.id)).toMatchObject({
        status: "failed",
        reason: "Uploaded file could not be verified. Retry when the server reconnects.",
      });
      expect(useComposerDraftStore.getState().getComposerDraft(draftTarget)?.files).toMatchObject([
        {
          uploadedAttachmentId: uploadedId("flaky.pdf"),
        },
      ]);

      // The persisted id is the only server copy of the bytes (`file` is null
      // after a reload), so the retry must verify it again, not delete it.
      retryAttachmentUpload(file);
      await awaitAttachmentUploads([file.id]);

      expect(readAttachmentUpload(file.id)).toEqual({
        status: "ready",
        attachmentId: uploadedId("flaky.pdf"),
      });
      expect(useComposerDraftStore.getState().getComposerDraft(draftTarget)?.files).toMatchObject([
        {
          uploadedAttachmentId: uploadedId("flaky.pdf"),
        },
      ]);
    } finally {
      useComposerDraftStore.getState().clearComposerContent(draftTarget);
    }
  });

  it("cancels persisted-upload verification when a draft discards its file", async () => {
    const file: ComposerFileAttachment = {
      ...makeFile("checking"),
      file: null,
      uploadedAttachmentId: uploadedId("checking.pdf"),
    };
    let resolveVerification: (response: Response) => void = () => {};
    mocks.fetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveVerification = resolve;
      }),
    );

    startAttachmentUpload(file);
    releaseDraftAttachments([file]);
    resolveVerification(new Response(null, { status: 200 }));
    await Promise.resolve();

    expect(readAttachmentUpload(file.id)).toBeUndefined();
  });

  it("retries rejected uploads", async () => {
    const image = makeImage("image-retry");
    startAttachmentUpload(image);
    await Promise.resolve();

    let settled = awaitAttachmentUploads([image.id]);
    TestXmlHttpRequest.requests[0]!.complete(500);
    await settled;
    expect(readAttachmentUpload(image.id)).toMatchObject({
      status: "failed",
      reason: "Something went wrong on the server.",
    });

    retryAttachmentUpload(image);
    await Promise.resolve();
    settled = awaitAttachmentUploads([image.id]);
    TestXmlHttpRequest.requests[1]!.complete();
    await settled;

    expect(readAttachmentUpload(image.id)).toMatchObject({ status: "ready" });
  });

  it("runs at most three uploads at once", async () => {
    const images = ["image-a", "image-b", "image-c", "image-d"].map(makeImage);
    for (const image of images) {
      startAttachmentUpload(image);
    }
    await Promise.resolve();

    expect(TestXmlHttpRequest.requests).toHaveLength(3);
    for (const request of TestXmlHttpRequest.requests) {
      request.complete();
    }
    await Promise.all(images.slice(0, 3).map((image) => awaitAttachmentUploads([image.id])));
    await Promise.resolve();
    TestXmlHttpRequest.requests[3]!.complete();
    await awaitAttachmentUploads([images[3]!.id]);
  });
});
