import type { ReactNode } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

const ROW = "relative w-full min-w-0 px-0.5 py-0.5";
const LINE = "flex min-h-6 min-w-0 items-center gap-1.5 text-sm leading-relaxed select-none";

/**
 * One line of the work log. With `details` it is a disclosure: the line opens them under it,
 * while `trailing` actions sit beside it, outside the toggle.
 */
export function WorkLogRow({
  icon,
  label,
  trailing,
  details,
}: {
  icon: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  details?: ReactNode;
}) {
  const line = (
    <>
      <span className="relative flex size-6 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-secondary-label">{label}</span>
    </>
  );
  if (details === undefined) {
    return (
      <div className={ROW}>
        <div className={LINE}>
          {line}
          {trailing}
        </div>
      </div>
    );
  }
  return (
    <Collapsible render={<div className={ROW} />}>
      <div className={LINE}>
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none focus-visible:ring-inset">
          {line}
        </CollapsibleTrigger>
        {trailing}
      </div>
      <CollapsiblePanel>
        <div className="ms-7 flex max-h-96 cursor-auto flex-col gap-3 overflow-auto px-0.5 py-1 select-text">
          {details}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
