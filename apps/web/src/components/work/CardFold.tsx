import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

export function FoldChevron() {
  return (
    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 group-data-panel-open:rotate-90" />
  );
}

/**
 * A card whose title folds its content away and back, like a ticket's sections. Open at first;
 * `held` keeps it open.
 */
export function CardFold({
  title,
  as: Card = "section",
  held = false,
  children,
}: {
  readonly title: string;
  readonly as?: "aside" | "section";
  /** True keeps the content open, as when a field in it needs filling. */
  readonly held?: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Card aria-label={title} className="card p-4">
      <Collapsible open={open || held} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-left text-sm font-semibold">
          {title}
          <FoldChevron />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="flex flex-col gap-4 pt-4">{children}</div>
        </CollapsiblePanel>
      </Collapsible>
    </Card>
  );
}
