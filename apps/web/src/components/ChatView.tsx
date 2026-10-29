import { useAtomValue } from "@effect/atom-react";
import type { LegendListRef } from "@legendapp/list/react";
import type { Session } from "@opencode/schema/session";
import type { Agent } from "@t45/contracts/models/Agent";
import { type ChatId, titleOf } from "@t45/contracts/models/Chat";
import type { PendingInput } from "@t45/contracts/resources/Chats";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpLeftIcon, BotIcon, ChevronDownIcon, PaperclipIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  type ComposerPromptHistoryMessage,
  parseStandaloneComposerSlashCommand,
} from "../composerPrompt";
import { useDelayedTrue } from "../hooks/useDelayedTrue";
import { useNewChat } from "../hooks/useNewChat";
import { stripInlineContextReferences } from "../lib/composerContextReferences";
import { describeFailure, isNotFound } from "../lib/failures";
import { forgetChatDrafts } from "../questionDrafts";
import { api, reachableAtom } from "../rpc/api";
import { chatTargets } from "../state/chatTargets";
import { chatSessionKey, chats } from "../state/chats";
import { toastFailure } from "../state/query";
import { useApiQuery } from "../state/rpc";
import { ChatBanner } from "./chat/ChatBanner";
import { ChatCanvas } from "./chat/ChatCanvas";
import { ChatComposer, type ChatComposerHandle, type ComposerLayout } from "./chat/ChatComposer";
import { ChatHeader } from "./chat/ChatHeader";
import { useChatSessionSummary } from "./chat/chatSessionSummary";
import { ChatTimeline, type ChatTimelineHistory } from "./chat/ChatTimeline";
import { keepComposerFocus, resolveComposerTimelineInset } from "./chat/composerLayout";
import { ExpandedImageDialog, type ImageGallery } from "./chat/ExpandedImageDialog";
import { makeFileDropHandlers, refuseFileDrop } from "./chat/fileDrop";
import { type PageScrollKey, scrollTimelinePage } from "./chat/pageScroll";
import { QueuedInputsBanner } from "./chat/QueuedInputsBanner";
import { sendChatMessage, sendsInFlight } from "./chat/sendChatMessage";
import { resolveTimelineIsAtEnd } from "./chat/timelineScroll";
import { useChatQuestions } from "./chat/useChatQuestions";
import { useComposerFocus } from "./chat/useComposerFocus";
import { PageHeader } from "./PageHeader";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

const NO_PROMPT_HISTORY: ReadonlyArray<ComposerPromptHistoryMessage> = [];
const NO_INPUTS: ReadonlyArray<PendingInput> = [];

const START_FAILED =
  "The agent's sandbox couldn't start. T45 keeps trying, and your message waits.";

