import type { Agent } from "@t45/contracts/models/Agent";

import type { ApiInput } from "../../rpc/api";

export interface DraftState {
  readonly title: string;
  readonly prompt: string;
  /** The agent each run talks to; null until one is picked. */
  readonly agentId: Agent["id"] | null;
}

export const EMPTY_DRAFT: DraftState = { title: "", prompt: "", agentId: null };

type Problem = { readonly problem: { readonly title: string; readonly description: string } };

export function settingsFromDraft(
  draft: DraftState,
): { readonly settings: ApiInput<"automations.create"> } | Problem {
  const title = draft.title.trim();
  const prompt = draft.prompt.trim();
  if (!title || !prompt || draft.agentId === null) {
    return {
      problem: {
        title: "Automation is incomplete",
        description: "Add a title, prompt, and agent.",
      },
    };
  }
  return { settings: { title, prompt, agentId: draft.agentId } };
}
