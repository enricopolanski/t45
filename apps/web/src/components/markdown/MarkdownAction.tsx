import type { ComponentProps } from "react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function MarkdownAction({
  label,
  pressed,
  children,
  ...props
}: ComponentProps<typeof Button> & { label: string; pressed?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={pressed ? "secondary" : "ghost-muted"}
            size="icon-xs"
            aria-pressed={pressed}
            aria-label={label}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
