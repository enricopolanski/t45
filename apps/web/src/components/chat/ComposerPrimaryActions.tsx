import { ArrowUpIcon, ChevronLeftIcon, ListPlusIcon, SquareIcon } from "lucide-react";
import { keepComposerFocus } from "~/components/chat/composerLayout";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface QuestionActionState {
  fieldIndex: number;
  isLastField: boolean;
  isResponding: boolean;
  /** Why Next or Submit can't go on yet, shown on the disabled button. */
  blockedReason: string | null;
  onPreviousField: () => void;
}

const pointerFocusProps = (preserveComposerFocus: boolean) =>
  preserveComposerFocus ? { onPointerDown: keepComposerFocus } : undefined;

function StopButton(props: {
  small: boolean;
  preserveComposerFocus: boolean;
  onInterrupt: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-control-highlight transition-all duration-150 hover:bg-destructive hover:scale-105 active:inset-shadow-control-pressed active:shadow-none [&_svg]:pointer-events-none",
              props.small ? "size-8 sm:size-7" : "size-8",
            )}
            {...pointerFocusProps(props.preserveComposerFocus)}
            onClick={props.onInterrupt}
            aria-label="Stop generation"
          />
        }
      >
        <SquareIcon className="size-2.5 fill-current" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup>Interrupt</TooltipPopup>
    </Tooltip>
  );
}

/** Previous and Next or Submit for the field of an agent's question on screen. */
export function ComposerQuestionActions(props: {
  action: QuestionActionState;
  preserveComposerFocus: boolean;
  /** Offered while the run can be stopped. */
  onInterrupt?: (() => void) | undefined;
}) {
  const { action } = props;
  return (
    <div className="flex items-center justify-end gap-1.5">
      {props.onInterrupt ? (
        <StopButton
          small
          preserveComposerFocus={props.preserveComposerFocus}
          onInterrupt={props.onInterrupt}
        />
      ) : null}
      {action.fieldIndex > 0 ? (
        <Button
          size="icon-sm"
          variant="outline"
          {...pointerFocusProps(props.preserveComposerFocus)}
          onClick={action.onPreviousField}
          disabled={action.isResponding}
          aria-label="Previous question"
        >
          <ChevronLeftIcon className="size-3.5" />
        </Button>
      ) : null}
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          {/* Shares the send button's message-action pill, so it is not a restyled Button. */}
          <button
            type="submit"
            className="inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-message-action px-3 font-medium text-base text-message-action-foreground shadow-xs shadow-message-action/24 outline-none hover:bg-message-action-hover focus-ring disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none sm:h-7 sm:text-sm"
            {...pointerFocusProps(props.preserveComposerFocus)}
            disabled={action.isResponding || action.blockedReason !== null}
          >
            {action.isResponding ? "Submitting…" : action.isLastField ? "Submit" : "Next"}
          </button>
        </TooltipTrigger>
        {action.blockedReason ? <TooltipPopup>{action.blockedReason}</TooltipPopup> : null}
      </Tooltip>
    </div>
  );
}

/** Send, or queue while the agent runs; Stop while it runs and there is nothing to send. */
export function ComposerSendActions(props: {
  isRunning: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  hasSendableContent: boolean;
  preserveComposerFocus: boolean;
  /** Offered while the run can be stopped, including one still preparing or starting. */
  onInterrupt?: (() => void) | undefined;
}) {
  if (props.onInterrupt && !props.hasSendableContent) {
    return (
      <StopButton
        small={false}
        preserveComposerFocus={props.preserveComposerFocus}
        onInterrupt={props.onInterrupt}
      />
    );
  }

  const submitLabel = props.isRunning ? "Queue message" : "Submit message";
  const submitStatus = props.sendDisabledReason ?? (props.isSendBusy ? "Submitting message" : null);

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <button
          type="submit"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-message-action text-message-action-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-control-highlight enabled:shadow-message-action/24 hover:scale-105 hover:bg-message-action-hover active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 [&_svg]:pointer-events-none"
          {...pointerFocusProps(props.preserveComposerFocus)}
          disabled={
            props.isSendBusy || props.sendDisabledReason !== null || !props.hasSendableContent
          }
          aria-label={submitStatus ?? submitLabel}
        >
          {props.isSendBusy ? (
            <Spinner size="sm" />
          ) : props.isRunning ? (
            <ListPlusIcon className="size-4" aria-hidden="true" />
          ) : (
            <ArrowUpIcon className="size-4" strokeWidth={2.75} aria-hidden="true" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipPopup>{submitStatus ?? submitLabel}</TooltipPopup>
    </Tooltip>
  );
}
