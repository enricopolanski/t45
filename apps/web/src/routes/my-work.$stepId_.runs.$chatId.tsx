import { ChatId } from "@t45/contracts/models/Chat";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { RunPage } from "../components/work/RunPage";

const isChatId = Schema.is(ChatId);

function RunRouteView() {
  const { stepId, chatId } = Route.useParams();
  if (!isChatId(chatId)) return <Navigate to="/my-work/$stepId" params={{ stepId }} replace />;
  return <RunPage key={chatId} stepId={stepId} chatId={chatId} />;
}

export const Route = createFileRoute("/my-work/$stepId_/runs/$chatId")({
  component: RunRouteView,
});
