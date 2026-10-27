import { useState } from "react";

import type { ComposerTrigger } from "../../composerPrompt";

/** Keep a dismissed suggestion closed until the caret leaves its token. */
export function useComposerTriggerState(initialTrigger: () => ComposerTrigger | null) {
  const [state, setState] = useState<{
    trigger: ComposerTrigger | null;
    dismissedAt: number | null;
  }>(() => ({ trigger: initialTrigger(), dismissedAt: null }));

  const resolveTrigger = (candidate: ComposerTrigger | null) =>
    candidate && candidate.rangeStart === state.dismissedAt ? null : candidate;

  const setTrigger = (candidate: ComposerTrigger | null) => {
    const trigger = resolveTrigger(candidate);
    setState({
      trigger,
      dismissedAt: candidate === null || trigger !== null ? null : state.dismissedAt,
    });
  };

  const dismissTrigger = (candidate: ComposerTrigger | null) =>
    setState({ trigger: null, dismissedAt: candidate?.rangeStart ?? null });

  const resetTrigger = (trigger: ComposerTrigger | null) =>
    setState({ trigger, dismissedAt: null });

  return { trigger: state.trigger, setTrigger, resolveTrigger, dismissTrigger, resetTrigger };
}
