import { Refused } from "@t45/contracts/models/Workflow";
import { AccessDenied } from "@t45/contracts/resources/errors";
import type { FieldView, StepFileView } from "@t45/contracts/resources/Workflows";
import { PaperclipIcon, PlusIcon, XIcon } from "lucide-react";
import { type ComponentProps, useId, useRef } from "react";

import { attachmentUploadUrl, attachmentUrl, decodeUploadResult } from "../../lib/attachmentUrl";
import { api } from "../../rpc/api";
import { SavedInput } from "../SavedInput";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { newKey } from "../workflows/workflowLogic";
import { CardFold } from "./CardFold";
import { formatDueDate } from "./workLogic";

/** Uploads a file to the step; with `fieldKey`, it becomes that file field's value. */
export async function attachStepFile(stepId: string, file: File, fieldKey?: string) {
  const response = await fetch(
    attachmentUploadUrl({
      type: "file",
      name: file.name,
      mimeType: file.type || "application/octet-stream",
    }),
    { method: "POST", body: file },
  );
  if (!response.ok) {
    throw response.status === 401
      ? new AccessDenied({ message: "Your session ended. Sign in again." })
      : new Refused({ reason: "invalid_attachment" });
  }
  const { attachmentId } = decodeUploadResult(await response.text());
  await api("workflows.attachStepFile", {
    stepId,
    attachmentId,
    ...(fieldKey === undefined ? {} : { fieldKey }),
  });
}

/** A download link for a step's file. */
export function AttachmentLink({ attachment }: { readonly attachment: StepFileView }) {
  return (
    <a
      href={attachmentUrl(attachment)}
      download={attachment.name}
      className="inline-flex min-w-0 items-center gap-1.5 text-sm text-primary hover:underline"
    >
      <PaperclipIcon className="size-3.5 shrink-0" />
      <span className="truncate">{attachment.name}</span>
    </a>
  );
}

export function FilePickButton({
  label,
  disabled,
  onPick,
  ...input
}: ComponentProps<"input"> & {
  readonly label: string;
  readonly onPick: (file: File) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={picker}
        {...input}
        type="file"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onPick(file);
        }}
      />
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={disabled}
        onClick={() => picker.current?.click()}
      >
        {label}
      </Button>
    </>
  );
}

function shownValue(field: FieldView) {
  if (field.value === null) return "Not filled in";
  switch (field.type) {
    case "boolean":
      return field.value === true ? "Yes" : "No";
    case "date":
      return typeof field.value === "string" ? formatDueDate(field.value) : String(field.value);
    default:
      return String(field.value);
  }
}

function FieldValue({ field }: { readonly field: FieldView }) {
  if (field.type === "group") {
    if (field.rows.length === 0)
      return <span className="text-sm text-muted-foreground">No entries</span>;
    return (
      <div className="flex flex-col gap-2">
        {field.rows.map((row) => (
          <div
            key={row.id ?? "row"}
            className="flex flex-col gap-2 rounded-lg border border-border p-3"
          >
            <ReadOnlyFields fields={row.fields} />
          </div>
        ))}
      </div>
    );
  }
  if (field.type === "file") {
    return field.file === null ? (
      <span className="text-sm text-muted-foreground">No file</span>
    ) : (
      <AttachmentLink attachment={field.file} />
    );
  }
  return (
    <span
      className={
        field.value === null ? "text-sm text-muted-foreground" : "text-sm whitespace-pre-wrap"
      }
    >
      {shownValue(field)}
    </span>
  );
}

/** Why a field stops the step from being marked done. */
function MissingNote({ id, children }: { readonly id?: string; readonly children: string }) {
  return (
    <p id={id} className="text-xs text-destructive">
      {children}
    </p>
  );
}

/**
 * A group's fields, in a box per row. A repeatable group adds and removes rows by saving its row
 * ids; a removed row's values go with it.
 */
