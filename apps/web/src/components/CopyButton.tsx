import { Check, Copy } from "lucide";

import { MorphIcon } from "~/components/MorphIcon";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1200,
    onError: () => toastManager.add({ type: "error", title: "Couldn't copy to the clipboard" }),
  });
  const currentLabel = isCopied ? "Copied" : label;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-xs"
            onClick={() => copyToClipboard(text)}
            aria-label={currentLabel}
          />
        }
      >
        <MorphIcon className="size-3" icon={isCopied ? Check : Copy} />
      </TooltipTrigger>
      <TooltipPopup side="top">{currentLabel}</TooltipPopup>
    </Tooltip>
  );
}
