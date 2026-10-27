import { type ChatContextRecord, type ChatId } from "@t45/contracts/models/Chat";
import type { ChatMessage, ChatSession, PendingInput } from "@t45/contracts/resources/Chats";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import type { Session } from "@opencode/schema/session";
import {
  collectComposerContextReferences,
  replaceComposerContextReferences,
} from "@t45/core/composerContextReferences";
import * as DateTime from "effect/DateTime";
import {
  BotIcon,
  BrainIcon,
  CircleAlertIcon,
  CircleStopIcon,
  DownloadIcon,
  FileIcon,
  Minimize2Icon,
  SparklesIcon,
  TerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  memo,
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { formatAttachmentSize } from "~/lib/attachmentFiles";
import { attachmentUrl } from "~/lib/attachmentUrl";
import { inlineContextReferencesToLabels } from "~/lib/composerContextReferences";
import { cn } from "~/lib/utils";
import {
  chats,
  type ChatSessionKey,
  type NativeToolPart,
  useChatSessionView,
} from "../../state/chats";
import { useApiQuery } from "../../state/rpc";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { Markdown, type MarkdownContextReference } from "../markdown/Markdown";
import { FileChip, ImageChipButton, UnresolvedChip } from "../ContextChip";
import { CopyButton } from "../CopyButton";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipScrollDismissArea, TooltipTrigger } from "../ui/tooltip";
import {
  assistantText,
  boundText,
  firstLine,
  isShownMessage,
  subagentSessionId,
  toolLabel,
  isWorkflowDraftCall,
  toolOutputText,
  userMessageContent,
  workflowDraftOf,
  type UserMessageContent,
} from "./chatMessages.logic";
import { useRegisterTimeline } from "./ChatCanvas";
import type { ImageGallery } from "./ExpandedImageDialog";
import { ShellCommandBlock } from "./ShellCommandBlock";
import { resolveTimelineIsAtEnd, timelineContentOverflowsViewport } from "./timelineScroll";
import { WorkflowDraftCard } from "./WorkflowDraftCard";
import { WorkLogRow } from "./WorkLog";

interface TimelineShared {
  readonly chatId: ChatId;
  readonly sessions: ReadonlyArray<ChatSession>;
  readonly onImageExpand: (gallery: ImageGallery) => void;
  readonly onOpenSession: (sessionId: Session.ID) => void;
}

const TimelineCtx = createContext<TimelineShared>(null!);

export interface ChatTimelineHistory {
  readonly hasEarlier: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onLoadEarlier: () => void;
}

const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FADE_HEADER = <div className="h-(--chat-scroll-fade-height)" />;
const TIMELINE_MAINTAIN_SCROLL_AT_END = {
  animated: false,
  // Composer inset changes must not move visible messages; new rows and row growth still follow.
  on: { dataChange: true, footerLayout: false, itemLayout: true, layout: true },
} as const;

// Screen readers skim a transcript by heading; the chat title is an <h2>.
function MessageAuthorHeading({ children }: { children: string }) {
  return <h3 className="sr-only select-none">{children}</h3>;
}

const keyExtractor = (message: ChatMessage) => message.message.id;
const getItemType = (message: ChatMessage) => message.message.type;

const NO_MESSAGES: ReadonlyArray<ChatMessage> = [];

/**
 * The open session's messages as OpenCode keeps them, oldest first, virtualized. It is the one
 * part of the chat that reads them, so streamed words re-render it alone, and each row is
 * memoized on its message, so a streamed delta re-renders only the message it lands in.
 */
