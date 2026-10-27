import { formatComposerContextReference } from "@t45/core/composerContextReferences";
import { questionDraftKey, countQuestionAttachments } from "../../questionDrafts";
import {
  changeCompressingImages,
  compressingImageCount,
  useCompressingImages,
} from "../../compressingImages";
import {
  MESSAGE_MAX_ATTACHMENTS,
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_IMAGE_BYTES,
  type ChatFileAttachment,
} from "@t45/contracts/models/Attachment";
import { type ChatId, MESSAGE_MAX_INPUT_CHARS } from "@t45/contracts/models/Chat";
import { useAtomValue } from "@effect/atom-react";
import {
  memo,
  type ReactNode,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildComposerPromptHistoryEntries,
  type ComposerCommandItem,
  type ComposerPromptHistoryMessage,
  collapseExpandedComposerCursor,
  type ComposerPromptHistoryPosition,
  composerStateAtPromptEnd,
  composerSubmitsOnKey,
  continueListOnEnter,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  getComposerPromptLengthValidationMessage,
  indentListOnTab,
  replaceTextRange,
  searchSlashCommandItems,
  stepComposerPromptHistory,
} from "../../composerPrompt";
import {
  classifyComposerAttachmentFile,
  formatAttachmentSize,
  normalizeComposerImageFileMimeType,
  shouldHandleComposerAttachmentPaste,
} from "../../lib/attachmentFiles";
import {
  createComposerScrollGestureState,
  isInsideCollapsedComposerControls,
  isInsideRestingComposerControlScope,
  keepComposerFocus,
  recordComposerScrollGestureEvent,
  resetComposerScrollGesture,
  shouldCollapseComposerForScrollKey,
  suppressActiveComposerScrollGesture,
} from "./composerLayout";
import {
  type ComposerAttachment,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  composerFileMatchesReattachMarker,
  composerFileNeedsReattach,
  useComposerDraft,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useComposerTriggerState } from "./useComposerTriggerState";
