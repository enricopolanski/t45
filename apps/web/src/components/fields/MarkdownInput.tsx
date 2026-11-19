import { useTranslation } from "~/i18n/locale";
import { PencilIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { MarkdownText } from "../markdown/MarkdownText";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

/** Reads as Markdown until edited; leaving the source saves it, as other text fields do. */
export function MarkdownInput({
  value,
  label,
  onSave,
  isClamped = false,
  className,
  ...control
}: {
  readonly value: string;
  readonly label: string;
  readonly onSave: (value: string) => void;
  readonly isClamped?: boolean;
  readonly className?: string;
  readonly id?: string;
  readonly "aria-describedby"?: string | undefined;
  readonly "aria-invalid"?: true | undefined;
}) {
  const t = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  if (isEditing || value === "")
    return (
      <Textarea
        {...control}
        key={value}
        aria-label={label}
        autoFocus={isEditing}
        defaultValue={value}
        placeholder={t("Write Markdown…")}
        className="[&_textarea]:max-h-none [&_textarea]:min-h-8"
        onBlur={(event) => {
          const typed = event.currentTarget.value.trim();
          if (typed !== value) onSave(typed);
          setIsEditing(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            event.currentTarget.value = value;
            event.currentTarget.blur();
          }
        }}
      />
    );
  return (
    <div
      className={cn(
        "relative min-w-0 rounded-md border border-border px-2.5 py-1.5 pr-8",
        className,
      )}
    >
      <MarkdownText text={value} isClamped={isClamped} />
      <Button
        {...control}
        type="button"
        size="icon-xs"
        variant="ghost-muted"
        aria-label={t("Edit {0}", label)}
        className="absolute top-1 right-1"
        onClick={() => setIsEditing(true)}
      >
        <PencilIcon />
      </Button>
    </div>
  );
}