export const ChatTimeline = memo(function ChatTimeline(props: {
  readonly chatId: ChatId;
  readonly sessionKey: ChatSessionKey;
  readonly sessions: ReadonlyArray<ChatSession>;
  /** The agent is at work and no streaming message shows it yet. */
  readonly working: boolean;
  /** A message on its way into the conversation, shown at its end until it is there. */
  readonly sending: PendingInput | null;
  readonly listRef: React.RefObject<LegendListRef | null>;
  readonly history: ChatTimelineHistory | null;
  readonly onImageExpand: (gallery: ImageGallery) => void;
  readonly onOpenSession: (sessionId: Session.ID) => void;
  readonly composerInset: number;
  readonly liveFollowEnabled: boolean;
  readonly onIsAtEndChange: (isAtEnd: boolean) => void;
  readonly onContentOverflowChange: (overflows: boolean) => void;
  readonly emptyPlaceholder: "prompt" | "blank";
  readonly topFadeEnabled: boolean;
}) {
  const { listRef, history, onIsAtEndChange, onContentOverflowChange, composerInset } = props;
  const view = useChatSessionView(props.sessionKey);
  const sessionMessages = view.status === "ready" ? view.messages : NO_MESSAGES;
  const messages = sessionMessages.filter(isShownMessage);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const measureOverflow = () =>
    timelineContentOverflowsViewport(listRef.current?.getState(), composerInset);
  // LegendList lays rows out from layout effects; the next frame reads settled positions.
  const overflowFrame = useRef<number | null>(null);
  const reportOverflow = () => {
    if (overflowFrame.current !== null) return;
    overflowFrame.current = requestAnimationFrame(() => {
      overflowFrame.current = null;
      onContentOverflowChange(measureOverflow());
    });
  };
  useEffect(
    () => () => {
      if (overflowFrame.current !== null) cancelAnimationFrame(overflowFrame.current);
    },
    [],
  );
  useLayoutEffect(() => {
    onContentOverflowChange(messages.length > 0 && measureOverflow());
  }, [measureOverflow, messages.length, onContentOverflowChange]);

  // Only the member leaves the live end: content growing under a following list can read as
  // "not at the end" for a frame, which must not stop the follow.
  const memberScrolledRef = useRef(false);
  useEffect(() => {
    if (!viewport) return;
    const scrolled = () => {
      memberScrolledRef.current = true;
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) scrolled();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (["PageUp", "ArrowUp", "Home"].includes(event.key)) scrolled();
    };
    viewport.addEventListener("wheel", onWheel, { passive: true });
    viewport.addEventListener("touchmove", scrolled, { passive: true });
    viewport.addEventListener("pointerdown", scrolled, { passive: true });
    viewport.addEventListener("keydown", onKeyDown);
    return () => {
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("touchmove", scrolled);
      viewport.removeEventListener("pointerdown", scrolled);
      viewport.removeEventListener("keydown", onKeyDown);
    };
  }, [viewport]);
  const handleScroll = () => {
    const isAtEnd = resolveTimelineIsAtEnd(listRef.current?.getState());
    if (isAtEnd === true) memberScrolledRef.current = false;
    if (
      isAtEnd !== undefined &&
      (isAtEnd || memberScrolledRef.current || !props.liveFollowEnabled)
    ) {
      onIsAtEndChange(isAtEnd);
    }
    reportOverflow();
  };

  const shared = useMemo<TimelineShared>(
    () => ({
      chatId: props.chatId,
      sessions: props.sessions,
      onImageExpand: props.onImageExpand,
      onOpenSession: props.onOpenSession,
    }),
    [props.chatId, props.onImageExpand, props.onOpenSession, props.sessions],
  );
  const header = (
    <>
      {props.topFadeEnabled ? TIMELINE_LIST_FADE_HEADER : TIMELINE_LIST_HEADER}
      {history ? <TimelineHistoryControl {...history} /> : null}
    </>
  );
  const footer = (
    <>
      {props.sending ? <SendingRow input={props.sending} /> : null}
      <div aria-hidden={!props.working}>
        {props.working ? <WorkingRow /> : null}
        <div style={{ height: composerInset }} />
        <div className="h-3 sm:h-4" />
      </div>
    </>
  );
  const registerTimeline = useRegisterTimeline();
  const setList = (list: LegendListRef | null) => {
    listRef.current = list;
    registerTimeline(list?.getScrollableNode() ?? null);
  };
  const renderItem = ({ item }: { item: ChatMessage }) => (
    <div className="chat-content-lane overflow-x-clip">
      <ChatMessageRow message={item} />
    </div>
  );

  if (messages.length === 0 && !props.working && history === null) {
    return props.emptyPlaceholder === "blank" ? (
      // The theme surface keeps a loading chat from showing the window behind it.
      <div className="h-full min-h-0 bg-background" />
    ) : (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <TimelineCtx value={shared}>
      <TooltipScrollDismissArea ref={setViewport} className="relative h-full min-h-0">
        <LegendList<ChatMessage>
          ref={setList}
          data={messages}
          keyExtractor={keyExtractor}
          getItemType={getItemType}
          renderItem={renderItem}
          estimatedItemSize={90}
          initialScrollAtEnd
          maintainScrollAtEnd={props.liveFollowEnabled ? TIMELINE_MAINTAIN_SCROLL_AT_END : false}
          maintainVisibleContentPosition
          maintainScrollAtEndThreshold={1}
          onScroll={handleScroll}
          onItemSizeChanged={reportOverflow}
          className={cn(
            "messages-timeline-scroll scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain [overflow-anchor:none]",
            props.topFadeEnabled && "topbar-scroll-fade",
          )}
          ListHeaderComponent={header}
          ListFooterComponent={footer}
        />
      </TooltipScrollDismissArea>
    </TimelineCtx>
  );
});

