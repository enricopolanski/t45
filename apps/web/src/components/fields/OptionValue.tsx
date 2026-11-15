import type { FieldTones } from "@t45/contracts/models/Field";
import { CircleCheckIcon, CircleXIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const TONES = {
  positive: { Icon: CircleCheckIcon, color: "text-success-foreground" },
  neutral: { Icon: InfoIcon, color: "text-muted-foreground" },
  warning: { Icon: TriangleAlertIcon, color: "text-warning-foreground" },
  negative: { Icon: CircleXIcon, color: "text-destructive-foreground" },
};

/** A select's option as a table cell shows it: its tone's icon, named by the option, or its text. */
export function OptionValue({
  option,
  tones,
}: {
  readonly option: string;
  readonly tones: typeof FieldTones.Type | undefined;
}) {
  const tone = tones?.[option];
  if (tone === undefined) return option;
  const { Icon, color } = TONES[tone];
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex align-middle" />}>
        <Icon role="img" aria-label={option} className={cn("size-4 opacity-100", color)} />
      </TooltipTrigger>
      <TooltipPopup>{option}</TooltipPopup>
    </Tooltip>
  );
}
