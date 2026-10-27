import type { ReactNode } from "react";

import { BackLink, WorkFrame } from "../work/WorkFrame";

/**
 * The page shell every /agents page shares: the work pages' frame, with a back link to the list
 * on the pages below it.
 */
export function AgentsFrame({
  title,
  back,
  children,
}: {
  readonly title: string;
  /** False on the list. */
  readonly back: boolean;
  readonly children: ReactNode;
}) {
  return (
    <WorkFrame title={title} back={back ? <BackLink to="/agents">Agents</BackLink> : null}>
      {children}
    </WorkFrame>
  );
}
