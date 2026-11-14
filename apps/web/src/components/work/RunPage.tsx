import type { LegendListRef } from "@legendapp/list/react";
import { TokenUsage } from "@opencode/schema/token-usage";
import type { ChatId } from "@t45/contracts/models/Chat";
import { StringId } from "@t45/contracts/models/primitives";
import type { ChatSession } from "@t45/contracts/resources/Chats";
import type { StepView } from "@t45/contracts/resources/Workflows";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { describeFailure } from "../../lib/failures";
import { stepAutomationList } from "../../state/agents";
import { chatSessionKey, chats, useChatSessionView } from "../../state/chats";
import { useApiQuery } from "../../state/rpc";
import { stepViews } from "../../state/work";
import {
  formatDayAwareTimestamp,
  formatDurationLabel,
  formatRelativeTimeLabel,
} from "../../timestampFormat";
import { ChatCanvas } from "../chat/ChatCanvas";
import { type ChatSessionSummary, useChatSessionSummary } from "../chat/chatSessionSummary";
import { ChatTimeline } from "../chat/ChatTimeline";
import { ExpandedImageDialog, type ImageGallery } from "../chat/ExpandedImageDialog";
import { Badge } from "../ui/badge";
import { ErrorText } from "../ui/error-text";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import { RUN_STATUSES } from "./StepPage";
import { useWorkDirectory } from "./useWorkDirectory";
import { BackLink, WorkFrame } from "./WorkFrame";
import { actorName } from "./workLogic";

const isStepId = Schema.is(StringId);
const tokenCount = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
// To a hundredth of a cent: a short run costs less than a cent.
const usd = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});
// The session shows without its subagents' sessions: a run's page opens none of them.
const NO_SESSIONS: ReadonlyArray<ChatSession> = [];
const ignore = () => {};

/**
 * One run of an automation on a step: how it stands and what it used, then the run at three
 * depths: what it reported, the tools it called, and its whole session.
 */
export function RunPage({ stepId, chatId }: { readonly stepId: string; readonly chatId: ChatId }) {
  const { data: view, error } = useApiQuery(isStepId(stepId) ? stepViews({ stepId }) : null);
  const titles = useApiQuery(stepAutomationList);
  const automation = view?.automations.find(({ runs }) =>
    runs.some((run) => run.chatId === chatId),
  );
  const at = automation?.runs.findIndex((run) => run.chatId === chatId) ?? -1;
  const run = automation?.runs[at];
  if (view === null || error !== null || automation === undefined || run === undefined) {
    return (
      <WorkFrame title="Run">
        {view === null && error === null && isStepId(stepId) ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ErrorText text={error ?? "This run could not be found."} />
        )}
      </WorkFrame>
    );
  }
  // Runs are listed newest first, and numbered from the automation's first on the step.
  const number = automation.runs.length - at;
  const title =
    titles.data?.find(({ id }) => id === automation.id)?.title ?? "Unavailable automation";
  const { label, Icon, tone } = RUN_STATUSES[run.status];
  return (
    <WorkFrame title={`${title} #${number}`}>
      <header className="flex flex-col gap-3">
        <BackLink to="/my-work/$stepId" params={{ stepId }}>
          {view.ticket.title}
        </BackLink>
        <h2 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <span role="img" aria-label={label} className="flex shrink-0">
            <Icon aria-hidden className={`size-6 ${tone}`} />
          </span>
          {title}
          <span className="font-normal text-muted-foreground">#{number}</span>
        </h2>
      </header>
      <RunSummary run={run} />
      <RunHistory chatId={chatId} />
    </WorkFrame>
  );
}

/** The run at a glance: who started it and when, how it stands, and what it used. */
function RunSummary({ run }: { readonly run: StepView["automations"][number]["runs"][number] }) {
  const directory = useWorkDirectory();
  const now = useNowMinute();
  // Every token the run counted: input, output, reasoning, and cache reads and writes.
  const used = TokenUsage.total(run.tokens);
  return (
    <section
      aria-label="Summary"
      className="grid grid-cols-2 gap-4 rounded-xl border bg-card p-4 text-sm sm:grid-cols-[2fr_repeat(4,1fr)]"
    >
      <Fact label={`Manually triggered ${formatRelativeTimeLabel(run.startedAt, now)}`}>
        {actorName(directory, run.ranBy)}
      </Fact>
      <Fact label="Status">{RUN_STATUSES[run.status].label}</Fact>
      <Fact label="Total duration">
        {run.endedAt === null ? "In progress" : formatDurationLabel(run.startedAt, run.endedAt)}
      </Fact>
      <Fact label="Tokens">{used === 0 ? "–" : tokenCount.format(used)}</Fact>
      <Fact label="Cost">{used === 0 ? "–" : usd.format(run.cost)}</Fact>
    </section>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <p className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate font-semibold">{children}</span>
    </p>
  );
}

