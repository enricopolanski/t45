import { ATTACHMENT_IMAGE_MIME_TYPES, type ChatAttachment } from "@t45/contracts/models/Attachment";
import { create } from "zustand";

import {
  type ComposerAttachment,
  type ComposerTarget,
  useComposerDraftStore,
} from "../composerDraftStore";
import { reachableAtom } from "../rpc/api";
import { appAtomRegistry } from "../state/atomRegistry";
import { attachmentUploadUrl, attachmentUrl, decodeUploadResult } from "./attachmentUrl";
import { describeUploadRefusal } from "./failures";
import type { AttachmentUploadState } from "./attachmentUploadState";

const MAX_CONCURRENT_UPLOADS = 3;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

interface AttachmentUploadStore {
  readonly uploadsByAttachmentId: Readonly<Record<string, AttachmentUploadState>>;
}

export const useAttachmentUploadStore = create<AttachmentUploadStore>(() => ({
  uploadsByAttachmentId: {},
}));

interface UploadJob {
  readonly attachment: ComposerAttachment;
  /** The draft's persisted server-side upload, to verify instead of re-upload. */
  readonly persistedAttachmentId?: string;
  readonly settled: Promise<void>;
  resolveSettled: () => void;
  cancelled: boolean;
  abort: (() => void) | null;
  stopWatchingReachable: () => void;
}

// Failed jobs retain their source and reachability subscription until retry or release.
const jobsByAttachmentId = new Map<string, UploadJob>();
const queue: UploadJob[] = [];
let activeUploads = 0;

function setUploadState(id: string, upload: AttachmentUploadState): void {
  useAttachmentUploadStore.setState((state) => ({
    uploadsByAttachmentId: { ...state.uploadsByAttachmentId, [id]: upload },
  }));
}

function clearUploadState(id: string): void {
  useAttachmentUploadStore.setState((state) => {
    if (!(id in state.uploadsByAttachmentId)) {
      return state;
    }
    const uploadsByAttachmentId = { ...state.uploadsByAttachmentId };
    delete uploadsByAttachmentId[id];
    return { uploadsByAttachmentId };
  });
}

export function readAttachmentUpload(id: string): AttachmentUploadState | undefined {
  return useAttachmentUploadStore.getState().uploadsByAttachmentId[id];
}

/**
 * Persists a finished upload's id onto the draft that holds the file, so the file survives a
 * reload without its bytes, whether or not a composer is mounted.
 */
function stampDraftFileUpload(attachment: ComposerAttachment, attachmentId: string): void {
  if (attachment.type === "file") {
    useComposerDraftStore.getState().setFileUpload(attachment.id, attachmentId);
  }
}

type PersistedAttachmentVerification =
  | { readonly status: "verified" }
  | { readonly status: "missing" }
  | { readonly status: "failed"; readonly error: unknown };

/**
 * Checks that a previously uploaded pending attachment still exists on the
 * server. `verified` means the send can reuse the stored bytes, `missing`
 * means the upload expired and the bytes must be uploaded again, `failed`
 * means the server could not be asked.
 */
async function verifyPersistedAttachmentUpload(
  attachmentId: string,
): Promise<PersistedAttachmentVerification> {
  const url = attachmentUrl({ id: attachmentId });
  try {
    const response = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (response.ok) return { status: "verified" };
    if (response.status === 404) return { status: "missing" };
    return { status: "failed", error: new Error(`Attachment check failed (${response.status}).`) };
  } catch (error) {
    return { status: "failed", error };
  }
}

