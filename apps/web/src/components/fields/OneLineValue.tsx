import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** A table cell's content on one line, cut with an ellipsis; its tooltip holds the whole `value`. */
export function OneLineValue({
  value,
  className,
  children,
}: {
  readonly value: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<div className={cn("truncate", className)} />}>
        {children}
      </TooltipTrigger>
      <TooltipPopup className="whitespace-pre-wrap">{value}</TooltipPopup>
    </Tooltip>
  );
}