/** The run's history, as one of three views of its chat. */
function RunHistory({ chatId }: { readonly chatId: ChatId }) {
  const session = useChatSessionSummary(chatSessionKey(chatId));
  if (session.status === "loading") {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (session.status === "failed") return <ErrorText text={describeFailure(session.error)} />;
  const reports = session.chat.reports ?? [];
  return (
    <Tabs defaultValue="Reports">
      <TabsList className="self-start">
        {["Reports", "Tool calls", "Session"].map((name) => (
          <TabsTab key={name} value={name} className="flex-none">
            {name}
          </TabsTab>
        ))}
      </TabsList>
      <TabsPanel value="Reports">
        {reports.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reports.</p>
        ) : (
          <ol className="overflow-hidden rounded-xl border bg-card text-sm">
            {reports.map((report, at) => (
              // oxlint-disable-next-line react/no-array-index-key -- Reports only grow at the end.
              <li key={at} className="flex flex-col gap-0.5 border-t px-4 py-3 first:border-t-0">
                <p className="wrap-break-word">{report.message}</p>
                <time
                  dateTime={DateTime.formatIso(report.at)}
                  className="text-xs text-muted-foreground"
                >
                  {formatDayAwareTimestamp(report.at)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </TabsPanel>
      <TabsPanel value="Tool calls">
        <RunToolCalls chatId={chatId} />
      </TabsPanel>
      <TabsPanel value="Session">
        <RunSession chatId={chatId} session={session} />
      </TabsPanel>
    </Tabs>
  );
}

/** Every tool the run's session called, oldest first: the session loads whole to list them all. */
function RunToolCalls({ chatId }: { readonly chatId: ChatId }) {
  const session = useChatSessionView(chatSessionKey(chatId));
  const hasEarlierToLoad =
    session.status === "ready" && session.hasEarlier && session.earlierError === null;
  const shouldLoadEarlier = hasEarlierToLoad && !session.loadingEarlier;
  useEffect(() => {
    if (shouldLoadEarlier) void chats.loadEarlier(chatSessionKey(chatId));
  }, [shouldLoadEarlier, chatId]);
  if (session.status !== "ready") return null;
  const calls = session.messages.flatMap(({ message }) =>
    message.type !== "assistant"
      ? []
      : message.content.flatMap((part) =>
          part.type !== "tool" ? [] : [{ ...part, key: `${message.id} ${part.id}` }],
        ),
  );
  return (
    <div className="flex flex-col gap-2 text-sm">
      {session.earlierError !== null && <ErrorText text={session.earlierError} />}
      {hasEarlierToLoad && <p className="text-muted-foreground">Loading earlier tool calls…</p>}
      {calls.length === 0 ? (
        <p className="text-muted-foreground">No tool calls.</p>
      ) : (
        <ol className="overflow-hidden rounded-xl border bg-card">
          {calls.map(({ key, name, state, time }) => (
            <li key={key} className="flex items-baseline gap-3 border-t px-4 py-2 first:border-t-0">
              <time
                dateTime={DateTime.formatIso(time.created)}
                className="shrink-0 text-xs text-muted-foreground tabular-nums"
              >
                {formatDayAwareTimestamp(time.created)}
              </time>
              <span className="shrink-0 font-medium">{name}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {state.status === "streaming" ? state.input : JSON.stringify(state.input)}
              </span>
              {state.status === "error" && (
                <Badge variant="error" size="sm">
                  Failed
                </Badge>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The run's session as its chat keeps it, read only. */
function RunSession({
  chatId,
  session,
}: {
  readonly chatId: ChatId;
  readonly session: Extract<ChatSessionSummary, { status: "ready" }>;
}) {
  const listRef = useRef<LegendListRef | null>(null);
  const [isFollowingEnd, setIsFollowingEnd] = useState(true);
  const [expandedImage, setExpandedImage] = useState<ImageGallery | null>(null);
  const sessionKey = chatSessionKey(chatId);
  return (
    <div className="flex h-[70dvh] flex-col overflow-hidden rounded-xl border">
      <ChatCanvas>
        <div className="relative flex min-h-0 flex-1 flex-col bg-background">
          <ChatTimeline
            chatId={chatId}
            sessionKey={sessionKey}
            sessions={NO_SESSIONS}
            working={session.chat.status === "running" && !session.replying}
            sending={null}
            listRef={listRef}
            history={
              session.hasEarlier || session.earlierError !== null
                ? {
                    hasEarlier: session.hasEarlier,
                    loading: session.loadingEarlier,
                    error: session.earlierError,
                    onLoadEarlier: () => void chats.loadEarlier(sessionKey),
                  }
                : null
            }
            onImageExpand={setExpandedImage}
            onOpenSession={ignore}
            composerInset={0}
            liveFollowEnabled={isFollowingEnd}
            onIsAtEndChange={setIsFollowingEnd}
            onContentOverflowChange={ignore}
            emptyPlaceholder="blank"
            topFadeEnabled={false}
          />
        </div>
      </ChatCanvas>
      {expandedImage ? (
        <ExpandedImageDialog gallery={expandedImage} onClose={() => setExpandedImage(null)} />
      ) : null}
    </div>
  );
}