function TimelineHistoryControl(props: ChatTimelineHistory) {
  return (
    <div className="chat-content-lane flex flex-col items-center gap-1.5 pb-2">
      {props.hasEarlier ? (
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={props.loading}
          onClick={props.onLoadEarlier}
        >
          {props.loading ? "Loading earlier messages…" : "Load earlier messages"}
        </Button>
      ) : null}
      {props.error !== null ? (
        <p role="status" className="text-center text-muted-foreground text-xs">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

function WorkingRow() {
  return (
    <div className="chat-content-lane">
      <div role="status" className="flex h-6 items-center px-1 pb-2 text-sm text-muted-foreground">
        Working…
      </div>
    </div>
  );
}

function MessageTime({ at }: { at: DateTime.Utc }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
        {formatDayAwareTimestamp(at)}
      </TooltipTrigger>
      <TooltipPopup>{formatChatTimestampTooltip(at)}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * A message read cut short loads whole on demand, through `chats.getMessage`. Only a finished one
 * does: a whole copy of a live message would stop following it.
 */
function useWholeMessage(message: ChatMessage) {
  const { chatId } = use(TimelineCtx);
  const [wanted, setWanted] = useState(false);
  const loadable = message.isTruncated && message.state !== "live";
  const query = useApiQuery(
    wanted && loadable
      ? chats.message({ chatId, sessionId: message.sessionId, messageId: message.message.id })
      : null,
  );
  const whole = loadable && query.data?.message.id === message.message.id ? query.data : null;
  return {
    message: whole ?? message,
    cut: message.isTruncated && whole === null,
    /** Whether loading it is held back until the message finishes, or under way. */
    waiting: query.isPending || (message.isTruncated && !loadable),
    error: query.error,
    loadWhole: () => setWanted(true),
  };
}

type WholeMessage = ReturnType<typeof useWholeMessage>;

const ChatMessageRow = memo(function ChatMessageRow({ message }: { message: ChatMessage }) {
  return (
    <div data-message-row className="pb-4">
      <MessageBody message={message} />
    </div>
  );
});

function MessageBody({ message }: { message: ChatMessage }) {
  const native = message.message;
  switch (native.type) {
    case "user":
      return <UserMessageRow message={message} />;
    case "assistant":
      return <AssistantMessageRow message={message} />;
    case "shell":
      return <ShellMessageRow message={message} />;
    case "compaction":
      return (
        <TimelineDivider
          icon={Minimize2Icon}
          label={
            native.status === "running"
              ? "Compacting the conversation…"
              : native.status === "failed"
                ? `Compacting failed: ${native.error.message}`
                : "Conversation compacted"
          }
        />
      );
    case "idle":
      return native.outcome === "failed" ? (
        <TimelineDivider icon={CircleAlertIcon} label="The agent stopped on an error" />
      ) : (
        <TimelineDivider icon={CircleStopIcon} label="Interrupted" />
      );
    case "synthetic":
    case "system":
      return <NoteRow message={message} text={native.description ?? native.text} />;
    case "skill":
      return <NoteRow message={message} text={`Loaded the ${native.name} skill`} />;
    case "agent-switched":
      return <NoteRow message={message} text={`Switched to the ${native.agent} agent`} />;
    case "model-switched":
      return <NoteRow message={message} text={`Switched to ${native.model.id}`} />;
    case "location-switched":
      return null;
  }
}

function InterruptedBadge() {
  return (
    <Badge variant="warning" size="sm">
      Interrupted
    </Badge>
  );
}

function TimelineDivider({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div
      role="separator"
      aria-label={label}
      className="flex w-full items-center gap-3 py-1 text-muted-foreground text-xs"
    >
      <span className="h-px flex-1 bg-border/70" />
      <span className="flex shrink-0 items-center gap-1.5">
        <Icon aria-hidden="true" className="size-3" />
        {label}
      </span>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}

/** A line T45 or OpenCode added to the conversation: a restore note, a skill, a switch. */
function NoteRow({ message, text }: { message: ChatMessage; text: string }) {
  const ctx = use(TimelineCtx);
  const first = firstLine(text);
  return (
    <div className="pb-2">
      <WorkLogRow
        icon={<SparklesIcon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <span className="text-muted-foreground">
            {first}
            {message.state === "lost" ? " (interrupted)" : null}
          </span>
        }
        details={
          first.length < text.trim().length ? (
            <Markdown
              text={text}
              className="text-muted-foreground"
              lineBreaks
              onImageExpand={ctx.onImageExpand}
            />
          ) : undefined
        }
      />
    </div>
  );
}

const toolOutputClassName =
  "cursor-text whitespace-pre-wrap break-words font-mono text-secondary-label text-(length:--font-size-code) leading-relaxed select-text";

/** What a command or tool call ran and printed, cut to a preview it can show whole. */
function ToolOutput({
  command,
  output,
  whole,
}: {
  command: string | null;
  output: string;
  whole: WholeMessage;
}) {
  const [full, setFull] = useState(false);
  const preview = full ? { text: output, cut: false } : boundText(output);
  return (
    <>
      {command !== null ? (
        <div className={toolOutputClassName}>
          <ShellCommandBlock command={command} />
        </div>
      ) : null}
      <pre className={toolOutputClassName}>{preview.text || "No output"}</pre>
      {preview.cut || whole.cut ? (
        <LoadWholeButton
          whole={whole}
          label={full && whole.waiting ? "Loading the full output…" : "Show the full output"}
          onClick={() => {
            setFull(true);
            whole.loadWhole();
          }}
        />
      ) : null}
    </>
  );
}

function ShellMessageRow({ message }: { message: ChatMessage }) {
  const whole = useWholeMessage(message);
  const native = whole.message.message;
  if (native.type !== "shell") return null;
  return (
    <div className="pb-2">
      <WorkLogRow
        icon={<TerminalIcon className="size-3.5 text-icon-muted" aria-hidden />}
        label={<span className="font-mono">{native.command}</span>}
        trailing={message.state === "lost" ? <InterruptedBadge /> : null}
        details={
          <ToolOutput command={native.command} output={native.output?.output ?? ""} whole={whole} />
        }
      />
    </div>
  );
}

function LoadWholeButton({
  whole,
  label,
  onClick,
}: {
  whole: WholeMessage;
  label: string;
  onClick?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={whole.waiting}
        onClick={onClick ?? whole.loadWhole}
      >
        {label}
      </Button>
      {whole.error ? <span className="text-muted-foreground text-xs">{whole.error}</span> : null}
    </div>
  );
}

function UserMessageRow({ message }: { message: ChatMessage }) {
  const whole = useWholeMessage(message);
  const native = whole.message.message;
  if (native.type !== "user") return null;
  return (
    <UserBubble
      content={userMessageContent(native)}
      at={native.time.created}
      onExpand={whole.loadWhole}
    />
  );
}

/** A message on its way into the conversation, as the member's until the agent has it. */
function SendingRow({ input }: { input: PendingInput }) {
  // Its chips' records come with the message itself: until then they read as their labels.
  const content = {
    text: inlineContextReferencesToLabels(input.text),
    attachments: input.attachments,
    context: undefined,
  };
  return (
    <div className="chat-content-lane overflow-x-clip">
      <div data-message-row className="pb-4">
        <UserBubble content={content} at={input.createdAt} />
      </div>
    </div>
  );
}

/** A message the member sent: its pictures, its files, and its text with chips. */
function UserBubble({
  content,
  at,
  onExpand,
}: {
  content: UserMessageContent;
  at: DateTime.Utc;
  onExpand?: () => void;
}) {
  const { onImageExpand } = use(TimelineCtx);
  const images = content.attachments.flatMap((attachment) =>
    attachment.type === "image" ? [attachment] : [],
  );
  const files = content.attachments.flatMap((attachment) =>
    attachment.type === "file" ? [attachment] : [],
  );
  const gallery = images.map((image) => ({ src: attachmentUrl(image), name: image.name }));
  const openImage = (index: number) => onImageExpand({ images: gallery, index });
  const recordsById = new Map<string, ChatContextRecord>(
    (content.context?.records ?? []).map((record) => [record.contextId, record]),
  );
  const renderContextReference = (reference: MarkdownContextReference) => {
    const record = recordsById.get(reference.contextId);
    const imageIndex =
      reference.kind === "image" && record?.kind === "image"
        ? images.findIndex((each) => each.id === record.attachmentId)
        : -1;
    if (record && imageIndex >= 0) {
      return (
        <ImageChipButton
          name={record.name}
          previewUrl={gallery[imageIndex]?.src}
          size={formatAttachmentSize(record.sizeBytes)}
          onClick={() => openImage(imageIndex)}
        />
      );
    }
    const file =
      reference.kind === "file" && record?.kind === "file"
        ? files.find((each) => each.id === record.attachmentId)
        : undefined;
    if (file && record) {
      const size = formatAttachmentSize(record.sizeBytes);
      return (
        <FileChip
          name={record.name}
          size={size}
          href={attachmentUrl(file)}
          tooltip={`${record.name}\n${size}`}
        />
      );
    }
    return (
      <UnresolvedChip label={reference.label} tooltip="This context is no longer available." />
    );
  };
  // A file with a chip in the prose needs no row of its own; pictures always show.
  const chipped = new Set(
    collectComposerContextReferences(content.text).flatMap((occurrence) => {
      const record = recordsById.get(occurrence.contextId);
      return record ? [record.attachmentId] : [];
    }),
  );
  const unchippedFiles = files.filter((file) => !chipped.has(file.id));

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
        <MessageAuthorHeading>You</MessageAuthorHeading>
        {images.length > 0 ? (
          <div className="mb-2 grid max-w-[210px] grid-cols-2 gap-2">
            {images.map((image, index) => (
              <button
                key={image.id}
                type="button"
                aria-label={`Open ${image.name}`}
                onClick={() => openImage(index)}
                className="aspect-4/3 cursor-zoom-in overflow-hidden rounded-lg border border-border/80 bg-background/70"
              >
                <img
                  src={gallery[index]?.src}
                  alt={image.name}
                  className="block size-full object-cover"
                />
              </button>
            ))}
          </div>
        ) : null}
        {unchippedFiles.length > 0 ? (
          <div className="mb-2 flex flex-col gap-1">
            {unchippedFiles.map((file) => (
              <a
                key={file.id}
                href={attachmentUrl(file)}
                download={file.name}
                aria-label={`Download ${file.name}`}
                className="focus-visible:ring-ring/70 flex min-w-0 items-center gap-2 rounded-md py-1 text-left text-sm hover:underline focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
              >
                <FileIcon className="size-4 shrink-0 text-icon-muted" />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <DownloadIcon className="size-4 shrink-0" />
              </a>
            ))}
          </div>
        ) : null}
        <CollapsibleUserMessageBody
          text={content.text}
          renderContextReference={renderContextReference}
          onExpand={onExpand}
        />
      </div>
      <div className="message-actions w-full max-w-[80%] justify-end pe-1">
        <MessageTime at={at} />
        {content.text ? (
          <CopyButton
            text={replaceComposerContextReferences(content.text, (reference) => reference.label)}
            label="Copy message"
          />
        ) : null}
      </div>
    </div>
  );
}

function AssistantMessageRow({ message }: { message: ChatMessage }) {
  const ctx = use(TimelineCtx);
  const whole = useWholeMessage(message);
  const native = whole.message.message;
  if (native.type !== "assistant") return null;
  const live = message.state === "live";
  const lastTextIndex = native.content.findLastIndex((part) => part.type === "text");
  const copyText = live ? "" : assistantText(native);
  const parts = (
    <div className="flex min-w-0 flex-col gap-2">
      {native.content.length === 0 && live ? (
        <WorkLogRow
          icon={<BrainIcon className="size-3.5 text-icon-muted" aria-hidden />}
          label="Thinking…"
        />
      ) : null}
      {native.content.map((part, index) =>
        part.type === "text" ? (
          <Markdown
            // Text and reasoning parts have no ids and only ever grow at the end.
            // oxlint-disable-next-line react/no-array-index-key
            key={index}
            text={part.text}
            isStreaming={live && index === lastTextIndex}
            onImageExpand={ctx.onImageExpand}
          />
        ) : part.type === "reasoning" ? (
          // oxlint-disable-next-line react/no-array-index-key -- parts only grow at the end
          <ReasoningPart key={index} text={part.text} />
        ) : isWorkflowDraftCall(part) ? (
          // A workflow drafted in a chat is a card its member can create it from.
          <WorkflowDraftPart key={part.id} part={part} message={message} whole={whole} />
        ) : (
          <ToolRow key={part.id} part={part} message={message} whole={whole} />
        ),
      )}
    </div>
  );
  return (
    <div className="relative min-w-0 px-1 py-0.5">
      <MessageAuthorHeading>Agent</MessageAuthorHeading>
      {parts}
      {native.error ? (
        <div
          role="alert"
          className="mt-1 flex items-start gap-1.5 text-destructive-foreground text-sm"
        >
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{native.error.message}</span>
        </div>
      ) : null}
      {!live ? (
        <div className="message-actions mt-1.5" data-lost={message.state === "lost"}>
          {message.state === "lost" ? <InterruptedBadge /> : null}
          {copyText ? <CopyButton text={copyText} label="Copy message" /> : null}
          <MessageTime at={native.time.created} />
        </div>
      ) : null}
      {whole.cut && native.content.some((part) => part.type === "text") ? (
        <LoadWholeButton whole={whole} label="Show the whole message" />
      ) : null}
    </div>
  );
}

function ReasoningPart({ text }: { text: string }) {
  const ctx = use(TimelineCtx);
  if (text.trim().length === 0) return null;
  return (
    <WorkLogRow
      icon={<BrainIcon className="size-3.5 text-icon-muted" aria-hidden />}
      label="Thinking"
      details={
        <Markdown text={text} className="text-muted-foreground" onImageExpand={ctx.onImageExpand} />
      }
    />
  );
}

interface ToolPartProps {
  part: NativeToolPart;
  message: ChatMessage;
  whole: WholeMessage;
}

function ToolRow({ part, message, whole }: ToolPartProps) {
  const ctx = use(TimelineCtx);
  const label = toolLabel(part);
  const status = part.state.status;
  const failed = status === "error";
  const unfinished = status === "streaming" || status === "running";
  const childSession = subagentSessionId(part);
  const child = childSession
    ? ctx.sessions.find((session) => session.id === childSession)
    : undefined;
  const command =
    part.name === "bash" && part.state.status !== "streaming" ? part.state.input["command"] : null;
  const Icon =
    part.name === "subagent" ? BotIcon : part.name === "bash" ? TerminalIcon : WrenchIcon;
  return (
    <WorkLogRow
      icon={
        <Icon
          className={cn("size-3.5", failed ? "text-destructive/70" : "text-icon-muted")}
          aria-hidden
        />
      }
      label={
        <span>
          <span className="text-foreground/80">{child?.title || label.name}</span>
          {label.subject ? <span> {label.subject}</span> : null}
          {unfinished && message.state === "live" ? <span> …</span> : null}
        </span>
      }
      trailing={
        <span className="flex shrink-0 items-center gap-1">
          {unfinished && message.state === "lost" ? <InterruptedBadge /> : null}
          {failed ? (
            <Badge variant="error" size="sm">
              Failed
            </Badge>
          ) : null}
          {childSession && child ? (
            <Button size="xs" variant="ghost-muted" onClick={() => ctx.onOpenSession(child.id)}>
              Open
            </Button>
          ) : null}
        </span>
      }
      details={
        <ToolOutput
          command={typeof command === "string" ? command : null}
          output={toolOutputText(part)}
          whole={whole}
        />
      }
    />
  );
}

/**
 * A workflow the agent drafted, as a card made from the draft whole: a read cuts long strings,
 * which would cut the workflow's instructions short. A draft that doesn't decode stays a tool row.
 */
function WorkflowDraftPart({ part, message, whole }: ToolPartProps) {
  const ctx = use(TimelineCtx);
  const { cut, waiting, loadWhole } = whole;
  useEffect(() => {
    if (cut && !waiting) loadWhole();
  }, [cut, loadWhole, waiting]);
  if (cut) {
    return (
      <WorkLogRow
        icon={<WrenchIcon className="size-3.5 text-icon-muted" aria-hidden />}
        label={whole.error ?? "Loading the workflow draft…"}
      />
    );
  }
  const native = whole.message.message;
  const drafted =
    native.type === "assistant"
      ? native.content.find((each) => each.type === "tool" && each.id === part.id)
      : undefined;
  const draft = workflowDraftOf(drafted?.type === "tool" ? drafted : part);
  if (draft === null) return <ToolRow part={part} message={message} whole={whole} />;
  return (
    <WorkflowDraftCard itemId={`${ctx.chatId}:${message.sessionId}:${part.id}`} draft={draft} />
  );
}

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;

function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) return false;
  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    text.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

function CollapsibleUserMessageBody(props: {
  text: string;
  renderContextReference: (reference: MarkdownContextReference) => ReactNode;
  onExpand: (() => void) | undefined;
}) {
  const ctx = use(TimelineCtx);
  const [expanded, setExpanded] = useState(false);
  if (props.text.trim().length === 0) return null;
  const canCollapse = shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;
  return (
    <div>
      <div
        className={cn(
          "relative",
          isCollapsed &&
            "max-h-44 overflow-hidden mask-t-from-transparent mask-t-from-0 mask-t-to-black mask-t-to-7",
        )}
      >
        <Markdown
          text={props.text}
          className="text-foreground"
          lineBreaks
          parseRawHtml={false}
          renderContextReference={props.renderContextReference}
          onImageExpand={ctx.onImageExpand}
        />
      </div>
      {canCollapse ? (
        <div className="mt-1.5 flex items-center justify-end gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded(!expanded);
              if (!expanded) props.onExpand?.();
            }}
          >
            {expanded ? "Show less" : "Show full message"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
