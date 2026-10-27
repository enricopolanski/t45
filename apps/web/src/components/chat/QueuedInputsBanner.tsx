import type { PendingInput } from "@t45/contracts/resources/Chats";
import { replaceComposerContextReferences } from "@t45/core/composerContextReferences";
import { ListOrderedIcon } from "lucide-react";
import { useState, useTransition } from "react";

import { keepComposerFocus } from "~/components/chat/composerLayout";
import { attachmentUrl } from "~/lib/attachmentUrl";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";

type CancelInput = (input: PendingInput) => Promise<unknown>;

/**
 * Messages T45 saved that the agent hasn't taken up yet, above the composer. Each can still be
 * cancelled; once the agent takes one up it leaves this list and shows in the conversation.
 */
export function QueuedInputsBanner(props: {
  readonly inputs: ReadonlyArray<PendingInput>;
  readonly onCancel: CancelInput;
}) {
  const [expanded, setExpanded] = useState(true);
  const { inputs } = props;
  return (
    <ComposerBanner.Root
      role="region"
      aria-label={`${inputs.length} queued message${inputs.length === 1 ? "" : "s"}`}
      aria-live="polite"
      data-chat-composer-collapsed-controls="true"
    >
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger
          render={<ComposerBanner.Row render={<button type="button" />} />}
          aria-label={expanded ? "Collapse queued messages" : "Expand queued messages"}
          onPointerDown={keepComposerFocus}
        >
          <ComposerBanner.Icon>
            <ListOrderedIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="text-muted-foreground">Queued</ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.Count>{inputs.length}</ComposerBanner.Count>
            <ComposerBanner.ToggleIcon expanded={expanded} />
          </ComposerBanner.Actions>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <ComposerBanner.Scroll className="max-h-32">
            <ComposerBanner.Children render={<ol />}>
              {inputs.map((input) => (
                <QueuedInputRow key={input.inputId} input={input} onCancel={props.onCancel} />
              ))}
            </ComposerBanner.Children>
          </ComposerBanner.Scroll>
        </CollapsiblePanel>
      </Collapsible>
    </ComposerBanner.Root>
  );
}

function QueuedInputRow({ input, onCancel }: { input: PendingInput; onCancel: CancelInput }) {
  const [cancelling, startCancel] = useTransition();
  const images = input.attachments.filter((attachment) => attachment.type === "image");
  const previewText = replaceComposerContextReferences(input.text, (reference) =>
    reference.kind === "image" && images.length > 0 ? "" : reference.label,
  ).trim();
  return (
    <ComposerBanner.Row render={<li />} className="relative rounded-sm">
      <ComposerBanner.Icon />
      <ComposerBanner.Content className="text-foreground/80">
        {images.length > 0 ? (
          <span className="flex shrink-0 items-center gap-0.5">
            {images.map((image) => (
              <span
                key={image.id}
                className="size-4 overflow-hidden rounded border border-border/70 bg-background"
              >
                <img
                  src={attachmentUrl(image)}
                  alt={image.name}
                  className="size-full object-cover"
                />
              </span>
            ))}
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
            {previewText}
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-96 break-words">
            {previewText}
          </TooltipPopup>
        </Tooltip>
      </ComposerBanner.Content>
      <ComposerBanner.Actions>
        <Tooltip>
          <TooltipTrigger
            render={
              <ComposerBanner.Dismiss
                aria-label="Cancel queued message"
                disabled={cancelling}
                onClick={() =>
                  startCancel(async () => {
                    await onCancel(input);
                  })
                }
              />
            }
          />
          <TooltipPopup>Cancel</TooltipPopup>
        </Tooltip>
      </ComposerBanner.Actions>
    </ComposerBanner.Row>
  );
}
