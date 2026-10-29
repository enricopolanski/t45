import type { Agent } from "@t45/contracts/models/Agent";
import { titleOf } from "@t45/contracts/models/Chat";
import type { ChatSummary } from "@t45/contracts/resources/Chats";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, MessageSquarePlusIcon } from "lucide-react";
import { useTransition } from "react";

import { useChatAgents } from "../../state/agents";
import { useNewChat } from "../../hooks/useNewChat";
import { useNowMinute } from "../../hooks/useNowMinute";
import { chats as chatAtoms } from "../../state/chats";
import { toastFailure } from "../../state/query";
import { useApiQuery } from "../../state/rpc";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { WorkFrame } from "../work/WorkFrame";

/**
 * Chat: the chats with agents the signed-in member can open (an admin's include the automation
 * runs), most recent activity first as the server orders them, and a way to start one with any
 * agent the organization set up for chat. Each chat runs on its own VM on the runner.
 */
export function AgentChatsPage() {
  const chatsQuery = useApiQuery(chatAtoms.list);
  const agents = useChatAgents();
  const chats = chatsQuery.data?.chats ?? [];

  return (
    <WorkFrame title="Chat" actions={<NewChatMenu agents={agents} />}>
      <div className="flex flex-col gap-2">
        {chats.length > 0 ? (
          chats.map((item) => <AgentChatRow key={item.id} item={item} />)
        ) : chatsQuery.error ? (
          // A failed load must not read as "no chats".
          <ErrorText
            className="my-10 text-center"
            text={`Could not load chats: ${chatsQuery.error}`}
          />
        ) : chatsQuery.data === null ? null : (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {agents.length === 0
              ? "No agents are set up for chat yet. Admins add them in Agents."
              : "No chats yet. Start one with an agent."}
          </p>
        )}
      </div>
    </WorkFrame>
  );
}

/** One chat: its title, the agent, and when it last moved. */
function AgentChatRow({ item }: { readonly item: ChatSummary }) {
  const now = useNowMinute();
  const title = titleOf(item);
  return (
    <Link
      to="/chats/$chatId"
      params={{ chatId: item.id }}
      aria-label={`Open ${title}`}
      className="flex flex-col gap-1 rounded-lg border border-border/70 bg-background px-3 py-2 outline-hidden hover:border-border focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="truncate text-sm font-medium text-foreground">{title}</span>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="truncate">{item.agentName ?? "An agent"}</span>
        <span className="ml-auto shrink-0">
          {formatRelativeTimeLabel(item.lastActivityAt, now)}
        </span>
      </span>
    </Link>
  );
}

/** Starts a new chat with the picked agent. */
function NewChatMenu({ agents }: { readonly agents: ReadonlyArray<Agent> }) {
  const newChat = useNewChat();
  const [starting, startTransition] = useTransition();
  const start = (agentId: Agent["id"]) =>
    startTransition(() =>
      newChat(agentId).catch((cause: unknown) => toastFailure("Couldn't start a chat", cause)),
    );

  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" disabled={agents.length === 0 || starting} />}>
        <MessageSquarePlusIcon />
        New chat
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        {agents.map((agent) => (
          <MenuItem key={agent.id} onClick={() => start(agent.id)}>
            {agent.name}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
