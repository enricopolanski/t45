import type { Agent } from "@t45/contracts/models/Agent";
import type { Phase, StepContext } from "@t45/contracts/models/Automation";

import type { ApiInput } from "../../rpc/api";

export interface DraftState {
  readonly title: string;
  readonly prompt: string;
  readonly stepContext?: StepContext;
  /** The agent each run talks to; null until one is picked. */
  readonly agentId: Agent["id"] | null;
  readonly firstPhaseTitle?: string;
  /** The phases after the first, each with its agent, null until one is picked. */
  readonly nextPhases?: ReadonlyArray<DraftPhase>;
}

export interface DraftPhase {
  readonly title?: string;
  readonly agentId: Agent["id"] | null;
  readonly prompt: string;
  readonly stepContext?: StepContext;
}

/** The form's state of a saved automation. */
export const draftOf = (
  automation: Omit<DraftState, "nextPhases"> & { readonly nextPhases?: ReadonlyArray<Phase> },
): DraftState => automation;

export const EMPTY_DRAFT: DraftState = { title: "", prompt: "", agentId: null };

type Problem = {
  readonly problem: {
    readonly title: "Automation is incomplete";
    readonly description:
      | "Add a title, prompt, and agent."
      | "Give every next phase an agent and a prompt, or remove it.";
  };
};

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
  const nextPhases = (draft.nextPhases ?? []).map(({ title: name = "", ...phase }) => ({
    ...phase,
    ...(name.trim() === "" ? {} : { title: name.trim() }),
    prompt: phase.prompt.trim(),
  }));
  // Only an automation with next phases names its first.
  const firstPhaseTitle = nextPhases.length === 0 ? "" : (draft.firstPhaseTitle?.trim() ?? "");
  if (nextPhases.some(({ agentId, prompt }) => agentId === null || !prompt)) {
    return {
      problem: {
        title: "Automation is incomplete",
        description: "Give every next phase an agent and a prompt, or remove it.",
      },
    };
  }
  return {
    settings: {
      title,
      prompt,
      agentId: draft.agentId,
      ...(draft.stepContext === undefined ? {} : { stepContext: draft.stepContext }),
      ...(firstPhaseTitle === "" ? {} : { firstPhaseTitle }),
      nextPhases: nextPhases.flatMap(({ agentId, ...phase }) =>
        agentId === null ? [] : [{ ...phase, agentId }],
      ),
    },
  };
}
