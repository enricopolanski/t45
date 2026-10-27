import { createFileRoute } from "@tanstack/react-router";

import { AgentChatsPage } from "../components/chats/AgentChatsPage";

export const Route = createFileRoute("/chats/")({
  component: AgentChatsPage,
});