/** Resolves with the pending attachment id the server stored the bytes under. */
function uploadBytes(input: {
  readonly url: string;
  readonly file: File;
  readonly mimeType: string;
  readonly onProgress: (progress: number) => void;
}): { readonly done: Promise<string>; readonly abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<string>((resolve, reject) => {
    xhr.open("POST", input.url, true);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", input.mimeType);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        input.onProgress(event.loaded / event.total);
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(decodeUploadResult(xhr.responseText).attachmentId);
        } catch {
          reject(new Error("Upload returned no attachment id"));
        }
      } else {
        reject(new Error(describeUploadRefusal(xhr.status)));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.addEventListener("timeout", () => reject(new Error("Upload timed out")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
    xhr.send(input.file);
  });

  return { done, abort: () => xhr.abort() };
}

async function runUpload(job: UploadJob): Promise<void> {
  if (job.persistedAttachmentId) {
    const verification = await verifyPersistedAttachmentUpload(job.persistedAttachmentId);
    if (job.cancelled) {
      return;
    }
    if (verification.status === "verified") {
      setUploadState(job.attachment.id, {
        status: "ready",
        attachmentId: job.persistedAttachmentId,
      });
      stampDraftFileUpload(job.attachment, job.persistedAttachmentId);
      return;
    }
    if (
      verification.status === "missing" &&
      !job.attachment.file &&
      useComposerDraftStore
        .getState()
        .markFileUploadMissing(job.attachment.id, job.persistedAttachmentId)
    ) {
      clearUploadState(job.attachment.id);
      return;
    }
    if (verification.status === "failed" || !job.attachment.file) {
      // The persisted id is the only server copy of a hydrated file, so a
      // transient verification failure leaves it in place for the next retry.
      setUploadState(job.attachment.id, {
        status: "failed",
        reason:
          verification.status === "missing"
            ? "Uploaded file expired. Remove it and attach it again."
            : "Uploaded file could not be verified. Retry when the server reconnects.",
      });
      return;
    }
  }

  const mimeType =
    job.attachment.type === "file"
      ? job.attachment.mimeType.toLowerCase()
      : ATTACHMENT_IMAGE_MIME_TYPES.find(
          (supportedMimeType) => supportedMimeType === job.attachment.mimeType.toLowerCase(),
        );
  if (!mimeType) {
    setUploadState(job.attachment.id, { status: "failed", reason: "Unsupported image type" });
    return;
  }
  const file = job.attachment.file;
  if (!file) {
    setUploadState(job.attachment.id, {
      status: "failed",
      reason: "Original file is no longer available",
    });
    return;
  }

  const url = attachmentUploadUrl({
    type: job.attachment.type,
    name: job.attachment.name,
    mimeType,
  });

  let lastStep = -1;
  const transfer = uploadBytes({
    url,
    file,
    mimeType,
    onProgress: (progress) => {
      const step = Math.floor(progress * 20);
      if (step === lastStep || job.cancelled) {
        return;
      }
      lastStep = step;
      setUploadState(job.attachment.id, { status: "uploading", progress });
    },
  });
  job.abort = transfer.abort;
  let attachmentId: string;
  try {
    attachmentId = await transfer.done;
  } catch (error) {
    job.abort = null;
    if (job.cancelled) {
      return;
    }
    setUploadState(job.attachment.id, {
      status: "failed",
      reason: error instanceof Error ? error.message : "Upload failed",
    });
    return;
  }
  job.abort = null;
  if (job.cancelled) {
    // The bytes landed after the caller gave up on them.
    return;
  }
  setUploadState(job.attachment.id, { status: "ready", attachmentId });
  stampDraftFileUpload(job.attachment, attachmentId);
}

function pumpUploads(): void {
  while (queue.length > 0 && activeUploads < MAX_CONCURRENT_UPLOADS) {
    const job = queue.shift()!;
    if (job.cancelled) {
      continue;
    }
    activeUploads += 1;
    void runUpload(job)
      .catch(() => {
        if (!job.cancelled) {
          setUploadState(job.attachment.id, { status: "failed", reason: "Upload failed" });
        }
      })
      .finally(() => {
        if (
          jobsByAttachmentId.get(job.attachment.id) === job &&
          readAttachmentUpload(job.attachment.id)?.status !== "failed"
        ) {
          job.stopWatchingReachable();
          jobsByAttachmentId.delete(job.attachment.id);
        }
        activeUploads -= 1;
        job.resolveSettled();
        pumpUploads();
      });
  }
}

export function startAttachmentUpload(attachment: ComposerAttachment): void {
  if (jobsByAttachmentId.has(attachment.id)) {
    return;
  }
  const existing = readAttachmentUpload(attachment.id);
  if (existing?.status === "ready") stampDraftFileUpload(attachment, existing.attachmentId);
  if (existing?.status === "ready" || existing?.status === "failed") {
    return;
  }

  let resolveSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const job: UploadJob = {
    attachment,
    ...(attachment.type === "file" && attachment.uploadedAttachmentId
      ? { persistedAttachmentId: attachment.uploadedAttachmentId }
      : {}),
    settled,
    resolveSettled,
    cancelled: false,
    abort: null,
    stopWatchingReachable: () => {},
  };

  jobsByAttachmentId.set(attachment.id, job);
  const isReachable = () => appAtomRegistry.get(reachableAtom);
  let wasReachable = isReachable();
  job.stopWatchingReachable = appAtomRegistry.subscribe(reachableAtom, () => {
    const reachable = isReachable();
    const recovered = reachable && !wasReachable;
    wasReachable = reachable;
    if (!recovered) return;
    // The upload's failure can arrive after the server is reachable again.
    // Wait for that attempt, then retry only if this job still owns the file.
    void job.settled.then(() => {
      if (
        jobsByAttachmentId.get(job.attachment.id) === job &&
        readAttachmentUpload(job.attachment.id)?.status === "failed" &&
        isReachable()
      ) {
        retryAttachmentUpload(attachment);
      }
    });
  });
  queue.push(job);
  setUploadState(attachment.id, { status: "uploading", progress: 0 });
  pumpUploads();
}

/** Stops the job. An upload that still lands waits on the server for its sweep. */
function cancelAttachmentUpload(id: string): void {
  const job = jobsByAttachmentId.get(id);
  if (!job) {
    return;
  }
  job.cancelled = true;
  job.stopWatchingReachable();
  jobsByAttachmentId.delete(id);
  const queuedIndex = queue.indexOf(job);
  if (queuedIndex !== -1) {
    queue.splice(queuedIndex, 1);
  }
  job.abort?.();
  job.resolveSettled();
}

export function releaseAttachmentUpload(id: string): void {
  cancelAttachmentUpload(id);
  clearUploadState(id);
}

/**
 * Starts the upload again. A hydrated file whose verification failed keeps
 * its server copy and verifies it again.
 */
export function retryAttachmentUpload(attachment: ComposerAttachment): void {
  cancelAttachmentUpload(attachment.id);
  clearUploadState(attachment.id);
  startAttachmentUpload(attachment);
}

export async function awaitAttachmentUploads(ids: ReadonlyArray<string>): Promise<void> {
  await Promise.all(ids.map((id) => jobsByAttachmentId.get(id)?.settled));
}

export function getUploadedAttachments(
  draftAttachments: ReadonlyArray<ComposerAttachment>,
): ChatAttachment[] | null {
  const attachments: ChatAttachment[] = [];
  for (const attachment of draftAttachments) {
    const upload = readAttachmentUpload(attachment.id);
    if (upload?.status !== "ready") {
      return null;
    }
    attachments.push({
      type: attachment.type,
      id: upload.attachmentId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      ...(attachment.type === "file" && attachment.source ? { source: attachment.source } : {}),
    });
  }
  return attachments;
}

export function releaseDraftAttachments(attachments: ReadonlyArray<ComposerAttachment>): void {
  for (const attachment of attachments) {
    releaseAttachmentUpload(attachment.id);
  }
}

export function releaseComposerDraftUploads(target: ComposerTarget): void {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  if (draft) {
    releaseDraftAttachments([...draft.images, ...draft.files]);
  }
}
