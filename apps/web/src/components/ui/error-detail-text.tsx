"use client";

import { CheckIcon, CopyIcon } from "lucide-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";

import { Button } from "./button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

export function ErrorDetailCopyButton({ text, className }: { text: string; className?: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const label = isCopied ? "Copied error" : "Copy error";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className={className}
            onClick={() => copyToClipboard(text)}
            size="icon-xs"
            variant="ghost-muted"
          />
        }
      >
        {isCopied ? (
          <CheckIcon className="size-3.5 text-success" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Error text that clamps when long, showing the whole of it in a tooltip, with a copy button. */
export function ErrorDetailText({
  text,
  textClassName,
  showCopy = true,
}: {
  text: string;
  textClassName?: string;
  showCopy?: boolean;
}) {
  const clamped = text.length >= 120;
  const body = (
    <span
      className={cn(
        "min-w-0 whitespace-pre-wrap wrap-break-word text-sm leading-relaxed",
        clamped && "line-clamp-4 sm:line-clamp-6 lg:line-clamp-[10]",
        textClassName,
      )}
    >
      {text}
    </span>
  );

  const textBlock = clamped ? (
    <Tooltip>
      <TooltipTrigger render={<div className="min-w-0 flex-1 cursor-default" />}>
        {body}
      </TooltipTrigger>
      <TooltipPopup
        side="top"
        className="max-w-[min(calc(var(--available-width)-1rem),36rem)] whitespace-pre-wrap text-xs leading-relaxed"
      >
        {text}
      </TooltipPopup>
    </Tooltip>
  ) : (
    <div className="min-w-0 flex-1">{body}</div>
  );

  if (!showCopy) {
    return <div className="min-w-0">{textBlock}</div>;
  }

  return (
    <div className="flex min-w-0 items-start gap-2">
      {textBlock}
      <ErrorDetailCopyButton className="mt-0.5" text={text} />
    </div>
  );
}
