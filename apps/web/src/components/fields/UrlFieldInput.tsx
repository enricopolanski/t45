import { isUrlFieldValue, type UrlFieldValue } from "@t45/contracts/models/Field";
import { type ComponentProps, useId } from "react";

import { ExternalUrl } from "../ExternalUrl";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

/** The destination and visible text of one URL field, with a preview when both are filled in. */
export function UrlFieldInput({
  value,
  onChange,
  label,
  id,
  ...control
}: Pick<ComponentProps<typeof Input>, "id" | "disabled" | "aria-describedby" | "aria-invalid"> & {
  readonly value: UrlFieldValue | null;
  readonly onChange: (value: UrlFieldValue | null) => void;
  readonly label: string;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const draft = value ?? { url: "", label: "" };
  const isRequired = draft.url.trim() !== "" || draft.label.trim() !== "";
  const change = (next: UrlFieldValue) =>
    onChange(next.url === "" && next.label === "" ? null : next);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(12rem,100%),1fr))] gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={inputId} size="sm">
            URL
          </Label>
          <Input
            {...control}
            id={inputId}
            aria-label={`${label} URL`}
            type="url"
            pattern="[Hh][Tt][Tt][Pp][Ss]?://\S+"
            placeholder="https://example.com"
            required={isRequired}
            value={draft.url}
            onChange={(event) => change({ ...draft, url: event.target.value })}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={`${inputId}-label`} size="sm">
            Link text
          </Label>
          <Input
            {...control}
            id={`${inputId}-label`}
            aria-label={`${label} link text`}
            placeholder="Example"
            pattern=".*\S.*"
            required={isRequired}
            value={draft.label}
            onChange={(event) => change({ ...draft, label: event.target.value })}
          />
        </div>
      </div>
      {isUrlFieldValue(value) ? <ExternalUrl href={value.url}>{value.label}</ExternalUrl> : null}
    </div>
  );
}