function GroupEditor({
  field,
  missing,
  onSave,
  onUpload,
}: {
  readonly field: FieldView;
  readonly missing: ReadonlySet<string>;
  readonly onSave: (fieldKey: string, value: FieldView["value"]) => void;
  readonly onUpload: (fieldKey: string, file: File) => void;
}) {
  const ids = field.rows.flatMap((row) => (row.id === null ? [] : [row.id]));
  return (
    <div data-field-key={field.key} className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium">{field.label}</p>
        {field.description ? (
          <p className="text-xs text-muted-foreground">{field.description}</p>
        ) : null}
      </div>
      {missing.has(field.key) ? <MissingNote>Add at least one entry</MissingNote> : null}
      {field.rows.map((row, at) => (
        <div
          key={row.id ?? "row"}
          className="flex flex-col gap-3 rounded-lg border border-border p-3"
        >
          {row.id !== null ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Entry {at + 1}</span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                aria-label={`Remove entry ${at + 1} of ${field.label}`}
                onClick={() =>
                  onSave(
                    field.key,
                    ids.filter((id) => id !== row.id),
                  )
                }
              >
                <XIcon />
                Remove
              </Button>
            </div>
          ) : null}
          {row.fields.map((child) => (
            <FieldEditor
              key={child.key}
              field={child}
              missing={missing}
              onSave={onSave}
              onUpload={onUpload}
            />
          ))}
        </div>
      ))}
      {field.repeatable ? (
        <div>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onSave(field.key, [...ids, newKey("row")])}
          >
            <PlusIcon />
            Add entry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FieldEditor({
  field,
  missing,
  onSave,
  onUpload,
}: {
  readonly field: FieldView;
  /** Paths of the fields to flag as still empty. */
  readonly missing: ReadonlySet<string>;
  readonly onSave: (fieldKey: string, value: FieldView["value"]) => void;
  readonly onUpload: (fieldKey: string, file: File) => void;
}) {
  const id = useId();
  if (field.type === "group") {
    return <GroupEditor field={field} missing={missing} onSave={onSave} onUpload={onUpload} />;
  }
  const save = (value: FieldView["value"]) => onSave(field.key, value);
  const label = (
    <div className="flex flex-col gap-0.5">
      <Label htmlFor={id}>{field.label}</Label>
      {field.description ? (
        <p id={`${id}-description`} className="text-xs text-muted-foreground">
          {field.description}
        </p>
      ) : null}
    </div>
  );
  const invalid = missing.has(field.key) || undefined;
  const control = {
    id,
    "aria-describedby":
      [field.description ? `${id}-description` : null, invalid ? `${id}-missing` : null]
        .filter(Boolean)
        .join(" ") || undefined,
    "aria-invalid": invalid,
  };
  // Keyed by the stored value, so a reload after saving resets what is shown.
  const stored = field.value === null ? "" : String(field.value);
  const input = (() => {
    switch (field.type) {
      case "text":
        return (
          <SavedInput
            {...control}
            multiline
            value={stored}
            onSave={(typed) => save(typed || null)}
          />
        );
      case "number":
        return (
          <SavedInput
            {...control}
            type="number"
            value={stored}
            onSave={(typed) => save(typed === "" ? null : Number(typed))}
          />
        );
      case "date":
        return (
          <SavedInput
            {...control}
            type="date"
            value={stored.slice(0, 10)}
            onSave={(typed) => save(typed || null)}
          />
        );
      case "select":
        return (
          <Select value={typeof field.value === "string" ? field.value : null} onValueChange={save}>
            <SelectTrigger
              id={id}
              aria-describedby={control["aria-describedby"]}
              aria-invalid={invalid}
            >
              <SelectValue placeholder="Choose one" />
            </SelectTrigger>
            <SelectPopup>
              {field.options.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        );
      case "boolean":
        return <Switch {...control} checked={field.value === true} onCheckedChange={save} />;
      case "file":
        return (
          <div className="flex flex-wrap items-center gap-3">
            {field.file === null ? (
              <span className="text-sm text-muted-foreground">No file</span>
            ) : (
              <AttachmentLink attachment={field.file} />
            )}
            <FilePickButton
              {...control}
              label={field.file === null ? "Upload" : "Replace"}
              onPick={(file) => onUpload(field.key, file)}
            />
          </div>
        );
    }
  })();
  return (
    <div data-field-key={field.key} className="flex flex-col gap-1.5">
      {field.type === "boolean" ? (
        <div className="flex items-center justify-between gap-3">
          {label}
          {input}
        </div>
      ) : (
        <>
          {label}
          {input}
        </>
      )}
      {invalid ? <MissingNote id={`${id}-missing`}>Required</MissingNote> : null}
    </div>
  );
}

/** The step's fields: editable by whoever works the step, read-only for everyone else. */
export function StepFields({
  fields,
  editable,
  missing,
  onSave,
  onUpload,
}: {
  readonly fields: ReadonlyArray<FieldView>;
  readonly editable: boolean;
  /** Paths of the fields to flag as still empty. */
  readonly missing: ReadonlySet<string>;
  readonly onSave: (fieldKey: string, value: FieldView["value"]) => void;
  readonly onUpload: (fieldKey: string, file: File) => void;
}) {
  if (fields.length === 0) return null;
  return (
    <CardFold title="Fields" held={missing.size > 0}>
      {editable ? (
        fields.map((field) => (
          <FieldEditor
            key={field.key}
            field={field}
            missing={missing}
            onSave={onSave}
            onUpload={onUpload}
          />
        ))
      ) : (
        <ReadOnlyFields fields={fields} />
      )}
    </CardFold>
  );
}

/** Fields as text, for a step the viewer only reads; the parent's column spaces them. */
export function ReadOnlyFields({ fields }: { readonly fields: ReadonlyArray<FieldView> }) {
  return fields.map((field) => (
    <div key={field.key} className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{field.label}</span>
      <FieldValue field={field} />
    </div>
  ));
}
