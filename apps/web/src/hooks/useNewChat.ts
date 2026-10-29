import type { Session } from "@opencode/schema/session";
import { type Agent } from "@t45/contracts/models/Agent";
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
      readonly search: {
        readonly session?: Session.ID;
        readonly agent?: Agent["id"];
        readonly workflow?: string;
      };
    };
  };
  readonly navigate: (options: {
    readonly to: "/chats/$chatId";
    readonly params: { readonly chatId: ChatId };
    readonly search: { readonly agent: Agent["id"]; readonly workflow?: string };
  }) => Promise<void>;
}

type ViewOf = (key: ChatSessionKey) => ChatSessionView;

/** The agent of the member chat on screen, once its view has loaded, or of the new one. */
function targetOnScreen(router: ChatRouter, viewOf: ViewOf) {
  const chatId = router.state.matches.at(-1)?.params.chatId;
  if (!isChatId(chatId)) return undefined;
  const view = viewOf(chatSessionKey(chatId, router.state.location.search.session));
  if (view.status !== "ready")
    return {
      agentId: router.state.location.search.agent,
      workflowId: router.state.location.search.workflow,
    };
  return { agentId: view.chat.agentId, workflowId: view.chat.workflowId };
}

/**
 * Opens a new chat with `agentId`, else with the agent of the chat on screen, else with the first
 * agent members can chat with. T45 starts it at its first message.
 */
export const openNewChat = Effect.fnUntraced(function* (
  router: ChatRouter,
  viewOf: ViewOf,
  agentId?: Agent["id"],
  workflowId?: string,
) {
  const eligible = yield* call("chats.listTargets", undefined);
  const preferred =
    agentId !== undefined || workflowId !== undefined
      ? { agentId, workflowId }
      : targetOnScreen(router, viewOf);
  const target =
    eligible.find((candidate) =>
      preferred?.workflowId !== undefined
        ? candidate.workflowId === preferred.workflowId
        : candidate.workflowId === undefined && candidate.agentId === preferred?.agentId,
    ) ?? eligible[0];
  if (target === undefined) return;
  if (workflowId !== undefined && target.workflowId !== workflowId)
    throw new Error("This workflow is not available for chat.");
  yield* Effect.promise(() =>
    router.navigate({
      to: "/chats/$chatId",
      params: { chatId: newChatId() },
      search: {
        agent: target.agentId,
        ...(target.workflowId === undefined ? {} : { workflow: target.workflowId }),
      },
    }),
  );
});

export function useNewChat() {
  const router = useRouter();
  return useCallback(
    (agentId?: Agent["id"], workflowId?: string) =>
      runtime.runPromise(
        openNewChat(router, (key) => appAtomRegistry.get(chats.view(key)), agentId, workflowId),
      ),
    [router],
  );
}
