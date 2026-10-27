import type { Session } from "@opencode/schema/session";
import { type Agent, canChatWithMembers } from "@t45/contracts/models/Agent";
import { ChatId } from "@t45/contracts/models/Chat";
import { useRouter } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { useCallback } from "react";

import { newChatId } from "../lib/utils";
import { call, runtime } from "../rpc/api";
import { appAtomRegistry } from "../state/atomRegistry";
import { chatSessionKey, chats, type ChatSessionKey, type ChatSessionView } from "../state/chats";

const isChatId = Schema.is(ChatId);

interface ChatRouter {
  readonly state: {
    readonly matches: ReadonlyArray<{ readonly params: Partial<Record<string, string>> }>;
    readonly location: {
      readonly search: { readonly session?: Session.ID; readonly agent?: Agent["id"] };
    };
  };
  readonly navigate: (options: {
    readonly to: "/chats/$chatId";
    readonly params: { readonly chatId: ChatId };
    readonly search: { readonly agent: Agent["id"] };
  }) => Promise<void>;
}

type ViewOf = (key: ChatSessionKey) => ChatSessionView;

/** The agent of the member chat on screen, once its view has loaded, or of the new one. */
function agentOnScreen(router: ChatRouter, viewOf: ViewOf) {
  const chatId = router.state.matches.at(-1)?.params.chatId;
  if (!isChatId(chatId)) return undefined;
  const view = viewOf(chatSessionKey(chatId, router.state.location.search.session));
  if (view.status !== "ready") return router.state.location.search.agent;
  return view.chat.agentId;
}

/**
 * Opens a new chat with `agentId`, else with the agent of the chat on screen, else with the first
 * agent members can chat with. T45 starts it at its first message.
 */
export const openNewChat = Effect.fnUntraced(function* (
  router: ChatRouter,
  viewOf: ViewOf,
  agentId?: Agent["id"],
) {
  const eligible = (yield* call("agents.list", undefined)).filter(canChatWithMembers);
  const preferred = agentId ?? agentOnScreen(router, viewOf);
  const agent = eligible.find((candidate) => candidate.id === preferred)?.id ?? eligible[0]?.id;
  if (agent === undefined) return;
  yield* Effect.promise(() =>
    router.navigate({
      to: "/chats/$chatId",
      params: { chatId: newChatId() },
      search: { agent },
    }),
  );
});

export function useNewChat() {
  const router = useRouter();
  return useCallback(
    (agentId?: Agent["id"]) =>
      runtime.runPromise(
        openNewChat(router, (key) => appAtomRegistry.get(chats.view(key)), agentId),
      ),
    [router],
  );
}
