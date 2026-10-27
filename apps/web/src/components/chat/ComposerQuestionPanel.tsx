import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "lucide-react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerQuestion } from "./useChatQuestions";

/** The question the agent is waiting on, one field at a time. Key it by the question's key. */
export function ComposerQuestionPanel({ question }: { question: ComposerQuestion }) {
  const { asked, progress, responding: isResponding, onToggleOption, onAdvance } = question;
  const field = progress.field;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const onAdvanceRef = useRef(onAdvance);
  // Collapsing hides all but the header so a tall question stops covering the chat. It holds
  // for one field: the next field, reached by a click or by sending, opens expanded.
  const [collapsedFieldKey, setCollapsedFieldKey] = useState<string | null>(null);
  const isCollapsed = collapsedFieldKey === field?.key;

  useEffect(() => {
    onAdvanceRef.current = onAdvance;
  }, [onAdvance]);

  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
    };
  }, []);

  // A single-select pick moves on to the next field after a beat.
  const handleOptionSelection = (fieldKey: string, optionValue: string) => {
    onToggleOption(fieldKey, optionValue);
    if (field?.multiSelect) return;
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
    }
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      onAdvanceRef.current();
    }, 200);
  };

  // Keys 1-9 pick the matching option while focus is outside editable fields. A collapsed
  // question opts out, since the numbers it refers to are not on screen.
  useEffect(() => {
    if (!field || isResponding || isCollapsed) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const option = field.options[digit - 1];
      if (!option) return;
      event.preventDefault();
      handleOptionSelection(field.key, option.value);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [field, handleOptionSelection, isCollapsed, isResponding]);

  if (!field) {
    return null;
  }

  const customAnswerActive = progress.customAnswer.trim().length > 0;

  return (
    <Collapsible
      open={!isCollapsed}
      onOpenChange={(open) => {
        setCollapsedFieldKey(open ? null : field.key);
      }}
    >
      <CollapsibleTrigger
        render={<ComposerBanner.Row render={<button type="button" />} />}
        title={
          isCollapsed ? "Show the question and its options" : "Hide the question and its options"
        }
      >
        <ComposerBanner.Icon />
        <ComposerBanner.Content>
          <span className="shrink-0 font-medium text-muted-foreground">{field.header}</span>
          {isCollapsed ? (
            <span className="min-w-0 flex-1 truncate text-secondary-label">{field.question}</span>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          {asked.fields.length > 1 ? (
            <span className="text-3xs font-medium text-muted-foreground tabular-nums">
              {progress.fieldIndex + 1}/{asked.fields.length}
            </span>
          ) : null}
          <ComposerBanner.ToggleIcon expanded={!isCollapsed} />
        </ComposerBanner.Actions>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ComposerBanner.Scroll>
          <ComposerBanner.Body className="pe-1 pb-1 wrap-anywhere">
            <p className="text-sm text-foreground/85">{field.question}</p>
            {field.multiSelect ? (
              <p className="mt-1 text-secondary-label text-xs">Select one or more options.</p>
            ) : null}
            <div className="mt-2 space-y-0.5">
              {field.options.map((option, index) => {
                const isSelected =
                  !customAnswerActive && progress.selectedOptionValues.includes(option.value);
                return (
                  <button
                    key={`${field.key}:${option.value}`}
                    type="button"
                    aria-pressed={isSelected}
                    disabled={isResponding}
                    onClick={() => handleOptionSelection(field.key, option.value)}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md bg-transparent px-2.5 py-2 text-left text-foreground/85 outline-none transition-colors duration-150 not-aria-pressed:hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-primary/25 aria-pressed:bg-muted/55 aria-pressed:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm font-medium">{option.label}</span>
                      {option.description && option.description !== option.label ? (
                        <span className="text-secondary-label text-2xs">{option.description}</span>
                      ) : null}
                    </div>
                    {isSelected ? (
                      <CheckIcon className="size-3.5 shrink-0 text-primary" />
                    ) : index < 9 ? (
                      <kbd className="flex size-5 shrink-0 items-center justify-center text-3xs font-medium text-muted-foreground tabular-nums">
                        {index + 1}
                      </kbd>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {asked.answerable ? null : (
              // A question that needs a step outside the chat can only be dismissed.
              <div className="mt-1 flex justify-end">
                <Button size="xs" variant="ghost-muted" onClick={question.onDismiss}>
                  Dismiss
                </Button>
              </div>
            )}
          </ComposerBanner.Body>
        </ComposerBanner.Scroll>
      </CollapsiblePanel>
    </Collapsible>
  );
}
