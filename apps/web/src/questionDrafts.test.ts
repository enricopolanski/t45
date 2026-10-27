import { beforeEach, expect, it, vi } from "vite-plus/test";
import { changeCompressingImages, useCompressingImages } from "./compressingImages";
import { useComposerDraftStore } from "./composerDraftStore";
import {
  clearQuestionDrafts,
  countQuestionAttachments,
  questionDraftKey,
  updateQuestionAnswer,
  useQuestionAnswers,
} from "./questionDrafts";
import { testChatId } from "./state/chats.testkit";

const release = vi.hoisted(() => vi.fn());
vi.mock("./lib/attachmentUploadQueue", () => ({ releaseComposerDraftUploads: release }));
const chatId = testChatId(1);
const requestId = "request-1";
const specFile = (id: string) => ({
  type: "file" as const,
  id,
  name: `${id}.txt`,
  mimeType: "text/plain",
  sizeBytes: 4,
  file: new File(["spec"], `${id}.txt`, { type: "text/plain" }),
});
beforeEach(() => {
  useComposerDraftStore.setState({ draftsByTarget: {} });
  useCompressingImages.setState({ counts: {} });
  useQuestionAnswers.setState({ answers: {} });
  release.mockClear();
});
it("keeps question files separate from the normal draft and releases those no longer asked", () => {
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const store = useComposerDraftStore.getState();
  const first = questionDraftKey(chatId, requestId, "first");
  const second = questionDraftKey(chatId, requestId, "second");
  store.setPrompt(chatId, "Unsent prompt");
  const image = {
    type: "image" as const,
    id: "image-1",
    name: "image.png",
    mimeType: "image/png",
    sizeBytes: 5,
    previewUrl: "blob:question-image",
    file: new File(["image"], "image.png", { type: "image/png" }),
  };
  store.addImages(first, [image]);
  store.addFiles(second, [specFile("file-1")]);
  changeCompressingImages(first, 1);
  clearQuestionDrafts(chatId, new Set([second]));
  expect(store.getComposerDraft(first)).toBeNull();
  expect(store.getComposerDraft(second)?.files).toHaveLength(1);
  expect(store.getComposerDraft(chatId)?.prompt).toBe("Unsent prompt");
  expect(useCompressingImages.getState().counts[first]).toBeUndefined();
  expect(release).toHaveBeenCalledWith(first);
  expect(revoke).toHaveBeenCalledWith(image.previewUrl);
  revoke.mockRestore();
});
it("leaves the question drafts of other chats", () => {
  const store = useComposerDraftStore.getState();
  const others = [testChatId(2), testChatId(10)].map((other) =>
    questionDraftKey(other, requestId, "q"),
  );
  for (const key of others) store.addFiles(key, [specFile("file")]);
  clearQuestionDrafts(chatId);
  for (const key of others) expect(store.getComposerDraft(key)?.files).toHaveLength(1);
});

it("counts files, images, and compressing images across the shared question budget", () => {
  const first = questionDraftKey(chatId, requestId, "first");
  const second = questionDraftKey(chatId, requestId, "second");
  const other = questionDraftKey(testChatId(2), requestId, "first");
  const store = useComposerDraftStore.getState();
  store.addFiles(
    second,
    Array.from({ length: 6 }, (_, index) => specFile(`spec-${index}`)),
  );
  store.addImages(first, [
    {
      type: "image",
      id: "image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 5,
      previewUrl: "blob:count-test",
      file: new File(["image"], "image.png"),
    },
  ]);
  changeCompressingImages(second, 1);
  changeCompressingImages(other, 8);
  expect(countQuestionAttachments([first, second])).toBe(8);
  expect(countQuestionAttachments([second])).toBe(7);
  changeCompressingImages(second, -1);
  expect(countQuestionAttachments([first, second])).toBe(7);
});

it("releases a question's answers with its files once it is no longer asked", () => {
  const asked = questionDraftKey(chatId, requestId, "asked");
  const gone = questionDraftKey(chatId, "request-2", "gone");
  updateQuestionAnswer(asked, () => ({ customAnswer: "keep" }));
  updateQuestionAnswer(gone, () => ({ selectedOptionValues: ["a"] }));
  clearQuestionDrafts(chatId, new Set([asked]));
  expect(useQuestionAnswers.getState().answers).toEqual({ [asked]: { customAnswer: "keep" } });
});

it("restores stored answers on reload and drops a malformed store", async () => {
  const key = questionDraftKey(chatId, requestId, "q");
  const { name, storage } = useQuestionAnswers.persist.getOptions();
  await storage?.setItem(name!, {
    state: { answers: { [key]: { selectedOptionValues: ["b"] } } },
    version: 0,
  });
  await useQuestionAnswers.persist.rehydrate();
  expect(useQuestionAnswers.getState().answers).toEqual({ [key]: { selectedOptionValues: ["b"] } });

  useQuestionAnswers.setState({ answers: {} });
  await storage?.setItem(name!, { state: { answers: { [key]: { customAnswer: 3 } } }, version: 0 });
  await useQuestionAnswers.persist.rehydrate();
  expect(useQuestionAnswers.getState().answers).toEqual({});
});
