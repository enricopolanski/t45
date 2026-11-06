import type { Session } from "@opencode/schema/session";
import { type Agent } from "@t45/contracts/models/Agent";
import { NotFound } from "@t45/contracts/resources/errors";
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
  return view.status === "ready"
    ? { agentId: view.chat.agentId, workflowId: view.chat.workflowId }
    : {
        agentId: router.state.location.search.agent,
        workflowId: router.state.location.search.workflow ?? null,
      };
}

/** Starts with the chosen target, preserves the current workflow, or chooses the first available target. */
export const openNewChat = Effect.fnUntraced(function* (
  router: ChatRouter,
  viewOf: ViewOf,
  agentId?: Agent["id"],
  workflowId: string | null = null,
) {
  const eligible = yield* call("chats.listTargets", undefined);
  const preferred =
    agentId === undefined ? targetOnScreen(router, viewOf) : { agentId, workflowId };
  const matching = eligible.find(
    (candidate) =>
      candidate.agentId === preferred?.agentId && candidate.workflowId === preferred.workflowId,
  );
  if (matching === undefined && (agentId !== undefined || preferred?.workflowId != null))
    return yield* new NotFound();
  const target = matching ?? eligible[0];
  if (target === undefined) return;
  yield* Effect.promise(() =>
    router.navigate({
      to: "/chats/$chatId",
      params: { chatId: newChatId() },
      search: {
        agent: target.agentId,
        ...(target.workflowId === null ? {} : { workflow: target.workflowId }),
      },
    }),
  );
});

export function useNewChat() {
  const router = useRouter();
  return useCallback(
    (agentId?: Agent["id"], workflowId: string | null = null) =>
      runtime.runPromise(
        openNewChat(router, (key) => appAtomRegistry.get(chats.view(key)), agentId, workflowId),
      ),
    [router],
  );
}
