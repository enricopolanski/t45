import { Session } from "@opencode/schema/session";
import { ChatId } from "@t45/contracts/models/Chat";
import { StringId } from "@t45/contracts/models/primitives";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import ChatView from "../components/ChatView";
import { SidebarInset } from "../components/ui/sidebar";

const isChatId = Schema.is(ChatId);
const isSessionId = Schema.is(Session.ID);
const isStringId = Schema.is(StringId);

function ChatRouteView() {
  const { chatId } = Route.useParams();
  const { session, agent, workflow } = Route.useSearch();
  if (!isChatId(chatId)) return <Navigate to="/chats" replace />;
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      <ChatView
        chatId={chatId}
        sessionId={session ?? null}
        newAgentId={agent ?? null}
        newWorkflowId={workflow ?? null}
      />
    </SidebarInset>
  );
}

// `session` opens one of the chat's subagent sessions, read only, instead of its root. `agent`
// starts a chat T45 lacks yet with that agent at its first message.
export const Route = createFileRoute("/chats/$chatId")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { session?: Session.ID; agent?: StringId; workflow?: StringId } => ({
    ...(isSessionId(search.session) ? { session: search.session } : {}),
    ...(isStringId(search.agent) ? { agent: search.agent } : {}),
    ...(isStringId(search.workflow) ? { workflow: search.workflow } : {}),
  }),
  component: ChatRouteView,
});