import {
  isPasteAsTextShortcut,
  nextPastedTextFileName,
  shouldAttachPastedText,
  wouldTextPasteExceedLimit,
} from "./textPaste";
import { useComposerMultilinePrompt } from "./useComposerMultilinePrompt";
import { ComposerLoadingBanner } from "./ComposerLoadingBanner";
import { ComposerBanner } from "./ComposerBanner";
import { ConnectionNotice } from "./ConnectionNotice";
import { prepareImageForAttachment } from "../../lib/imageCompression";
import {
  releaseAttachmentUpload,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import {
  attachmentUploadBlockReason,
  formatAttachmentUploadProgress,
} from "../../lib/attachmentUploadState";
import {
  type ComposerPromptEditorHandle,
  ComposerPromptEditor,
  type ComposerPromptSnapshot,
} from "../ComposerPromptEditor";
import { ComposerChipsContext, composerContextRecordsFromDraft } from "../ComposerContextChip";
import {
  attachmentContextReference,
  collectInlineContextIds,
  type ComposerContextReference,
  contextIdFor,
  ensureInlineContextReferences,
  inlineContextReferenceReplacement,
  inlineContextReferencesToLabels,
  reconcileAttachmentContextReferences,
  stripInlineContextReferences,
} from "~/lib/composerContextReferences";

import { ComposerCommandMenu, composerSuggestionOptionId } from "./ComposerCommandMenu";
import { ComposerImageThumbnail } from "./ComposerImageThumbnail";
import { ComposerQuestionActions, ComposerSendActions } from "./ComposerPrimaryActions";
import { ComposerQuestionPanel } from "./ComposerQuestionPanel";
import type { ImageGallery } from "./ExpandedImageDialog";
import { cn, isMacPlatform, randomUUID } from "~/lib/utils";
import { isTimelineScrollTarget } from "./timelineScrollTarget";
import { reachableAtom } from "../../rpc/api";
import {
  AlertDialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { ErrorText } from "../ui/error-text";
import {
  CircleAlertIcon,
  FileIcon,
  ImageIcon,
  PaperclipIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import type { ComposerQuestion } from "./useChatQuestions";
import { useFlickerFree } from "../../hooks/useFlickerFree";
import { useMediaQuery } from "../../hooks/useMediaQuery";

const COMPOSER_SCROLL_COLLAPSE_THRESHOLD_PX = 24;
const COMPOSER_SCROLL_GESTURE_RESET_MS = 120;

const NEW_CHAT_COMMAND = {
  command: "new",
  description: "Start a new chat",
} satisfies ComposerCommandItem;

const COMPACT_COMMAND = {
  command: "compact",
  description: "Summarize the conversation to free up context",
} satisfies ComposerCommandItem;

function RetryUploadButton(props: {
  variant: "overlay" | "ghost";
  attachment: ComposerAttachment;
  reason: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={props.variant}
            size="icon-xs"
            onClick={() => retryAttachmentUpload(props.attachment)}
            aria-label={`Retry upload for ${props.attachment.name}`}
          />
        }
      >
        <RefreshCwIcon />
      </TooltipTrigger>
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

export interface ChatComposerHandle {
  focusAtEnd: () => void;
  focusAt: (cursor: number) => void;
  /** Expand the desktop composer at the timeline end without taking focus. */
  restoreAfterTimelineReachedEnd: () => void;
  collapseForTimelineScrollKey: (key: string) => void;
  addDroppedFiles: (files: File[]) => void;
  /** Insert typed or pasted plain text; context links in it land as their labels. */
  insertTextAtEnd: (text: string) => boolean;
  /** Apply large-paste folding for text redirected from a blurred composer. */
  pasteTextAtEnd: (text: string) => boolean;
  readSnapshot: () => { value: string; cursor: number; expandedCursor: number };
  /** Put the caret at the start and close the menu after the chat view replaced the prompt. */
  resetCursorState: () => void;
}

export interface ChatComposerProps {
  chatId: ChatId;
  /** The member's sent messages, oldest first, for ArrowUp prompt recall. */
  promptHistoryMessages: ReadonlyArray<ComposerPromptHistoryMessage>;
  forceExpandedOnMobile: boolean;
  /** The agent is running: a send queues behind it. */
  running: boolean;
  /** Stop is offered: a run is preparing, starting, or running. */
  canInterrupt: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  question: ComposerQuestion | null;
  /** The chat's messages are loading. */
  loadingMessages: boolean;
  compactDisabled: boolean;
  getTimelineScrollableNode: () => HTMLElement | null;
  isTimelineAtLogicalEnd: () => boolean;
  /** Whether the timeline has more content than fits above the composer. */
  timelineOverflows: boolean;
  /**
   * The composer's layout, reported from a layout effect so the chat view re-measures the
   * overlay before the frame paints.
   */
  onLayoutChange: (layout: ComposerLayout) => void;
  /** The prompt as typed, which the chat view reads and clears when it sends. */
  promptRef: React.RefObject<string>;
  ref: React.Ref<ChatComposerHandle>;
  onPageScrollKeyDown: (key: "PageUp" | "PageDown", repeat: boolean) => void;
  /** The strip of inputs waiting their turn, above the composer. */
  queueBanner?: ReactNode;
  onCompactContext: () => void;
  onSend: (e?: { preventDefault: () => void }) => boolean;
  onStartNewChat: () => void;
  onInterrupt: () => void;
  onImageExpand: (gallery: ImageGallery) => void;
}

export type ComposerLayout = "open" | "collapsed" | "resting";

export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const {
    chatId,
    promptHistoryMessages,
    forceExpandedOnMobile,
    running,
    canInterrupt,
    isSendBusy,
    sendDisabledReason: externalSendDisabledReason,
    question,
    compactDisabled,
    getTimelineScrollableNode,
    isTimelineAtLogicalEnd,
    timelineOverflows,
    onLayoutChange,
    promptRef,
    ref,
    onPageScrollKeyDown,
    onCompactContext,
    onSend,
    onStartNewChat,
    onInterrupt,
    onImageExpand,
  } = props;
  // A chat that opens at once shows no loading row: only loading that lasts does.
  const showLoading = useFlickerFree(props.loadingMessages, chatId);
  const composerDraft = useComposerDraft(chatId);
  // An answer's files go in the question's own draft, not the chat's.
  const questionDraftTarget = question?.progress.field
    ? questionDraftKey(chatId, question.asked.key, question.progress.field.key)
    : null;
  const attachmentDraftTarget = questionDraftTarget ?? chatId;
  const attachmentDraft = useComposerDraft(attachmentDraftTarget);
  const compressingImages = useCompressingImages(
    (state) => state.counts[attachmentDraftTarget] ?? 0,
  );
  const isServerUnreachable = !useAtomValue(reachableAtom);
  const prompt = composerDraft.prompt;
  // The editor shows a question's answer in place of the prompt.
  const editorValue = question ? question.progress.customAnswer : prompt;
  const composerImages = attachmentDraft.images;
  const composerFiles = attachmentDraft.files;
  // A question answer has no chips: its files live in the question draft and show in the
  // strip. Only the chat prompt's references decide which files leave the strip.
  const inlineContextIds = new Set(questionDraftTarget ? [] : collectInlineContextIds(prompt));
  const unreferencedFiles = composerFiles.filter(
    (file) => !inlineContextIds.has(contextIdFor("file", file.id)),
  );

  const uploadsByAttachmentId = useAttachmentUploadStore((state) => state.uploadsByAttachmentId);
  const expandImage = (imageId: string) => {
    const index = composerImages.findIndex((image) => image.id === imageId);
    if (index < 0) return;
    const images = composerImages.map((image) => ({ src: image.previewUrl, name: image.name }));
    onImageExpand({ images, index });
  };
  const composerContextRecords = useMemo(
    () =>
      composerContextRecordsFromDraft({
        images: composerImages,
        files: composerFiles,
        uploadsByAttachmentId,
      }),
    [composerFiles, composerImages, uploadsByAttachmentId],
  );
  const attachmentBlockReason = attachmentUploadBlockReason(
    [...composerImages, ...composerFiles],
    uploadsByAttachmentId,
  );
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const addComposerDraftFiles = useComposerDraftStore((store) => store.addFiles);
  const removeComposerDraftFile = useComposerDraftStore((store) => store.removeFile);

  useEffect(() => {
    for (const attachment of [...composerImages, ...composerFiles]) {
      // A needs-reattach file has no bytes to upload and no upload to verify.
      if (attachment.type === "file" && composerFileNeedsReattach(attachment)) continue;
      startAttachmentUpload(attachment);
    }
  }, [composerFiles, composerImages]);

  const sendDisabledReason = externalSendDisabledReason ?? attachmentBlockReason;
  const isSendDisabled = sendDisabledReason !== null;

  // A chat switch starts the composer's transient state over.
  const [composerSession, setComposerSession] = useState(chatId);
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const {
    trigger: composerTrigger,
    setTrigger: setComposerTrigger,
    resolveTrigger: resolveComposerTrigger,
    dismissTrigger: dismissComposerTrigger,
    resetTrigger: resetComposerTrigger,
  } = useComposerTriggerState(() => detectComposerTrigger(prompt, prompt.length));
  // The highlighted command holds only while the query it was highlighted under does.
  const [menuHighlight, setMenuHighlight] = useState<{
    readonly command: ComposerCommandItem["command"] | null;
    readonly query: string | null;
  } | null>(null);
  const composerSuggestionListId = useId();
  // Active ArrowUp recall. Cleared on edit and on chat switch.
  const [promptHistoryPosition, setPromptHistoryPosition] =
    useState<ComposerPromptHistoryPosition | null>(null);
  const isMobileViewport = useMediaQuery("max-sm");
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [isComposerScrollCollapsed, setIsComposerScrollCollapsed] = useState(false);
  const [composerSubmissionError, setComposerSubmissionError] = useState<string | null>(null);
  const [pendingImageRemoval, setPendingImageRemoval] = useState<string | null>(null);
  const pendingImageName =
    composerImages.find((image) => image.id === pendingImageRemoval)?.name ?? null;
  const [composerBody, setComposerBody] = useState<HTMLDivElement | null>(null);
  const hasWrappedPrompt = useComposerMultilinePrompt(composerBody);
  const hasMultilinePrompt = editorValue.includes("\n") || hasWrappedPrompt;
  const isComposerCollapsedMobile =
    isMobileViewport && !forceExpandedOnMobile && !isComposerFocused && !hasMultilinePrompt;

  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const pasteAsTextShortcutArmedRef = useRef(false);
  const pastedTextFileNamesRef = useRef({ targetKey: "", names: new Set<string>() });
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerSelectLockRef = useRef(false);
  const composerBlurFrameRef = useRef<number | null>(null);
  const mobileComposerExpandFrameRef = useRef<number | null>(null);
  const mobileComposerExpandReleaseFrameRef = useRef<number | null>(null);
  const mobileComposerExpandInFlightRef = useRef(false);
  const composerScrollCollapseTimeoutRef = useRef<number | null>(null);
  const composerScrollCollapseEligibleRef = useRef(false);
  const windowRefocusInFlightRef = useRef(false);
  const composerScrollGestureRef = useRef(createComposerScrollGestureState());

  useEffect(() => {
    let disarmTimer: ReturnType<typeof setTimeout> | undefined;
    const disarmPasteAsTextShortcut = () => {
      clearTimeout(disarmTimer);
      pasteAsTextShortcutArmedRef.current = false;
    };
    const armPasteAsTextShortcut = () => {
      // Browsers deliver keydown before the paste event. A short window
      // bridges the two without leaving later pastes in bypass mode.
      clearTimeout(disarmTimer);
      pasteAsTextShortcutArmedRef.current = true;
      disarmTimer = setTimeout(disarmPasteAsTextShortcut, 1_000);
    };
    // Armed from anywhere on the page: ChatView routes a paste with nothing
    // focused to `pasteTextAtEnd`, which reads the same flag.
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !event.defaultPrevented &&
        isPasteAsTextShortcut(event, isMacPlatform(navigator.platform))
      ) {
        armPasteAsTextShortcut();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", disarmPasteAsTextShortcut);
    return () => {
      disarmPasteAsTextShortcut();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", disarmPasteAsTextShortcut);
    };
  }, []);

  const hasSendableContent =
    stripInlineContextReferences(prompt).trim().length > 0 ||
    composerImages.length + composerFiles.length > 0;

  const menuQuery = composerTrigger?.query.toLowerCase() ?? null;
  // /compact runs only on a prompt that is nothing but the command.
  const compactAvailable =
    composerTrigger !== null &&
    !compactDisabled &&
    prompt.slice(0, composerTrigger.rangeStart).trim() === "" &&
    prompt.slice(composerTrigger.rangeEnd).trim() === "" &&
    composerImages.length + composerFiles.length === 0 &&
    composerDraft.persistedImages.length === 0;
  const composerMenuItems: ComposerCommandItem[] =
    menuQuery === null
      ? []
      : searchSlashCommandItems(
          compactAvailable ? [NEW_CHAT_COMMAND, COMPACT_COMMAND] : [NEW_CHAT_COMMAND],
          menuQuery,
        );
  const composerMenuOpen = composerTrigger !== null;
  const highlightedCommand = menuHighlight?.query === menuQuery ? menuHighlight?.command : null;
  const activeComposerMenuItem =
    composerMenuItems.find((item) => item.command === highlightedCommand) ??
    composerMenuItems[0] ??
    null;

  const isChoiceOnlyField = question?.progress.field?.allowCustomAnswer === false;
  const showComposerAttachAction =
    !question || question.progress.field?.acceptsAttachments === true;
  const questionAction = question
    ? {
        fieldIndex: question.progress.fieldIndex,
        isLastField: question.progress.isLastField,
        isResponding: question.responding,
        blockedReason:
          attachmentBlockReason ??
          (compressingImages > 0 ? "Wait for images to finish compressing." : null) ??
          question.progress.blockedReason,
        onPreviousField: question.onPreviousField,
      }
    : null;
  // On a phone the question's actions sit inside the input, in place of the footer.
  const mobileQuestionAction =
    isMobileViewport && !isComposerCollapsedMobile ? questionAction : null;

  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt, promptRef]);

  // A shown length error follows the prompt: fixed, it goes; still too long, it updates.
  if (composerSubmissionError !== null) {
    const nextError = getComposerPromptLengthValidationMessage(prompt);
    if (nextError !== composerSubmissionError) setComposerSubmissionError(nextError);
  }

  // A closed menu forgets its highlight.
  if (!composerMenuOpen && menuHighlight !== null) setMenuHighlight(null);

  const lastSyncedFieldRef = useRef<{
    questionKey: string | null;
    fieldKey: string | null;
  } | null>(null);

  useEffect(() => {
    const nextCustomAnswer = question?.progress.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      // The question is gone and the editor shows the chat's draft again. The
      // ref still holds the last answer text, and Send reads the ref. Place
      // the caret at the end so the next keystroke appends.
      if (lastSyncedFieldRef.current !== null) {
        promptRef.current = prompt;
        const { cursor, trigger } = composerStateAtPromptEnd(prompt);
        setComposerCursor(cursor);
        resetComposerTrigger(trigger);
      }
      lastSyncedFieldRef.current = null;
      return;
    }

    const nextQuestionKey = question?.asked.key ?? null;
    const nextFieldKey = question?.progress.field?.key ?? null;
    const fieldChanged =
      lastSyncedFieldRef.current?.questionKey !== nextQuestionKey ||
      lastSyncedFieldRef.current?.fieldKey !== nextFieldKey;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;
    lastSyncedFieldRef.current = { questionKey: nextQuestionKey, fieldKey: nextFieldKey };
    if (!fieldChanged && !textChangedExternally) return;

    promptRef.current = nextCustomAnswer;
    const { cursor, trigger } = composerStateAtPromptEnd(nextCustomAnswer);
    setComposerCursor(cursor);
    resetComposerTrigger(trigger);
    setMenuHighlight(null);
  }, [
    question?.progress.customAnswer,
    question?.progress.field?.key,
    question?.asked.key,
    prompt,
    promptRef,
    resetComposerTrigger,
  ]);

  if (composerSession !== chatId) {
    const { cursor, trigger } = composerStateAtPromptEnd(prompt);
    setComposerSession(chatId);
    setMenuHighlight(null);
    setComposerSubmissionError(null);
    setComposerCursor(cursor);
    resetComposerTrigger(trigger);
    setPromptHistoryPosition(null);
    setIsComposerScrollCollapsed(false);
    setPendingImageRemoval(null);
  }

  const expandComposerForEditorChange = () => {
    // Editor changes win over the momentum tail of the active scroll gesture.
    suppressActiveComposerScrollGesture(
      composerScrollGestureRef.current,
      window.performance.now(),
      COMPOSER_SCROLL_GESTURE_RESET_MS,
    );
    setIsComposerScrollCollapsed(false);
  };

  /**
   * Files whose chips the chat's prompt no longer references. History undo restores the
   * reference text but knows nothing about the draft records behind it, so a delete keeps its
   * file here and an undo puts it back rather than leaving a dangling chip.
   */
  const removedFilesRef = useRef({
    targetKey: "",
    files: new Map<string, ComposerFileAttachment>(),
  });

  const onPromptChange = (
    { value: nextPrompt, cursor: nextCursor, expandedCursor, contextIds }: ComposerPromptSnapshot,
    cursorAdjacentToChip: boolean,
  ) => {
    expandComposerForEditorChange();
    const field = question?.progress.field;
    if (question && field) {
      if (!field.allowCustomAnswer) return;
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToChip ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
      question.onTypeAnswer(field.key, nextPrompt, nextCursor, expandedCursor);
      return;
    }
    promptRef.current = nextPrompt;
    setComposerDraftPrompt(chatId, nextPrompt);
    // Any edit ends browsing, even one later undone by hand: typing a
    // character and deleting it leaves the text equal to the recall, and
    // ArrowDown must move the caret then, not clear the composer.
    if (promptHistoryPosition?.recalled !== nextPrompt) setPromptHistoryPosition(null);
    if (removedFilesRef.current.targetKey !== chatId) {
      removedFilesRef.current = { targetKey: chatId, files: new Map() };
    }
    const attachmentChanges = reconcileAttachmentContextReferences({
      referencedContextIds: new Set(contextIds),
      files: composerFiles,
      retained: removedFilesRef.current.files,
    });
    for (const fileId of attachmentChanges.filesToRemove) {
      // The retained File and upload are still sendable if the editor restores the chip.
      removeComposerDraftFile(attachmentDraftTarget, fileId);
    }
    if (attachmentChanges.filesToRestore.length > 0) {
      addComposerDraftFiles(attachmentDraftTarget, attachmentChanges.filesToRestore);
    }
    setComposerCursor(nextCursor);
    setComposerTrigger(
      cursorAdjacentToChip ? null : detectComposerTrigger(nextPrompt, expandedCursor),
    );
  };

  const applyPromptReplacement = (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
    options?: {
      expectedText?: string;
      expandedCursorAfterReplace?: number;
      focusEditorAfterReplace?: boolean;
    },
  ) => {
    if (isChoiceOnlyField) return false;
    const currentText = promptRef.current;
    if (
      options?.expectedText !== undefined &&
      currentText.slice(rangeStart, rangeEnd) !== options.expectedText
    ) {
      return false;
    }
    const next = replaceTextRange(currentText, rangeStart, rangeEnd, replacement);
    const nextCursor = collapseExpandedComposerCursor(
      next.text,
      options?.expandedCursorAfterReplace ?? next.cursor,
    );
    const nextExpandedCursor = expandCollapsedComposerCursor(next.text, nextCursor);
    promptRef.current = next.text;
    const field = question?.progress.field;
    if (question && field) {
      question.onTypeAnswer(field.key, next.text, nextCursor, nextExpandedCursor);
    } else {
      setComposerDraftPrompt(chatId, next.text);
    }
    setComposerCursor(nextCursor);
    setComposerTrigger(detectComposerTrigger(next.text, nextExpandedCursor));
    if (options?.focusEditorAfterReplace !== false) {
      window.requestAnimationFrame(() => {
        // Type-to-focus routes only the first key through here; once the
        // controlled update focuses the editor, later keys land natively.
        // Skip the deferred caret placement when the draft has moved on,
        // or it drags the caret back behind what was typed since.
        if (promptRef.current !== next.text) return;
        composerEditorRef.current?.focusAt(nextCursor);
      });
    }
    return true;
  };

  const readComposerSnapshot = () =>
    composerEditorRef.current?.readSnapshot() ?? {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
    };

  const resolveActiveComposerTrigger = () => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: resolveComposerTrigger(
        detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
      ),
    };
  };

  const onSelectComposerItem = (item: ComposerCommandItem) => {
    // Enter and a click can land in the same frame; the command runs once.
    if (composerSelectLockRef.current) return;
    composerSelectLockRef.current = true;
    window.requestAnimationFrame(() => {
      composerSelectLockRef.current = false;
    });
    const { snapshot, trigger } = resolveActiveComposerTrigger();
    if (!trigger) return;
    const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
      expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
      focusEditorAfterReplace: false,
    });
    if (!applied) return;
    setMenuHighlight(null);
    if (item.command === "new") onStartNewChat();
    else onCompactContext();
  };

  const cancelComposerBlurFrame = () => {
    if (composerBlurFrameRef.current === null) return;
    window.cancelAnimationFrame(composerBlurFrameRef.current);
    composerBlurFrameRef.current = null;
  };

  const submitComposer = (event?: { preventDefault: () => void }) => {
    if (isSendDisabled) {
      event?.preventDefault();
      return;
    }
    // A send while a pasted image is still compressing would strand that
    // image: the turn snapshot wouldn't include it, and it would surface
    // in the *next* draft instead. Only oversized images hit this — small
    // files clear the compressing count within a microtask.
    if (compressingImageCount(attachmentDraftTarget) > 0) {
      event?.preventDefault();
      toastManager.add({
        type: "info",
        title: "Still compressing a pasted image.",
        description: "Send again once its thumbnail appears.",
      });
      return;
    }
    // An answer to an agent's question isn't a message, so the message limit doesn't apply.
    const validationMessage = question
      ? null
      : getComposerPromptLengthValidationMessage(promptRef.current);
    setComposerSubmissionError(validationMessage);
    if (validationMessage) {
      event?.preventDefault();
      return;
    }
    // A phone lowers its keyboard once something was really sent.
    if (!onSend(event) || !isMobileViewport) return;
    cancelComposerBlurFrame();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setIsComposerFocused(false);
  };

  const focusEditorAtEnd = () => composerEditorRef.current?.focusAtEnd();

  const expandMobileComposer = () => {
    cancelComposerBlurFrame();
    if (mobileComposerExpandFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
    }
    if (mobileComposerExpandReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
    }
    mobileComposerExpandInFlightRef.current = true;
    setIsComposerFocused(true);
    mobileComposerExpandFrameRef.current = window.requestAnimationFrame(() => {
      mobileComposerExpandFrameRef.current = null;
      focusEditorAtEnd();
      mobileComposerExpandReleaseFrameRef.current = window.requestAnimationFrame(() => {
        mobileComposerExpandReleaseFrameRef.current = null;
        mobileComposerExpandInFlightRef.current = false;
      });
    });
  };

  // ArrowUp and ArrowDown step through the member's earlier prompts.
  const navigatePromptHistory = (direction: "backward" | "forward", event: KeyboardEvent) => {
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
      return false;
    }
    if (question !== null) return false;
    // A composer holding an image or file is not empty. Recalling text into
    // it would send the old prompt with the new attachments, which is never
    // what ArrowUp meant.
    if (composerImages.length > 0 || composerFiles.length > 0) return false;
    const position = promptHistoryPosition;
    // A typed draft with no active recall can never step, so skip the
    // layout read and the entry build for that common case.
    if (position === null && promptRef.current.length > 0) return false;
    if (
      !composerEditorRef.current?.isCaretOnVisualEdge(direction === "backward" ? "start" : "end")
    ) {
      return false;
    }
    const step = stepComposerPromptHistory({
      direction,
      entries: buildComposerPromptHistoryEntries(promptHistoryMessages),
      position,
      currentPrompt: promptRef.current,
    });
    if (!step) return false;
    setPromptHistoryPosition(step.position);
    promptRef.current = step.prompt;
    setComposerDraftPrompt(chatId, step.prompt);
    setComposerCursor(collapseExpandedComposerCursor(step.prompt, step.prompt.length));
    setComposerTrigger(null);
    setMenuHighlight(null);
    return true;
  };

  const onComposerCommandKey = (event: KeyboardEvent, isTaskItem = false) => {
    const { key } = event;
    const submits = composerSubmitsOnKey({
      event,
      platform: navigator.platform,
      isMobileViewport,
    });

    const { trigger } = resolveActiveComposerTrigger();
    const menuIsActive = composerMenuOpen || trigger !== null;
    if (key === "Escape") {
      if (!menuIsActive || event.isComposing || event.keyCode === 229) return false;
      dismissComposerTrigger(trigger);
      return true;
    }
    if (menuIsActive) {
      const items = composerMenuItems;
      if ((key === "ArrowDown" || key === "ArrowUp") && items.length > 0) {
        const index = items.findIndex((item) => item.command === activeComposerMenuItem?.command);
        const offset = key === "ArrowDown" ? 1 : -1;
        const nextItem = items[(index + offset + items.length) % items.length];
        setMenuHighlight({ command: nextItem?.command ?? null, query: menuQuery });
        return true;
      }
      if ((key === "Enter" || key === "Tab") && activeComposerMenuItem) {
        onSelectComposerItem(activeComposerMenuItem);
        return true;
      }
    }
    if ((key === "ArrowUp" || key === "ArrowDown") && !submits) {
      return navigatePromptHistory(key === "ArrowUp" ? "backward" : "forward", event);
    }
    if (submits) {
      submitComposer();
      return true;
    }
    // Native task splitting preserves marks and chips on both sides of the caret.
    if (key === "Enter" && isTaskItem) return false;
    if (!event.isComposing && (key === "Enter" || (key === "Tab" && !event.shiftKey))) {
      const selection = composerEditorRef.current?.readSelectionRange();
      const snapshot = readComposerSnapshot();
      if (selection && selection.start === selection.end && snapshot.value === promptRef.current) {
        const edit =
          key === "Enter"
            ? continueListOnEnter(snapshot.value, selection.start)
            : indentListOnTab(snapshot.value, selection.start);
        if (
          edit &&
          applyPromptReplacement(
            edit.start,
            edit.end,
            edit.replacement,
            key === "Tab"
              ? { expandedCursorAfterReplace: selection.start + edit.replacement.length }
              : undefined,
          )
        ) {
          return true;
        }
      }
    }
    return false;
  };

  // A failed upload remains actionable in the expanded attachment tray, but
  // its collapsed thumbnail is enough to signal that the draft has images.
  const hasUnsavedImage = composerImages.some(
    (image) =>
      attachmentDraft.nonPersistedImageIds.includes(image.id) &&
      uploadsByAttachmentId[image.id]?.status !== "failed",
  );
  // Banners dock above the surface rather than inside it, so they do not hold
  // the composer open; only surface-internal chrome does.
  const composerHasExpandedChrome =
    question !== null ||
    composerMenuOpen ||
    isServerUnreachable ||
    composerSubmissionError !== null ||
    hasUnsavedImage;
  const canTrackComposerScrollGesture = !isMobileViewport;
  const canScrollCollapseComposer =
    canTrackComposerScrollGesture && !hasMultilinePrompt && !composerHasExpandedChrome;
  // A scroll-collapsed composer rests only while there is conversation behind it to read.
  const isComposerResting =
    canScrollCollapseComposer && isComposerScrollCollapsed && timelineOverflows;
  // Resting, or collapsed on a phone, the controls sit inside the input.
  const composerControlsCollapsed = isComposerResting || isComposerCollapsedMobile;
  useLayoutEffect(() => {
    onLayoutChange(
      isComposerResting ? "resting" : composerControlsCollapsed ? "collapsed" : "open",
    );
  }, [composerControlsCollapsed, isComposerResting, onLayoutChange]);
  const restingComposerImages = composerImages.slice(0, 3);
  const restingImageOverflowCount = composerImages.length - restingComposerImages.length;
  const collapsedComposerImagePreviews =
    restingComposerImages.length > 0 ? (
      <div
        data-chat-composer-resting-images="true"
        className="flex shrink-0 items-center gap-1 ps-1"
      >
        {restingComposerImages.map((image) => (
          <button
            key={image.id}
            type="button"
            className="relative size-7 shrink-0 cursor-zoom-in overflow-hidden rounded-md border border-border/70 bg-muted/60"
            aria-label={`Preview ${image.name}`}
            onPointerDown={keepComposerFocus}
            onClick={() => expandImage(image.id)}
          >
            <ComposerImageThumbnail
              file={image.file}
              alt=""
              className="size-full object-cover"
              fallback={<ImageIcon className="m-auto size-3.5 text-icon-muted" />}
            />
          </button>
        ))}
        {restingImageOverflowCount > 0 ? (
          <button
            type="button"
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/70 bg-muted/60 font-medium text-secondary-label text-xs tabular-nums outline-none hover:bg-muted focus-ring"
            aria-label={`Show ${String(restingImageOverflowCount)} more image attachments`}
            onPointerDown={keepComposerFocus}
            onClick={() => {
              if (isComposerCollapsedMobile) {
                expandMobileComposer();
                return;
              }
              setIsComposerScrollCollapsed(false);
              setIsComposerFocused(true);
              window.requestAnimationFrame(focusEditorAtEnd);
            }}
          >
            +{restingImageOverflowCount}
          </button>
        ) : null}
      </div>
    ) : null;
  // Scrolling only has something to collapse while the composer is expanded,
  // focused or not, so the wheel handler keys off the resting state rather
  // than editor focus.
  const composerScrollCollapseEligible = canScrollCollapseComposer && !isComposerResting;
  useLayoutEffect(() => {
    composerScrollCollapseEligibleRef.current = composerScrollCollapseEligible;
  });

  if (!canScrollCollapseComposer && isComposerScrollCollapsed) {
    setIsComposerScrollCollapsed(false);
  }

  // Returning to the window re-fires focus on the element that already held
  // it. That focus arrives after the window's own event, so a window focus
  // marks the frame in which it should be ignored by the form's capture.
  useEffect(() => {
    if (!isComposerScrollCollapsed) return;
    let frame: number | null = null;
    const onWindowFocus = () => {
      windowRefocusInFlightRef.current = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        windowRefocusInFlightRef.current = false;
      });
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      if (frame !== null) window.cancelAnimationFrame(frame);
      windowRefocusInFlightRef.current = false;
    };
  }, [isComposerScrollCollapsed]);

  useEffect(() => {
    if (!canTrackComposerScrollGesture) return;

    const finishScrollGesture = () => {
      if (composerScrollCollapseTimeoutRef.current !== null) {
        window.clearTimeout(composerScrollCollapseTimeoutRef.current);
      }
      composerScrollCollapseTimeoutRef.current = null;
      resetComposerScrollGesture(composerScrollGestureRef.current);
    };
    const handleTimelineWheel = (event: WheelEvent) => {
      if (event.ctrlKey || !(event.target instanceof Element)) return;

      const scrollNode = getTimelineScrollableNode();
      if (!scrollNode) return;
      const targetsTimeline = isTimelineScrollTarget(event.target, scrollNode, event.deltaY);
      if (
        !scrollNode.contains(event.target) &&
        !composerScrollGestureRef.current.collapseSuppressed
      ) {
        return;
      }

      if (composerScrollCollapseTimeoutRef.current !== null) {
        window.clearTimeout(composerScrollCollapseTimeoutRef.current);
      }
      composerScrollCollapseTimeoutRef.current = window.setTimeout(
        finishScrollGesture,
        COMPOSER_SCROLL_GESTURE_RESET_MS,
      );

      const canScrollInGestureDirection =
        targetsTimeline &&
        (event.deltaY < 0
          ? scrollNode.scrollTop > 0
          : scrollNode.scrollTop < scrollNode.scrollHeight - scrollNode.clientHeight);
      const deltaPx =
        Math.abs(event.deltaY) *
        (event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? scrollNode.clientHeight
            : 1);
      const shouldCollapse = recordComposerScrollGestureEvent(composerScrollGestureRef.current, {
        now: window.performance.now(),
        deltaPx,
        collapseThresholdPx: COMPOSER_SCROLL_COLLAPSE_THRESHOLD_PX,
        collapseEligible: targetsTimeline && composerScrollCollapseEligibleRef.current,
        canScrollInGestureDirection,
        scrollsTowardLogicalEnd: event.deltaY > 0 && isTimelineAtLogicalEnd(),
      });
      if (shouldCollapse) setIsComposerScrollCollapsed(true);
    };

    document.addEventListener("wheel", handleTimelineWheel, { capture: true, passive: true });
    return () => {
      document.removeEventListener("wheel", handleTimelineWheel, true);
      finishScrollGesture();
    };
  }, [canTrackComposerScrollGesture, getTimelineScrollableNode, isTimelineAtLogicalEnd]);

  // Accepted images hold their slots through the compressing count until they
  // land, so concurrent pastes see each other.
  const countReservedAttachments = () => {
    const otherQuestionKeys =
      questionDraftTarget && question
        ? question.asked.fields
            .map((field) => questionDraftKey(chatId, question.asked.key, field.key))
            .filter((key) => key !== questionDraftTarget)
        : [];
    return (
      composerImages.length +
      composerFiles.length +
      compressingImageCount(attachmentDraftTarget) +
      countQuestionAttachments(otherQuestionKeys)
    );
  };

  const insertComposerText = (
    text: string,
    position: "cursor" | "end",
    options?: { ensureLeadingBoundary?: boolean },
  ) => {
    if (text.length === 0 || question !== null) return false;
    const current = promptRef.current;
    const cursor = position === "cursor" ? readComposerSnapshot().expandedCursor : current.length;
    const needsLeadingSpace =
      (options?.ensureLeadingBoundary ?? false) &&
      cursor > 0 &&
      !/\s/.test(current[cursor - 1] ?? "");
    // Text ending in a space absorbs a space already after the caret.
    const rangeEnd = text.endsWith(" ") && current[cursor] === " " ? cursor + 1 : cursor;
    return applyPromptReplacement(cursor, rangeEnd, needsLeadingSpace ? ` ${text}` : text);
  };

  /**
   * Chips for freshly attached files land at the caret, or at the end of the prompt when the
   * editor can't place them. Images skip this when they land with no prose: the shelf
   * thumbnail is enough.
   */
  const insertAttachmentReferences = (
    references: ReadonlyArray<ComposerContextReference>,
    selection?: { start: number; end: number },
  ) => {
    if (references.length === 0) return false;
    // Question answers carry attachments beside the answer, never as chips. Falling back to
    // the chat's prompt here would hide the file behind a reference the question never shows.
    if (questionDraftTarget) return false;
    if (selection) {
      const edit = inlineContextReferenceReplacement(promptRef.current, selection, references);
      return applyPromptReplacement(edit.start, edit.end, edit.text);
    }
    const text = references.map(formatComposerContextReference).join(" ");
    const inserted = insertComposerText(`${text} `, "cursor", { ensureLeadingBoundary: true });
    if (!inserted) {
      setComposerDraftPrompt(chatId, ensureInlineContextReferences(promptRef.current, references));
    }
    return true;
  };

  /** Resolves true when at least one chip was inserted for the accepted attachments. */
  const addComposerAttachments = async (
    files: File[],
    options?: {
      readonly source?: ChatFileAttachment["source"];
      readonly selection?: { start: number; end: number };
      readonly skipImageInlineChip?: boolean;
    },
  ) => {
    if (files.length === 0) return false;
    if (
      question !== null &&
      (!question.progress.field?.acceptsAttachments || question.responding)
    ) {
      toastManager.add({ type: "error", title: "This question cannot accept attachments." });
      return false;
    }
    // Images landing with no prose live on the shelf with no chip. Read before
    // the awaits below: compression is async and the prompt may change while it
    // runs. An explicit selection replace still gets chips, unless paste-as-text
    // asks for no inline image chip.
    const imageAttachmentsGetChips =
      !options?.skipImageInlineChip &&
      (options?.selection !== undefined ||
        stripInlineContextReferences(promptRef.current).trim().length > 0);

    // Validation happens synchronously so concurrent pastes see each other:
    // accepted files reserve their attachment slots (via the compressing count)
    // before the first await, keeping the total under the limit.
    let reservedCount = countReservedAttachments();
    // A pick that matches a needs-reattach marker replaces it in the draft, so
    // it must not consume a slot; a draft full of markers would otherwise hit
    // the capacity error before the replacement path could run.
    const reattachMarkers = composerFiles.filter(composerFileNeedsReattach);
    const replacedReattachMarkerIds = new Set<string>();
    const acceptedImages: File[] = [];
    const acceptedFiles: ComposerFileAttachment[] = [];
    let error: string | null = null;
    for (const file of files) {
      const attachmentKind = classifyComposerAttachmentFile(file);
      const fileMimeType =
        attachmentKind === "file" ? file.type || "application/octet-stream" : file.type;
      const matchingReattachMarker =
        attachmentKind === "file"
          ? reattachMarkers.find(
              (marker) =>
                !replacedReattachMarkerIds.has(marker.id) &&
                composerFileMatchesReattachMarker(marker, {
                  name: file.name || "file",
                  mimeType: fileMimeType,
                  sizeBytes: file.size,
                }),
            )
          : undefined;
      if (matchingReattachMarker) {
        replacedReattachMarkerIds.add(matchingReattachMarker.id);
      }
      if (!matchingReattachMarker && reservedCount >= MESSAGE_MAX_ATTACHMENTS) {
        error = `You can attach up to ${MESSAGE_MAX_ATTACHMENTS} files per message.`;
        // Keep scanning: a later file in this batch can still replace a
        // needs-reattach marker without needing a free slot.
        continue;
      }
      if (attachmentKind === "unsupported-image") {
        error = `'${file.name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`;
        continue;
      }
      if (attachmentKind === "image") {
        acceptedImages.push(normalizeComposerImageFileMimeType(file));
      } else {
        if (file.size <= 0) {
          error = `'${file.name}' is empty or could not be read.`;
          continue;
        }
        if (file.size > ATTACHMENT_MAX_FILE_BYTES) {
          error = `'${file.name}' exceeds the ${ATTACHMENT_MAX_FILE_BYTES / (1024 * 1024)} MB attachment limit.`;
          continue;
        }
        const attachmentFile =
          file.type === fileMimeType
            ? file
            : new File([file], file.name, { type: fileMimeType, lastModified: file.lastModified });
        acceptedFiles.push({
          type: "file",
          id: randomUUID(),
          name: attachmentFile.name || "file",
          mimeType: fileMimeType,
          sizeBytes: attachmentFile.size,
          file: attachmentFile,
          ...(options?.source ? { source: options.source } : {}),
        });
      }
      if (!matchingReattachMarker) {
        reservedCount += 1;
      }
    }
    if (error !== null) toastManager.add({ type: "error", title: error });
    let insertedAny = false;
    if (acceptedFiles.length > 0) {
      // Only files the draft actually took get a chip; a duplicate is deduped by the store
      // and a chip for it would point at nothing.
      const storedIds = new Set(
        addComposerDraftFiles(attachmentDraftTarget, acceptedFiles, {
          appendReference: questionDraftTarget === null,
        }),
      );
      const storedFiles = acceptedFiles.filter((file) => storedIds.has(file.id));
      if (storedFiles.length > 0) {
        insertedAny = insertAttachmentReferences(
          storedFiles.map(attachmentContextReference),
          options?.selection,
        );
      }
      if (options?.source?._tag === "pasted-text" && storedFiles.length > 0) {
        const attached = storedFiles[0]!;
        toastManager.add({
          type: "info",
          title: `Large paste attached as ${attached.name}`,
          description: `${formatAttachmentSize(attached.sizeBytes)} · Use ${
            isMacPlatform(navigator.platform) ? "⌘⇧V" : "Ctrl+Shift+V"
          } to keep a large paste inline.`,
          data: { hideCopyButton: true },
        });
      }
    }
    if (acceptedImages.length === 0) return insertedAny;

    // Compression never throws: an image it can't take comes back as a reason.
    changeCompressingImages(attachmentDraftTarget, acceptedImages.length);
    const nextImages: ComposerImageAttachment[] = [];
    let compressionError: string | null = null;
    for (const file of acceptedImages) {
      // Images over the wire cap are downscaled to fit rather than
      // refused; files already within it pass through byte-for-byte.
      const compressed = await prepareImageForAttachment(file, ATTACHMENT_MAX_IMAGE_BYTES);
      if (!compressed.ok) {
        compressionError =
          compressed.reason === "unreadable"
            ? `'${file.name}' could not be read as an image.`
            : `'${file.name}' is too large to attach, even after compression.`;
        continue;
      }
      nextImages.push({
        type: "image",
        id: randomUUID(),
        name: compressed.file.name || "image",
        mimeType: compressed.file.type,
        sizeBytes: compressed.file.size,
        previewUrl: URL.createObjectURL(compressed.file),
        file: compressed.file,
      });
    }
    // A question that went away meanwhile forgot its count; its images go with it.
    if (compressingImageCount(attachmentDraftTarget) === 0) {
      for (const image of nextImages) URL.revokeObjectURL(image.previewUrl);
      return false;
    }
    changeCompressingImages(attachmentDraftTarget, -acceptedImages.length);
    const storedImageIds = new Set(addComposerDraftImages(attachmentDraftTarget, nextImages));
    const storedImages = nextImages.filter((image) => storedImageIds.has(image.id));
    if (storedImages.length > 0 && imageAttachmentsGetChips) {
      insertedAny =
        insertAttachmentReferences(storedImages.map(attachmentContextReference)) || insertedAny;
    }
    if (compressionError !== null) toastManager.add({ type: "error", title: compressionError });
    return insertedAny;
  };

  const removeComposerImageFromDraft = (imageId: string) => {
    if (questionDraftTarget && question?.responding) return;
    releaseAttachmentUpload(imageId);
    removeComposerDraftImage(attachmentDraftTarget, imageId);
  };

  const removeComposerImage = (imageId: string) => {
    const image = composerImages.find((candidate) => candidate.id === imageId);
    const referenced = collectInlineContextIds(promptRef.current).includes(
      image ? attachmentContextReference(image).contextId : "",
    );
    if (!referenced) {
      removeComposerImageFromDraft(imageId);
      return;
    }
    setPendingImageRemoval(imageId);
  };

  const removeComposerFile = (fileId: string) => {
    if (questionDraftTarget && question?.responding) return;
    releaseAttachmentUpload(fileId);
    removeComposerDraftFile(attachmentDraftTarget, fileId);
  };

  const foldPastedText = (
    plainText: string,
    bypassAutoAttachment: boolean,
    selectionOverride?: { start: number; end: number },
  ) => {
    const questionCanAttach =
      question === null ||
      (question.progress.field?.acceptsAttachments === true && !question.responding);
    const hasAttachmentSlot = countReservedAttachments() < MESSAGE_MAX_ATTACHMENTS;
    const selection = selectionOverride ?? composerEditorRef.current?.readSelectionRange();
    const wouldExceedInputLimit = wouldTextPasteExceedLimit({
      valueLength: promptRef.current.length,
      selection: selection ?? { start: 0, end: 0 },
      textLength: plainText.length,
      maxLength: MESSAGE_MAX_INPUT_CHARS,
    });
    if (!shouldAttachPastedText({ text: plainText, bypassAutoAttachment, wouldExceedInputLimit })) {
      return false;
    }

    if (!questionCanAttach || !hasAttachmentSlot) {
      if (!wouldExceedInputLimit) return false;
      toastManager.add({
        type: "error",
        title: "Pasted text is too large for this message",
        description: "Remove some text or an attachment, then paste again.",
        data: { hideCopyButton: true },
      });
      return true;
    }

    if (pastedTextFileNamesRef.current.targetKey !== attachmentDraftTarget) {
      pastedTextFileNamesRef.current = { targetKey: attachmentDraftTarget, names: new Set() };
    }
    const reservedNames = pastedTextFileNamesRef.current.names;
    for (const file of composerFiles) reservedNames.add(file.name);
    const foldedFileName = nextPastedTextFileName([...reservedNames]);
    reservedNames.add(foldedFileName);
    const foldedFile = new File([plainText], foldedFileName, {
      type: "text/plain;charset=utf-8",
    });
    if (foldedFile.size > ATTACHMENT_MAX_FILE_BYTES) {
      reservedNames.delete(foldedFileName);
      if (!wouldExceedInputLimit) return false;
      toastManager.add({
        type: "error",
        title: "Pasted text is too large to attach",
        description: "Reduce the clipboard contents or save a smaller excerpt as a file.",
        data: { hideCopyButton: true },
      });
      return true;
    }

    void addComposerAttachments([foldedFile], {
      source: { _tag: "pasted-text" },
      ...(selection ? { selection } : {}),
    });
    return true;
  };

  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    const plainText = event.clipboardData.getData("text/plain");
    const bypassAutoAttachment = pasteAsTextShortcutArmedRef.current;
    pasteAsTextShortcutArmedRef.current = false;
    // Claimable pastes go through even when agent questions are pending or the
    // composer is at its attachment limit: `addComposerAttachments` surfaces
    // those as a toast. An early return here would swallow the paste with no
    // feedback.
    if (files.length > 0 && shouldHandleComposerAttachmentPaste({ files, plainText })) {
      event.preventDefault();
      event.stopPropagation();
      void addComposerAttachments(files, { skipImageInlineChip: bypassAutoAttachment });
      return;
    }
    if (!foldPastedText(plainText, bypassAutoAttachment)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  // The phone composer collapses when the editor loses focus. Desktop only
  // rests on a timeline scroll, so losing focus there changes nothing.
  const scheduleComposerCollapseCheck = () => {
    if (!isMobileViewport || mobileComposerExpandInFlightRef.current) return;
    cancelComposerBlurFrame();
    composerBlurFrameRef.current = window.requestAnimationFrame(() => {
      composerBlurFrameRef.current = null;
      if (mobileComposerExpandInFlightRef.current) return;
      const activeElement = document.activeElement;
      if (isInsideRestingComposerControlScope(activeElement)) return;
      if (activeElement instanceof Node && composerFormRef.current?.contains(activeElement)) return;
      setIsComposerFocused(false);
    });
  };

  useEffect(() => {
    return () => {
      for (const frame of [
        composerBlurFrameRef.current,
        mobileComposerExpandFrameRef.current,
        mobileComposerExpandReleaseFrameRef.current,
      ]) {
        if (frame !== null) window.cancelAnimationFrame(frame);
      }
    };
  }, [composerBlurFrameRef, mobileComposerExpandFrameRef, mobileComposerExpandReleaseFrameRef]);

  useImperativeHandle(ref, () => ({
    focusAtEnd: focusEditorAtEnd,
    focusAt: (cursor) => composerEditorRef.current?.focusAt(cursor),
    restoreAfterTimelineReachedEnd: () => setIsComposerScrollCollapsed(false),
    collapseForTimelineScrollKey: (key) => {
      const scrollNode = getTimelineScrollableNode();
      if (
        composerScrollCollapseEligible &&
        scrollNode &&
        shouldCollapseComposerForScrollKey({
          key,
          scrollTop: scrollNode.scrollTop,
          scrollHeight: scrollNode.scrollHeight,
          clientHeight: scrollNode.clientHeight,
          isAtLogicalEnd: isTimelineAtLogicalEnd(),
        })
      ) {
        setIsComposerScrollCollapsed(true);
      }
    },
    addDroppedFiles: (files) => {
      void addComposerAttachments(files).then((inserted) => {
        if (!inserted) focusEditorAtEnd();
      });
    },
    insertTextAtEnd: (text) => {
      const inserted = insertComposerText(inlineContextReferencesToLabels(text), "end");
      // The expanded editor is hidden at phone widths, so its scheduled
      // focus cannot expand the composer by itself. Reveal it before the
      // focus frame runs to preserve type-to-focus and external inserts.
      if (inserted && isComposerCollapsedMobile) expandMobileComposer();
      return inserted;
    },
    pasteTextAtEnd: (text) => {
      const bypassAutoAttachment = pasteAsTextShortcutArmedRef.current;
      pasteAsTextShortcutArmedRef.current = false;
      const end = promptRef.current.length;
      if (!foldPastedText(text, bypassAutoAttachment, { start: end, end })) return false;
      focusEditorAtEnd();
      return true;
    },
    readSnapshot: readComposerSnapshot,
    resetCursorState: () => {
      setMenuHighlight(null);
      setComposerCursor(0);
      resetComposerTrigger(null);
    },
  }));

  return (
    <>
      <form
        ref={composerFormRef}
        onSubmit={submitComposer}
        onPointerDownCapture={(event) => {
          const target = event.target;
          if (isInsideRestingComposerControlScope(target)) return;
          if (isInsideCollapsedComposerControls(target)) return;
          if (!(target instanceof Element)) return;
          if (target.closest('button, a, input, select, [role="button"], [role="menuitem"]'))
            return;

          setIsComposerScrollCollapsed(false);
          if (isComposerResting && !target.closest(".composer-tiptap")) {
            // Clicking resting-surface padding would otherwise blur the editor.
            // Treat that padding like the editor without stealing native caret
            // placement from text.
            event.preventDefault();
            setIsComposerFocused(true);
            window.requestAnimationFrame(focusEditorAtEnd);
          }
        }}
        onFocusCapture={(event) => {
          const target = event.target;
          if (composerControlsCollapsed && isInsideRestingComposerControlScope(target)) return;
          if (isInsideCollapsedComposerControls(target)) return;
          // Focus returning from another window or tab lands on the element
          // that already held it, which is not a request to expand a
          // scroll-collapsed composer.
          if (!windowRefocusInFlightRef.current) setIsComposerScrollCollapsed(false);
          cancelComposerBlurFrame();
          setIsComposerFocused(true);
        }}
        onBlurCapture={scheduleComposerCollapseCheck}
        data-chat-composer-form="true"
      >
        <ComposerBanner.Dock>
          {props.queueBanner}
          <ConnectionNotice />
          {showLoading ? <ComposerLoadingBanner /> : null}
          {question && questionAction ? (
            <ComposerBanner.Root
              data-chat-composer-collapsed-controls={isComposerCollapsedMobile ? "true" : undefined}
            >
              <ComposerQuestionPanel key={question.asked.key} question={question} />
              {isComposerCollapsedMobile &&
              (!isChoiceOnlyField || question.progress.field?.multiSelect) ? (
                <ComposerBanner.Body>
                  <div
                    className={cn(
                      "flex min-w-0 items-center gap-2 rounded-lg border border-border/55 bg-background/55 p-1.5 pl-3 transition-colors hover:bg-background/80",
                      !question.progress.field?.multiSelect && "p-0",
                    )}
                  >
                    {!isChoiceOnlyField ? (
                      <button
                        type="button"
                        className={cn(
                          "min-w-0 flex-1 truncate bg-transparent py-1.5 text-left text-sm",
                          question.progress.customAnswer ? "text-foreground" : "text-placeholder",
                          !question.progress.field?.multiSelect && "px-3 py-2",
                        )}
                        onPointerDown={keepComposerFocus}
                        onClick={expandMobileComposer}
                        aria-label="Write custom answer"
                      >
                        {question.progress.customAnswer || "Write custom answer"}
                      </button>
                    ) : null}
                    {question.progress.field?.multiSelect ? (
                      <ComposerQuestionActions action={questionAction} preserveComposerFocus />
                    ) : null}
                  </div>
                </ComposerBanner.Body>
              ) : null}
            </ComposerBanner.Root>
          ) : null}
        </ComposerBanner.Dock>
        {composerMenuOpen ? (
          <div className="relative">
            <ComposerCommandMenu
              listId={composerSuggestionListId}
              items={composerMenuItems}
              activeCommand={activeComposerMenuItem?.command ?? null}
              onHighlight={(command) => setMenuHighlight({ command, query: menuQuery })}
              onSelect={onSelectComposerItem}
            />
          </div>
        ) : null}
        <div className="chat-composer-input">
          <div
            data-chat-composer-mobile-collapsed={isComposerCollapsedMobile ? "true" : "false"}
            className="rounded-3xl transition-[background-color] duration-200"
          >
            {isComposerCollapsedMobile && question === null ? (
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <button
                  type="button"
                  className={cn(
                    "min-w-0 flex-1 truncate bg-transparent p-0 text-left text-sm focus:outline-none",
                    prompt.trim() ? "text-foreground" : "text-placeholder",
                  )}
                  onPointerDown={keepComposerFocus}
                  onClick={expandMobileComposer}
                  aria-label="Expand composer"
                >
                  {prompt.trim() || "Ask anything..."}
                </button>
                {collapsedComposerImagePreviews}
                <ComposerSendActions
                  isRunning={running}
                  isSendBusy={isSendBusy}
                  sendDisabledReason={sendDisabledReason}
                  hasSendableContent={hasSendableContent}
                  preserveComposerFocus
                  onInterrupt={canInterrupt ? onInterrupt : undefined}
                />
              </div>
            ) : null}

            <div
              ref={setComposerBody}
              className={cn(
                "relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4",
                isComposerCollapsedMobile && "hidden",
                isComposerResting && "py-2 sm:py-2",
              )}
            >
              <div role="status" aria-atomic="true" className="sr-only">
                {composerMenuOpen && composerMenuItems.length === 0 ? "No matching command." : ""}
              </div>
              {!isComposerCollapsedMobile && question === null && composerImages.length > 0 && (
                <div className="mb-3 flex max-w-full flex-wrap gap-2">
                  {composerImages.map((image) => {
                    const upload = uploadsByAttachmentId[image.id];
                    return (
                      <div
                        key={image.id}
                        className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-border/80 bg-background"
                      >
                        <button
                          type="button"
                          className="h-full w-full cursor-zoom-in"
                          aria-label={`Preview ${image.name}`}
                          onClick={() => expandImage(image.id)}
                        >
                          <ComposerImageThumbnail
                            file={image.file}
                            alt={image.name}
                            className="h-full w-full object-cover"
                            fallback={
                              <span className="flex h-full items-center justify-center px-1 text-3xs text-secondary-label">
                                {image.name}
                              </span>
                            }
                          />
                        </button>
                        {attachmentDraft.nonPersistedImageIds.includes(image.id) && (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span
                                  role="img"
                                  aria-label="Draft attachment may not persist"
                                  className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-warning-foreground"
                                >
                                  <CircleAlertIcon className="size-3" />
                                </span>
                              }
                            />
                            <TooltipPopup side="top">
                              Draft attachment could not be saved locally and may be lost on
                              navigation.
                            </TooltipPopup>
                          </Tooltip>
                        )}
                        {upload?.status === "uploading" && (
                          <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-3xs text-foreground">
                            {formatAttachmentUploadProgress(upload.progress)}
                          </span>
                        )}
                        {upload?.status === "failed" && (
                          <span className="absolute bottom-1 left-1 flex">
                            <RetryUploadButton
                              variant="overlay"
                              attachment={image}
                              reason={upload.reason}
                            />
                          </span>
                        )}
                        <span className="absolute right-1 top-1 flex">
                          <Button
                            variant="media-close"
                            size="icon-xs"
                            onClick={() => removeComposerImage(image.id)}
                            aria-label={`Remove ${image.name}`}
                          >
                            <XIcon />
                          </Button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {!isComposerCollapsedMobile && unreferencedFiles.length > 0 && (
                <div className="mb-3 flex flex-col gap-1">
                  {unreferencedFiles.map((file) => {
                    const upload = uploadsByAttachmentId[file.id];
                    const needsReattach = composerFileNeedsReattach(file);
                    return (
                      <div
                        key={file.id}
                        className="flex min-w-0 items-center gap-2 py-1 text-sm text-foreground"
                      >
                        <FileIcon className="size-4 shrink-0 text-icon-muted" />
                        <span className="min-w-0 flex-1 truncate">{file.name}</span>
                        <span className="shrink-0 text-xs text-secondary-label">
                          {needsReattach
                            ? "Attach again"
                            : upload?.status === "uploading"
                              ? formatAttachmentUploadProgress(upload.progress)
                              : formatAttachmentSize(file.sizeBytes)}
                        </span>
                        {!needsReattach && upload?.status === "failed" ? (
                          <RetryUploadButton
                            variant="ghost"
                            attachment={file}
                            reason={upload.reason}
                          />
                        ) : null}
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => removeComposerFile(file.id)}
                          aria-label={`Remove ${file.name}`}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}

              <div
                className={cn(
                  "relative",
                  isComposerResting && [
                    "flex min-w-0 items-center gap-1",
                    showComposerAttachAction ? "pr-20" : "pr-12",
                  ],
                )}
              >
                <ComposerChipsContext value={{ records: composerContextRecords, expandImage }}>
                  <ComposerPromptEditor
                    ariaLabel="Message"
                    suggestionListId={composerSuggestionListId}
                    activeSuggestionId={
                      activeComposerMenuItem
                        ? composerSuggestionOptionId(
                            composerSuggestionListId,
                            activeComposerMenuItem.command,
                          )
                        : undefined
                    }
                    editorRef={composerEditorRef}
                    value={editorValue}
                    cursor={composerCursor}
                    containerClassName={cn(isComposerResting && "min-w-0 flex-1")}
                    className={cn(
                      mobileQuestionAction && "max-sm:pb-12",
                      isComposerResting &&
                        "my-0 max-h-8 min-h-8 overflow-hidden py-0 whitespace-pre! leading-8",
                    )}
                    placeholderClassName={cn(
                      isComposerResting &&
                        "flex items-center overflow-hidden whitespace-nowrap leading-8",
                    )}
                    onChange={onPromptChange}
                    onVisibleSelectionChange={expandComposerForEditorChange}
                    onCommandKeyDown={onComposerCommandKey}
                    onPageScrollKeyDown={onPageScrollKeyDown}
                    onPaste={onComposerPaste}
                    placeholder={
                      question
                        ? isChoiceOnlyField
                          ? "Choose an option above"
                          : "Type your own answer, or leave this blank to use the selected option"
                        : isServerUnreachable
                          ? "Server: Reconnecting…"
                          : "Ask anything, or / for commands"
                    }
                    disabled={isChoiceOnlyField || question?.responding === true}
                  />
                </ComposerChipsContext>
                {isComposerResting ? collapsedComposerImagePreviews : null}
                {mobileQuestionAction ? (
                  <div className="absolute bottom-0 right-0 flex items-center justify-end gap-1">
                    <ComposerQuestionActions action={mobileQuestionAction} preserveComposerFocus />
                  </div>
                ) : null}
              </div>
            </div>

            {composerSubmissionError ? (
              <ErrorText size="xs" className="mx-3 mb-2 sm:mx-4">
                {composerSubmissionError}
              </ErrorText>
            ) : null}

            {isComposerCollapsedMobile ? null : (
              <div
                className={cn(
                  "flex min-w-0 flex-nowrap items-center justify-end overflow-visible px-3 pb-3 sm:px-4 sm:pb-4",
                  question !== null && "pt-2",
                  mobileQuestionAction && "hidden sm:flex",
                  isComposerResting && "absolute right-px bottom-px z-10 h-12 w-auto py-0 sm:py-0",
                )}
              >
                <div className="flex shrink-0 flex-nowrap items-center justify-end gap-2">
                  {showComposerAttachAction ? (
                    <>
                      <input
                        ref={attachmentInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(event) => {
                          const files = Array.from(event.currentTarget.files ?? []);
                          event.currentTarget.value = "";
                          // Inserting a chip refocuses the editor after the draft renders;
                          // focusing synchronously here would report the editor's stale text
                          // over the prompt that was just written.
                          void addComposerAttachments(files).then((inserted) => {
                            if (!inserted) focusEditorAtEnd();
                          });
                        }}
                      />
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onPointerDown={keepComposerFocus}
                              onClick={() => attachmentInputRef.current?.click()}
                              aria-label="Attach files"
                            />
                          }
                        >
                          <PaperclipIcon />
                        </TooltipTrigger>
                        <TooltipPopup>Attach files</TooltipPopup>
                      </Tooltip>
                    </>
                  ) : null}
                  {questionAction ? (
                    <ComposerQuestionActions
                      action={questionAction}
                      preserveComposerFocus={isMobileViewport || isComposerResting}
                      onInterrupt={canInterrupt ? onInterrupt : undefined}
                    />
                  ) : (
                    <ComposerSendActions
                      isRunning={running}
                      isSendBusy={isSendBusy}
                      sendDisabledReason={sendDisabledReason}
                      hasSendableContent={hasSendableContent}
                      preserveComposerFocus={isMobileViewport || isComposerResting}
                      onInterrupt={canInterrupt ? onInterrupt : undefined}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </form>
      <AlertDialog
        open={pendingImageRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingImageRemoval(null);
        }}
      >
        <DialogPopup closeButton={false}>
          <DialogHeader>
            <DialogTitle>{`Remove ${pendingImageName ?? "this image"} from the message?`}</DialogTitle>
            <DialogDescription>
              It is referenced in your text; removing it also removes every reference.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingImageRemoval !== null) removeComposerImageFromDraft(pendingImageRemoval);
                setPendingImageRemoval(null);
              }}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogPopup>
      </AlertDialog>
    </>
  );
});
