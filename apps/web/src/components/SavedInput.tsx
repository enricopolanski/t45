import type { ComponentProps, FocusEvent } from "react";

import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

const trim = (typed: string) => typed.trim();

export function SavedInput({
  value,
  onSave,
  tidy = trim,
  multiline = false,
  size = "default",
  ...props
}: Pick<
  ComponentProps<typeof Input>,
  "id" | "type" | "size" | "placeholder" | "disabled" | "aria-describedby" | "aria-invalid"
> & {
  readonly value: string;
  readonly onSave: (typed: string) => void;
  readonly tidy?: (typed: string) => string;
  readonly multiline?: boolean;
}) {
  const save = (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const typed = tidy(event.currentTarget.value);
    event.currentTarget.value = typed;
    if (typed !== value) onSave(typed);
  };
  return multiline ? (
    <Textarea key={value} {...props} defaultValue={value} onBlur={save} />
  ) : (
    <Input
      key={value}
      {...props}
      size={size}
      defaultValue={value}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}