export default function ChatView({
  chatId,
  sessionId,
  newAgentId,
  newWorkflowId,
}: {
  readonly chatId: ChatId;
  /** A subagent session of the chat to show, read only; null for the chat itself. */
  readonly sessionId: Session.ID | null;
  readonly newAgentId: Agent["id"] | null;
  readonly newWorkflowId: string | null;
}) {
  const readOnly = sessionId !== null;
  const newChat = useNewChat();
  const navigate = useNavigate();
  // Lets async handlers tell "still on the chat I started from" from "the member has since
  // navigated away".
  const routeChatIdRef = useRef<string | null>(chatId);
  useLayoutEffect(() => {
    routeChatIdRef.current = chatId;
    return () => {
      routeChatIdRef.current = null;
    };
  }, [chatId]);

  const isReachable = useAtomValue(reachableAtom);

  const sessionKey = chatSessionKey(chatId, sessionId);
  // The summary leaves the messages out: only the timeline below re-renders as words stream.
  const view = useChatSessionSummary(sessionKey);
  const ready = view.status === "ready" ? view : null;
  const loading = view.status === "loading";
  const missing = view.status === "failed" && isNotFound(view.error);
  const isNew = missing && newAgentId !== null;
  useEffect(() => {
    if (!missing || newAgentId !== null) return;
    forgetChatDrafts(chatId);
    void navigate({ to: "/chats", replace: true });
  }, [chatId, missing, newAgentId, navigate]);
  const started = ready !== null && newAgentId !== null;
  useEffect(() => {
    if (started)
      void navigate({ to: "/chats/$chatId", params: { chatId }, search: {}, replace: true });
  }, [chatId, started, navigate]);
  const chatInfo = ready?.chat ?? null;
  const currentSession = ready?.sessions.find((session) =>
    sessionId === null ? session.parentID === undefined : session.id === sessionId,
  );
  const rootSessionId =
    ready?.sessions.find((session) => session.parentID === undefined)?.id ?? null;

  const status = chatInfo?.status ?? null;
  const running = status === "running";
  const canInterrupt = !readOnly && (status === "running" || status === "waiting");
  const working = running && !ready?.replying;
  // The next input to an agent between turns is on its way into the conversation, and shows
  // there; what follows it waits its turn in the queue.
  const pendingInputs = ready?.inputs ?? NO_INPUTS;
  const sendingInput =
    !readOnly && running && ready?.betweenTurns === true ? (pendingInputs[0] ?? null) : null;
  const queuedInputs = sendingInput === null ? pendingInputs : pendingInputs.slice(1);

  const newAgent = useApiQuery(isNew ? chatTargets : null).data?.find(
    (target) => target.agentId === newAgentId && (target.workflowId ?? null) === newWorkflowId,
  );
  const agentName = chatInfo?.agentName ?? newAgent?.name ?? null;
  const title = chatInfo !== null ? titleOf(chatInfo) : isNew ? titleOf({ title: null }) : "";

  // A failed open, or an agent that couldn't start, shows until dismissed, or until it changes;
  // a failure the conversation shows already needs no banner.
  const banner =
    view.status === "failed" && !missing
      ? describeFailure(view.error, "Could not open the chat.")
      : status === "failed" && ready?.endsWithError === false
        ? START_FAILED
        : null;
  const [dismissedBanner, setDismissedBanner] = useState<string | null>(null);
  if (dismissedBanner !== null && dismissedBanner !== banner) setDismissedBanner(null);
  const shownBanner = banner === dismissedBanner ? null : banner;

  const promptRef = useRef("");
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  useComposerFocus(composerRef, chatId);

  const [expandedImage, setExpandedImage] = useState<ImageGallery | null>(null);
  const [fileDragActive, setFileDragActive] = useState(false);
  useEffect(() => {
    if (!fileDragActive) return;
    const clear = () => setFileDragActive(false);
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, [fileDragActive]);
  // Built inside each drag event, since the handlers reach the composer through its ref.
  const fileDrop = () =>
    makeFileDropHandlers({
      setDragActive: setFileDragActive,
      addFiles: (files) => composerRef.current?.addDroppedFiles(files),
    });

  // ---------------------------------------------------------------------------
  // Timeline scrolling: follow the live end until the member scrolls away.
  // ---------------------------------------------------------------------------
  const listRef = useRef<LegendListRef | null>(null);
  const getTimelineScrollableNode = () => listRef.current?.getScrollableNode() ?? null;
  const isAtEndRef = useRef(true);
  const isTimelineAtLogicalEnd = () =>
    resolveTimelineIsAtEnd(listRef.current?.getState()) ?? isAtEndRef.current;
  const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
  const [timelineOverflows, setTimelineOverflows] = useState(false);
  // The pill waits a moment so it doesn't flash while a chat opens at its end.
  const showScrollToBottom = useDelayedTrue(!liveFollowEnabled && timelineOverflows, 150);
  const onIsAtEndChange = (isAtEnd: boolean) => {
    if (isAtEndRef.current === isAtEnd) return;
    isAtEndRef.current = isAtEnd;
    setLiveFollowEnabled(isAtEnd);
    if (isAtEnd) composerRef.current?.restoreAfterTimelineReachedEnd();
  };
  const onManualNavigation = () => {
    isAtEndRef.current = false;
    setLiveFollowEnabled(false);
  };
  const scrollToEnd = (animated = false) => {
    isAtEndRef.current = true;
    setLiveFollowEnabled(true);
    requestAnimationFrame(() => {
      void listRef.current?.scrollToEnd?.({ animated });
    });
  };

  // ---------------------------------------------------------------------------
  // Composer overlay: the space the timeline keeps clear above its end.
  // ---------------------------------------------------------------------------
  const [composerOverlayElement, setComposerOverlayElement] = useState<HTMLDivElement | null>(null);
  const [composerLayout, setComposerLayout] = useState<ComposerLayout>("open");
  const [overlay, setOverlay] = useState({ height: 0, resting: false });
  const [timelineInset, setTimelineInset] = useState(0);

  // Each chat and session opens at its end, with the space rebuilt from its own composer.
  const [openedSession, setOpenedSession] = useState(`${chatId}:${sessionId}`);
  if (openedSession !== `${chatId}:${sessionId}`) {
    setOpenedSession(`${chatId}:${sessionId}`);
    setLiveFollowEnabled(true);
    setExpandedImage(null);
    setFileDragActive(false);
    setDismissedBanner(null);
    setTimelineInset(0);
  }
  useLayoutEffect(() => {
    isAtEndRef.current = true;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the opened session is the trigger
  }, [openedSession]);

  // A change of chat or of the composer's layout re-measures before the frame paints; the
  // observer catches the rest.
  useLayoutEffect(() => {
    if (!composerOverlayElement) return;
    // A status bar in the composer's place never rests.
    const resting = !readOnly && composerLayout === "resting";
    const measure = () => {
      const height = Math.ceil(composerOverlayElement.getBoundingClientRect().height);
      setOverlay((current) =>
        current.height === height && current.resting === resting ? current : { height, resting },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(composerOverlayElement);
    return () => observer.disconnect();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the chat is a trigger
  }, [composerOverlayElement, composerLayout, readOnly, openedSession]);
  const nextTimelineInset =
    overlay.height > 0
      ? resolveComposerTimelineInset({
          currentInset: timelineInset,
          overlayHeight: overlay.height,
          isResting: overlay.resting,
        })
      : timelineInset;
  if (nextTimelineInset !== timelineInset) setTimelineInset(nextTimelineInset);

  const pageScrollTargetRef = useRef(0);
  const onComposerPageScroll = (key: PageScrollKey, repeat: boolean) => {
    const timeline = getTimelineScrollableNode();
    if (!timeline) return;
    const from = repeat ? pageScrollTargetRef.current : timeline.scrollTop;
    const target = scrollTimelinePage(timeline, key, overlay.height, from);
    if (target === null) return;
    pageScrollTargetRef.current = target;
    composerRef.current?.collapseForTimelineScrollKey(key);
    if (key === "PageUp" || !isTimelineAtLogicalEnd()) onManualNavigation();
  };

  // ---------------------------------------------------------------------------
  // Questions the agent asked, answered in the composer; then sending.
  // ---------------------------------------------------------------------------
  const question = useChatQuestions({
    chatId,
    questions: ready?.questions,
    readOnly,
    composerDraftTarget: chatId,
    composerRef,
    promptRef,
  });

  const [sendBusy, setSendBusy] = useState(false);
  const [sentIn, setSentIn] = useState<ChatId | null>(null);
  // An empty chat centers its composer; a send docks it.
  const isEmptyChat =
    !readOnly &&
    (isNew || (ready !== null && !ready.hasUserMessages && pendingInputs.length === 0)) &&
    sentIn !== chatId;
  const startNewChat = () =>
    void newChat().catch((error: unknown) => toastFailure("Couldn't start a new chat", error));

  const compactDisabled =
    readOnly ||
    loading ||
    running ||
    sendBusy ||
    !isReachable ||
    question !== null ||
    !ready?.hasUserMessages;
  const onCompactContext = () => {
    if (compactDisabled) return;
    void api("chats.compact", { chatId }).catch((error: unknown) =>
      toastFailure("Couldn't compact the conversation", error),
    );
  };
  const onSend = (event?: { preventDefault: () => void }) => {
    event?.preventDefault();
    if (readOnly || sendsInFlight.has(chatId) || loading) return false;
    if (question) {
      question.onAdvance();
      return question.progress.isLastField && question.progress.blockedReason === null;
    }
    const draft = useComposerDraftStore.getState().getComposerDraft(chatId);
    const attachments = draft ? [...draft.images, ...draft.files] : [];
    const prompt = promptRef.current;
    const trimmedPrompt = stripInlineContextReferences(prompt).trim();
    const command =
      attachments.length === 0 ? parseStandaloneComposerSlashCommand(trimmedPrompt) : null;
    if (command === "compact" && compactDisabled) {
      toastManager.add({ type: "error", title: "Compacting is unavailable right now." });
      return false;
    }
    if (command !== null) {
      promptRef.current = "";
      clearComposerDraftContent(chatId);
      composerRef.current?.resetCursorState();
      if (command === "new") startNewChat();
      else onCompactContext();
      return true;
    }
    if (trimmedPrompt.length === 0 && attachments.length === 0) return false;
    const isOpen = () => routeChatIdRef.current === chatId;
    setSentIn(chatId);
    void sendChatMessage({
      chatId,
      agentId: isNew ? newAgentId : null,
      workflowId: isNew ? newWorkflowId : null,
      prompt,
      attachments,
      setBusy: setSendBusy,
      isOpen,
      clearComposer: () => {
        promptRef.current = "";
        if (isOpen()) composerRef.current?.resetCursorState();
      },
      scrollToEnd,
    });
    return true;
  };

  const onInterrupt = () =>
    void api("chats.stop", { chatId }).catch((error: unknown) =>
      toastFailure("Couldn't stop the agent", error),
    );
  const onCancelInput = (input: PendingInput) =>
    api("chats.cancel", { chatId, inputId: input.inputId }).catch((error: unknown) =>
      toastFailure("Couldn't cancel the queued message", error),
    );

  const history: ChatTimelineHistory | null =
    ready === null || (!ready.hasEarlier && ready.earlierError === null)
      ? null
      : {
          hasEarlier: ready.hasEarlier,
          loading: ready.loadingEarlier,
          error: ready.earlierError,
          onLoadEarlier: () => void chats.loadEarlier(sessionKey),
        };
  // Opens a session of the chat; null or the root session opens the chat itself.
  const openSession = (target: Session.ID | null) =>
    void navigate({
      to: "/chats/$chatId",
      params: { chatId },
      search: target === null || target === rootSessionId ? {} : { session: target },
    });
  const promptHistoryMessages = ready?.promptHistory ?? NO_PROMPT_HISTORY;
  const sendDisabledReason = loading ? "Messages loading" : null;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
        <PageHeader className="relative">
          <ChatHeader
            activeChatId={chatId}
            activeChatTitle={title}
            compactDisabled={compactDisabled}
            onCompactContext={onCompactContext}
          />
        </PageHeader>

        <div className="relative flex min-h-0 min-w-0 flex-1">
          <ChatCanvas
            {...(readOnly
              ? refuseFileDrop
              : {
                  onDragEnter: (event) => fileDrop().onDragEnter(event),
                  onDragOver: (event) => fileDrop().onDragOver(event),
                  onDragLeave: (event) => fileDrop().onDragLeave(event),
                  onDrop: (event) => fileDrop().onDrop(event),
                })}
          >
            {fileDragActive ? (
              <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]">
                <div
                  role="status"
                  className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg"
                >
                  <PaperclipIcon className="size-4 text-primary" aria-hidden="true" />
                  Drop files to attach
                </div>
              </div>
            ) : null}
            {/* Banners overlay the timeline without changing its content height. */}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col">
              <ChatBanner error={shownBanner} onDismiss={() => setDismissedBanner(banner)} />
            </div>
            <div className="relative flex min-h-0 flex-1 flex-col bg-background">
              <ChatTimeline
                key={openedSession}
                sessionKey={sessionKey}
                chatId={chatId}
                sessions={ready?.sessions ?? []}
                working={working}
                sending={sendingInput}
                listRef={listRef}
                history={history}
                onImageExpand={setExpandedImage}
                onOpenSession={openSession}
                composerInset={timelineInset}
                liveFollowEnabled={liveFollowEnabled}
                onIsAtEndChange={onIsAtEndChange}
                onContentOverflowChange={setTimelineOverflows}
                emptyPlaceholder={isEmptyChat || loading ? "blank" : "prompt"}
                topFadeEnabled={shownBanner === null}
              />
            </div>

            {/* Input bar: centered for an empty chat, docked after sending. */}
            <div
              ref={setComposerOverlayElement}
              className={
                isEmptyChat
                  ? "pointer-events-none absolute inset-0 z-20 flex items-center"
                  : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
              }
            >
              <div className="w-full ps-(--page-gutter-start) pe-(--page-gutter-end)">
                <div className="pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-content-max-width)">
                  {isEmptyChat ? (
                    <div className="absolute inset-x-0 bottom-full">
                      <div className="pb-4">
                        <h1 className="mx-auto w-full max-w-5xl text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
                          {agentName ? `Chat with ${agentName}` : "What can I help you with?"}
                        </h1>
                      </div>
                    </div>
                  ) : showScrollToBottom ? (
                    <div className="pointer-events-none absolute inset-x-0 bottom-full flex justify-center pb-4 sm:pb-4.5">
                      <Button
                        onPointerDown={keepComposerFocus}
                        onClick={() => {
                          composerRef.current?.restoreAfterTimelineReachedEnd();
                          scrollToEnd(true);
                        }}
                        className="pointer-events-auto"
                        size="xs"
                        variant="glass"
                      >
                        <ChevronDownIcon className="size-3.5" />
                        Scroll to end
                      </Button>
                    </div>
                  ) : null}
                  <div className="relative z-10">
                    <div className="chat-composer">
                      {readOnly ? (
                        <SubagentSessionBar
                          title={currentSession?.title ?? null}
                          onOpenParent={() => openSession(currentSession?.parentID ?? null)}
                        />
                      ) : (
                        <ChatComposer
                          ref={composerRef}
                          chatId={chatId}
                          promptHistoryMessages={promptHistoryMessages}
                          forceExpandedOnMobile={isEmptyChat}
                          running={running}
                          canInterrupt={canInterrupt}
                          isSendBusy={sendBusy}
                          sendDisabledReason={sendDisabledReason}
                          queueBanner={
                            queuedInputs.length > 0 ? (
                              <QueuedInputsBanner inputs={queuedInputs} onCancel={onCancelInput} />
                            ) : null
                          }
                          question={question}
                          loadingMessages={loading && isReachable}
                          compactDisabled={compactDisabled}
                          getTimelineScrollableNode={getTimelineScrollableNode}
                          isTimelineAtLogicalEnd={isTimelineAtLogicalEnd}
                          timelineOverflows={timelineOverflows}
                          onLayoutChange={setComposerLayout}
                          promptRef={promptRef}
                          onPageScrollKeyDown={onComposerPageScroll}
                          onCompactContext={onCompactContext}
                          onSend={onSend}
                          onStartNewChat={startNewChat}
                          onInterrupt={onInterrupt}
                          onImageExpand={setExpandedImage}
                        />
                      )}
                    </div>
                    <div
                      aria-hidden
                      className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                    />
                  </div>
                </div>
              </div>
            </div>
          </ChatCanvas>
        </div>
      </div>

      {expandedImage ? (
        <ExpandedImageDialog gallery={expandedImage} onClose={() => setExpandedImage(null)} />
      ) : null}
    </div>
  );
}

/**
 * Stands in for the composer on a subagent session: the agent that started it runs that
 * conversation, so there is nothing to send; the bar leads back to it.
 */
function SubagentSessionBar(props: {
  readonly title: string | null;
  readonly onOpenParent: () => void;
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 rounded-3xl py-2 ps-5 pe-2 text-sm">
      <span className="flex min-w-0 items-center gap-2">
        <BotIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium text-foreground">
          {props.title || "Subagent"}
        </span>
      </span>
      <span className="ms-auto shrink-0 text-muted-foreground max-sm:hidden">Runs on its own</span>
      <Button size="sm" variant="ghost" onClick={props.onOpenParent}>
        <ArrowUpLeftIcon />
        Open parent
      </Button>
    </div>
  );
}
