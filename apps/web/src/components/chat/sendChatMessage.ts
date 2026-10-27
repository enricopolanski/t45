import type { Agent } from "@t45/contracts/models/Agent";
import type { ChatId } from "@t45/contracts/models/Chat";

import { type ComposerAttachment, useComposerDraftStore } from "../../composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { buildMessageContext } from "../../lib/composerContextReferences";
import { api } from "../../rpc/api";
import { chatErrorReason, chatSessionKey, chats } from "../../state/chats";
import { toastFailure } from "../../state/query";
import { toastManager } from "../ui/toast";

export const sendsInFlight = new Set<ChatId>();

export async function sendChatMessage(send: {
  readonly chatId: ChatId;
  readonly agentId: Agent["id"] | null;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<ComposerAttachment>;
  readonly setBusy: (busy: boolean) => void;
  readonly isOpen: () => boolean;
  readonly clearComposer: () => void;
  readonly scrollToEnd: () => void;
}) {
  const { chatId, attachments } = send;
  const inputId = useComposerDraftStore.getState().claimInputId(chatId);
  sendsInFlight.add(chatId);
  send.setBusy(true);
  try {
    for (const attachment of attachments) startAttachmentUpload(attachment);
    await awaitAttachmentUploads(attachments.map((attachment) => attachment.id));
    const uploaded = getUploadedAttachments(attachments);
    if (uploaded === null) {
      toastManager.add({ type: "error", title: "Retry or remove failed uploads before sending." });
      return;
    }
    const context = buildMessageContext(
      attachments.map((attachment, index) => ({
        attachment,
        attachmentId: uploaded[index]?.id ?? attachment.id,
      })),
    );
    try {
      await api("chats.send", {
        chatId,
        ...(send.agentId === null ? {} : { agentId: send.agentId }),
        inputId,
        text: send.prompt.trim(),
        attachments: uploaded,
        ...(context === undefined ? {} : { context }),
      });
    } catch (error) {
      if (chatErrorReason(error) === "input_conflict") {
        useComposerDraftStore.getState().forgetInputId(chatId, inputId);
      }
      throw error;
    }
    if (send.agentId !== null) chats.reopen(chatSessionKey(chatId));
    if (useComposerDraftStore.getState().clearSentContent(chatId, inputId)) {
      releaseDraftAttachments(attachments);
      send.clearComposer();
    }
    if (send.isOpen()) send.scrollToEnd();
  } catch (error) {
    toastFailure("Couldn't send the message", error);
  } finally {
    sendsInFlight.delete(chatId);
    send.setBusy(false);
  }
}
