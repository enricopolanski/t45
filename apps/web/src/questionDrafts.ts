import type { ChatId } from "@t45/contracts/models/Chat";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  compressingImageCount,
  forgetCompressingImages,
  useCompressingImages,
} from "./compressingImages";
import { useComposerDraftStore } from "./composerDraftStore";
import { releaseComposerDraftUploads } from "./lib/attachmentUploadQueue";
import { browserStorage } from "./lib/storage";

const chatPrefix = (chatId: ChatId) => `question-${chatId}-`;

/**
 * The composer draft holding the files for one field of an agent's question, apart from the
 * chat's own draft and the question's other fields, and the key of that field's answer.
 */
export const QuestionDraftKey = Schema.String.pipe(Schema.brand("QuestionDraftKey"));
export type QuestionDraftKey = typeof QuestionDraftKey.Type;

export function questionDraftKey(
  chatId: ChatId,
  questionKey: string,
  fieldKey: string,
): QuestionDraftKey {
  return QuestionDraftKey.make(`${chatPrefix(chatId)}${JSON.stringify([questionKey, fieldKey])}`);
}

/** What the member picked or typed for one field. */
const QuestionAnswer = Schema.Struct({
  selectedOptionValues: Schema.optionalKey(Schema.Array(Schema.String)),
  customAnswer: Schema.optionalKey(Schema.String),
});
export type QuestionAnswer = typeof QuestionAnswer.Type;

const decodeStoredAnswers = Schema.decodeUnknownOption(
  Schema.Struct({ answers: Schema.Record(Schema.String, QuestionAnswer) }),
);

/**
 * Answers in progress by their field's draft key, kept across chat switches and reloads like the
 * field's files, and released with them.
 */
export const useQuestionAnswers = create<{ answers: Record<string, QuestionAnswer> }>()(
  persist(() => ({ answers: {} }), {
    name: "t45:question-answers:v1",
    storage: createJSONStorage(browserStorage),
    // A malformed stored value is dropped, not repaired.
    merge: (persisted, current) => ({
      ...current,
      ...Option.getOrUndefined(decodeStoredAnswers(persisted)),
    }),
  }),
);

export function updateQuestionAnswer(
  key: QuestionDraftKey,
  update: (answer: QuestionAnswer | undefined) => QuestionAnswer,
) {
  useQuestionAnswers.setState(({ answers }) => ({
    answers: { ...answers, [key]: update(answers[key]) },
  }));
}

/** Staged files plus images still compressing, against the limit a question's fields share. */
export function countQuestionAttachments(keys: ReadonlyArray<QuestionDraftKey>): number {
  const store = useComposerDraftStore.getState();
  return keys.reduce((total, key) => {
    const draft = store.getComposerDraft(key);
    return (
      total + (draft?.images.length ?? 0) + (draft?.files.length ?? 0) + compressingImageCount(key)
    );
  }, 0);
}

/** Releases a chat's question drafts and answers, except those of questions still asked. */
export function clearQuestionDrafts(chatId: ChatId, asked: ReadonlySet<string> = new Set()) {
  const prefix = chatPrefix(chatId);
  const store = useComposerDraftStore.getState();
  const { answers } = useQuestionAnswers.getState();
  const keys = new Set([
    ...Object.keys(store.draftsByTarget),
    ...Object.keys(useCompressingImages.getState().counts),
    ...Object.keys(answers),
  ]);
  const released = new Set([...keys].filter((key) => key.startsWith(prefix) && !asked.has(key)));
  for (const key of released) {
    const draftKey = QuestionDraftKey.make(key);
    for (const image of store.getComposerDraft(draftKey)?.images ?? []) {
      if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
    }
    releaseComposerDraftUploads(draftKey);
    store.clearComposerContent(draftKey);
    forgetCompressingImages(key);
  }
  if ([...released].some((key) => key in answers)) {
    useQuestionAnswers.setState(({ answers: current }) => ({
      answers: Object.fromEntries(Object.entries(current).filter(([key]) => !released.has(key))),
    }));
  }
}

export function forgetChatDrafts(chatId: ChatId) {
  releaseComposerDraftUploads(chatId);
  useComposerDraftStore.getState().clearDraft(chatId);
  clearQuestionDrafts(chatId);
}
