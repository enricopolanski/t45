import { useState } from "react";

import { cn } from "../../lib/utils";
import { ExpandedImageDialog, type ImageGallery } from "../chat/ExpandedImageDialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Markdown } from "./Markdown";

/** Saved Markdown outside a chat, with real line breaks and the same links and image preview. */
export function MarkdownText({
  text,
  isClamped = false,
  className,
}: {
  readonly text: string;
  readonly isClamped?: boolean;
  readonly className?: string;
}) {
  const [gallery, setGallery] = useState<ImageGallery | null>(null);
  const content = (
    <Markdown
      text={text}
      lineBreaks
      parseRawHtml={false}
      onImageExpand={setGallery}
      className={isClamped ? "line-clamp-1" : ""}
    />
  );
  return (
    <div className={cn("min-w-0 whitespace-normal", className)}>
      {isClamped ? (
        <Tooltip>
          <TooltipTrigger render={<div />}>{content}</TooltipTrigger>
          <TooltipPopup>
            <Markdown text={text} lineBreaks parseRawHtml={false} onImageExpand={setGallery} />
          </TooltipPopup>
        </Tooltip>
      ) : (
        content
      )}
      {gallery === null ? null : (
        <ExpandedImageDialog gallery={gallery} onClose={() => setGallery(null)} />
      )}
    </div>
  );
}
