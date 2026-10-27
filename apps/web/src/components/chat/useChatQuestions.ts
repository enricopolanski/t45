import { type ChatAttachment } from "@t45/contracts/models/Attachment";
import { type ChatId } from "@t45/contracts/models/Chat";
import type { Question } from "@t45/contracts/resources/Chats";
import { type RefObject, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { compressingImageCount, useCompressingImages } from "../../compressingImages";
import { type ComposerTarget, useComposerDraftStore } from "../../composerDraftStore";
import { getUploadedAttachments, useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import {
  clearQuestionDrafts,
  questionDraftKey,
  updateQuestionAnswer,
  useQuestionAnswers,
} from "../../questionDrafts";
import { api } from "../../rpc/api";
import { toastFailure } from "../../state/query";
import { toastManager } from "../ui/toast";
import type { ChatComposerHandle } from "./ChatComposer";
import {
  carryDisplacedCustomAnswerIntoPrompt,
  deriveAskedQuestions,
  deriveQuestionProgress,
  formAnswerFromDrafts,
  formAttachments,
  questionKey,
  toggleOption,
  typeAnswer,
  type FieldDraft,
} from "./chatQuestions";

const NO_FIELD_DRAFTS: Record<string, FieldDraft> = {};

/** The question the agent is waiting on, answered in the composer in place of a message. */
export type ComposerQuestion = NonNullable<ReturnType<typeof useChatQuestions>>;

export function useChatQuestions({
  chatId,
  questions,
  readOnly,
  composerDraftTarget,
  composerRef,
  promptRef,
}: {
  readonly chatId: ChatId;
  readonly questions: ReadonlyArray<Question> | undefined;
  readonly readOnly: boolean;
  readonly composerDraftTarget: ComposerTarget;
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly promptRef: RefObject<string>;
}) {
  const [fieldIndexByQuestion, setFieldIndexByQuestion] = useState<Record<string, number>>({});
  // Answered, a question stays busy until it leaves the chat's questions, so it can't be sent twice.
  const [respondingKey, setRespondingKey] = useState<string | null>(null);
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const questionAnswers = useQuestionAnswers((state) => state.answers);
  // Every field of a question still asked keeps its draft, even one its conditions hide now.
  const askedDraftKeys = new Set(
    (questions ?? []).flatMap((question) =>
      question.form.fields.map((field) =>
        questionDraftKey(chatId, questionKey(question), field.key),
      ),
    ),
  );
  const fieldDraftsByQuestion = Object.fromEntries(
    (questions ?? []).map((question) => {
      const key = questionKey(question);
      const drafts = question.form.fields.flatMap((field) => {
        const answer = questionAnswers[questionDraftKey(chatId, key, field.key)];
        return answer ? [[field.key, answer] as const] : [];
      });
      return [key, Object.fromEntries(drafts)];
    }),
  );
  const askedQuestions =
    readOnly || !questions ? [] : deriveAskedQuestions(questions, fieldDraftsByQuestion);
  const asked = askedQuestions[0] ?? null;
  const questionDraftKeys = askedQuestions.flatMap((question) =>
    question.fields.map((field) => questionDraftKey(chatId, question.key, field.key)),
  );
  const questionComposerDrafts = useComposerDraftStore(
    useShallow((state) =>
      Object.fromEntries(questionDraftKeys.map((key) => [key, state.draftsByTarget[key]])),
    ),
  );
  const questionUploadsBlocked = useAttachmentUploadStore(
    useShallow((state) =>
      Object.fromEntries(
        questionDraftKeys.map((key) => {
          const draft = questionComposerDrafts[key];
          const attachments = draft ? [...draft.images, ...draft.files] : [];
          return [
            key,
            attachments.some(
              (attachment) => state.uploadsByAttachmentId[attachment.id]?.status !== "ready",
            ),
          ];
        }),
      ),
    ),
  );
  const questionCompressingImages = useCompressingImages(
    useShallow((state) =>
      Object.fromEntries(questionDraftKeys.map((key) => [key, state.counts[key] ?? 0])),
    ),
  );
  // Answers and files staged for a question that is no longer asked are released.
  useEffect(() => {
    if (questions) clearQuestionDrafts(chatId, askedDraftKeys);
  }, [askedDraftKeys, questions, chatId]);
  const activeFieldDrafts = asked
    ? Object.fromEntries(
        asked.fields.map((field) => {
          const key = questionDraftKey(chatId, asked.key, field.key);
          const draft = questionComposerDrafts[key];
          return [
            field.key,
            {
              ...questionAnswers[key],
              attachmentCount: draft ? draft.images.length + draft.files.length : 0,
              attachmentsBlocked:
                (questionCompressingImages[key] ?? 0) > 0 || questionUploadsBlocked[key] === true,
            },
          ];
        }),
      )
    : NO_FIELD_DRAFTS;
  const progress = asked
    ? deriveQuestionProgress(asked, activeFieldDrafts, fieldIndexByQuestion[asked.key] ?? 0)
    : null;

  const respond = async () => {
    const request = asked;
    if (!request || !request.answerable || respondingKey === request.key) return;
    const answer = formAnswerFromDrafts(request.question.form, activeFieldDrafts);
    if (answer._tag === "invalid") {
      toastManager.add({ type: "error", title: answer.message });
      return;
    }
    const attachmentsByField = new Map<string, ReadonlyArray<ChatAttachment>>();
    for (const field of request.fields) {
      const target = questionDraftKey(chatId, request.key, field.key);
      if (compressingImageCount(target) > 0) return;
      const draft = useComposerDraftStore.getState().getComposerDraft(target);
      const attachments = draft ? [...draft.images, ...draft.files] : [];
      if (attachments.length === 0) continue;
      const uploaded = getUploadedAttachments(attachments);
      if (!uploaded) {
        toastManager.add({
          type: "error",
          title: "Wait for attachments to finish uploading, or remove failed uploads.",
        });
        return;
      }
      attachmentsByField.set(field.key, uploaded);
    }
    setRespondingKey(request.key);
    try {
      await api("chats.answer", {
        chatId,
        sessionId: request.question.sessionId,
        formId: request.question.form.id,
        answers: answer.answers,
        attachments: formAttachments(request.question.form, attachmentsByField),
      });
    } catch (error) {
      setRespondingKey(null);
      toastFailure("Couldn't send the answer", error);
    }
  };
  const onDismiss = async () => {
    const request = asked;
    if (!request || respondingKey === request.key) return;
    setRespondingKey(request.key);
    try {
      await api("chats.dismiss", {
        chatId,
        sessionId: request.question.sessionId,
        formId: request.question.form.id,
      });
    } catch (error) {
      setRespondingKey(null);
      toastFailure("Couldn't dismiss the question", error);
    }
  };
  const setFieldIndex = (index: number) => {
    if (!asked) return;
    const { key } = asked;
    setFieldIndexByQuestion((current) => ({ ...current, [key]: index }));
  };
  const onToggleOption = (fieldKey: string, optionValue: string) => {
    if (!asked) return;
    const key = questionDraftKey(chatId, asked.key, fieldKey);
    // The option replaces the custom answer; what was typed there goes back to the draft.
    const displaced = useQuestionAnswers.getState().answers[key]?.customAnswer;
    const currentPrompt =
      useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.prompt ?? "";
    const nextPrompt = carryDisplacedCustomAnswerIntoPrompt(currentPrompt, displaced);
    if (nextPrompt !== currentPrompt) setComposerDraftPrompt(composerDraftTarget, nextPrompt);
    const field = asked.fields.find((entry) => entry.key === fieldKey);
    if (!field) return;
    updateQuestionAnswer(key, (current) => toggleOption(field, current, optionValue));
    promptRef.current = "";
    composerRef.current?.resetCursorState();
  };
  const onTypeAnswer = (
    fieldKey: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
  ) => {
    if (!asked) return;
    const field = asked.fields.find((entry) => entry.key === fieldKey);
    if (!field?.allowCustomAnswer) return;
    promptRef.current = value;
    updateQuestionAnswer(questionDraftKey(chatId, asked.key, fieldKey), (current) =>
      typeAnswer(current, value),
    );
    const snapshot = composerRef.current?.readSnapshot();
    if (
      snapshot?.value !== value ||
      snapshot.cursor !== nextCursor ||
      snapshot.expandedCursor !== expandedCursor
    ) {
      composerRef.current?.focusAt(nextCursor);
    }
  };
  const onAdvance = () => {
    if (!progress || progress.blockedReason !== null) return;
    if (progress.isLastField) {
      void respond();
      return;
    }
    setFieldIndex(progress.fieldIndex + 1);
  };
  const onPreviousField = () => {
    if (!progress) return;
    setFieldIndex(Math.max(progress.fieldIndex - 1, 0));
  };

  return asked && progress
    ? {
        asked,
        progress,
        /** The answer is being sent, or the question can only be dismissed. */
        responding: !asked.answerable || respondingKey === asked.key,
        onToggleOption,
        onTypeAnswer,
        onAdvance,
        onDismiss,
        onPreviousField,
      }
    : null;
}
