import { isUrlFieldValue } from "@t45/contracts/models/Field";
import type { FieldView } from "@t45/contracts/resources/Workflows";
import { LockIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { cn } from "../../lib/utils";
import { RecordTable } from "../collections/Records";
import { ExternalUrl } from "../ExternalUrl";
import { isTableColumn } from "../fields/fieldPresentation";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import { FoldChevron } from "./CardFold";
import { AttachmentLink, FieldValue, shownValue } from "./StepFields";
import { plural } from "./workLogic";

// Read-only: no text cursor or caret, so nothing suggests typing; the value still selects and copies.
const readOnlyCursor = "cursor-default caret-transparent";
const readOnlyBox = cn(
  readOnlyCursor,
  "rounded-md border border-border bg-muted text-sm text-foreground/80",
);

/** A field's value runs over lines, so it takes the whole row. */
const isMultiline = (field: FieldView) =>
  field.type === "text" && typeof field.value === "string" && field.value.includes("\n");

const isBlock = (field: FieldView | undefined) =>
  field?.type === "group" || field?.type === "records";

/** A field's value in a read-only control, selectable and copyable. */
function ReadOnlyControl({ field, id }: { readonly field: FieldView; readonly id: string }) {
  if (field.linkUrl !== undefined)
    return (
      <div id={id} className={cn(readOnlyBox, "flex min-h-8 items-center px-2.5 py-1")}>
        <ExternalUrl href={field.linkUrl}>{shownValue(field)}</ExternalUrl>
      </div>
    );
  if (field.type === "file" || field.type === "url") {
    return (
      <div id={id} className={cn(readOnlyBox, "flex min-h-8 items-center px-2.5 py-1")}>
        {field.type === "file" ? (
          field.file === null ? (
            <span className="text-muted-foreground">No file</span>
          ) : (
            <AttachmentLink attachment={field.file} />
          )
        ) : isUrlFieldValue(field.value) ? (
          <ExternalUrl href={field.value} />
        ) : (
          <span className="text-muted-foreground">Not filled in</span>
        )}
      </div>
    );
  }
  const value = field.value === null ? "" : shownValue(field);
  return isMultiline(field) ? (
    <textarea
      id={id}
      readOnly
      value={value}
      className={cn(
        readOnlyBox,
        "block min-h-18 w-full resize-none px-2.5 py-1.5 field-sizing-content",
      )}
    />
  ) : (
    <input
      id={id}
      readOnly
      value={value}
      placeholder="Not filled in"
      className={cn(readOnlyBox, "h-8 w-full min-w-0 px-2.5 placeholder:text-muted-foreground")}
    />
  );
}

/** A field with its label beside the control, or `isStacked` above it, as in an entry's form. */
function InputField({
  field,
  isStacked = false,
}: {
  readonly field: FieldView;
  readonly isStacked?: boolean;
}) {
  const id = useId();
  if (isBlock(field)) {
    return (
      <div className="col-span-full flex flex-col gap-1">
        <span className="text-xs font-medium text-foreground/80">
          {field.linkUrl === undefined ? (
            field.label
          ) : (
            <ExternalUrl href={field.linkUrl}>{field.label}</ExternalUrl>
          )}
        </span>
        <FieldValue field={field} />
      </div>
    );
  }
  const label = (
    <label
      htmlFor={id}
      className={isStacked ? "text-xs font-medium text-foreground/80" : "text-sm font-medium"}
    >
      {field.label}
    </label>
  );
  const hint = field.description ? (
    <p className="text-xs text-muted-foreground">{field.description}</p>
  ) : null;
  return isStacked ? (
    <div className={cn("flex min-w-0 flex-col gap-1", isMultiline(field) && "col-span-full")}>
      {label}
      <ReadOnlyControl field={field} id={id} />
      {hint}
    </div>
  ) : (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-start gap-x-4 gap-y-1",
        isMultiline(field) && "col-span-full",
      )}
    >
      <div className="flex max-w-full shrink-0 grow-0 basis-55 flex-col gap-0.5 py-1.5">
        {label}
        {hint}
      </div>
      <div className="min-w-0 flex-1 basis-60">
        <ReadOnlyControl field={field} id={id} />
      </div>
    </div>
  );
}

/** Fields two to a row once the card is wide enough, one otherwise. */
function FieldGrid({ fields }: { readonly fields: ReadonlyArray<FieldView> }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,max(27.5rem,calc(50%_-_1.0625rem))),1fr))] gap-x-8 gap-y-2">
      {fields.map((field) => (
        <InputField key={field.key} field={field} />
      ))}
    </div>
  );
}

/** A block's title, with `children` beside it. */
function BlockHeading({
  field,
  children,
}: {
  readonly field: FieldView;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-sm/6 font-medium">
          {field.linkUrl === undefined ? (
            field.label
          ) : (
            <ExternalUrl href={field.linkUrl}>{field.label}</ExternalUrl>
          )}
        </h3>
        {children}
      </div>
      {field.description ? (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      ) : null}
    </div>
  );
}

/** Columns weigh by what they hold: numbers, dates and switches half as wide as text. */
const columnWeight = (field: FieldView["rowFields"][number]) =>
  field.type === "number" || field.type === "date" || field.type === "boolean" ? 1 : 2;

type Entry = { readonly id: string; readonly fields: ReadonlyArray<FieldView> };

/** An entry's field as a table cell holds it: unframed, named by `label`. */
function CellValue({ field, label }: { readonly field: FieldView; readonly label: string }) {
  if (field.linkUrl !== undefined)
    return (
      <div className="flex min-h-9 items-center bg-muted px-2 py-1 text-sm">
        <ExternalUrl href={field.linkUrl}>{shownValue(field)}</ExternalUrl>
      </div>
    );
  if (field.type === "file" || field.type === "url") {
    return (
      <div className="flex min-h-9 items-center bg-muted px-2 py-1 text-sm">
        {field.type === "file" ? (
          field.file === null ? null : (
            <AttachmentLink attachment={field.file} />
          )
        ) : isUrlFieldValue(field.value) ? (
          <ExternalUrl href={field.value} />
        ) : null}
      </div>
    );
  }
  return (
    <textarea
      aria-label={label}
      readOnly
      rows={1}
      value={field.value === null ? "" : shownValue(field)}
      className={cn(
        readOnlyCursor,
        "block min-h-9 w-full resize-none bg-muted px-2 py-2 text-sm text-foreground/80 outline-none field-sizing-content focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        field.type === "number" && "text-right",
      )}
    />
  );
}

const headerCell =
  "border-t border-l border-border bg-muted/50 p-2 text-left align-top text-xs font-medium text-foreground/80 wrap-break-word";

/** The entries as rows, a column per field shown in the table; each entry opens to all its fields. */
function EntryTable({
  field,
  entries,
}: {
  readonly field: FieldView;
  readonly entries: ReadonlyArray<Entry>;
}) {
  const isColumn = field.rowFields.map(isTableColumn);
  const hasDetails = isColumn.includes(false);
  const [detailsAt, setDetailsAt] = useState<number | null>(null);
  const opened = detailsAt === null ? undefined : entries[detailsAt];
  const columns = field.rowFields.filter((_, at) => isColumn[at]);
  const weights = columns.reduce((sum, child) => sum + columnWeight(child), 0);
  return (
    <>
      <table
        aria-label={field.label}
        className="w-full table-fixed border-separate border-spacing-0 text-sm"
      >
        <colgroup>
          <col className="w-10" />
          {columns.map((child) => (
            <col key={child.id} style={{ width: `${(100 * columnWeight(child)) / weights}%` }} />
          ))}
          {hasDetails ? <col className="w-20" /> : null}
        </colgroup>
        <thead>
          <tr>
            <th
              scope="col"
              className="border-t border-border bg-muted/50 py-2 pr-2 pl-4 text-left align-top text-xs font-medium text-muted-foreground"
            >
              #
            </th>
            {columns.map((child) => (
              <th
                key={child.id}
                scope="col"
                className={cn(headerCell, child.type === "number" && "text-right")}
              >
                {child.label}
              </th>
            ))}
            {hasDetails ? (
              <th scope="col" className={headerCell}>
                <span className="sr-only">Details</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, at) => (
            <tr key={entry.id}>
              <td className="border-t border-border bg-muted/50 pr-2 pl-4 text-muted-foreground">
                {at + 1}
              </td>
              {entry.fields
                .filter((_, column) => isColumn[column])
                .map((child) => (
                  <td key={child.key} className="border-t border-l border-border p-0 align-top">
                    <CellValue field={child} label={`${child.label}, entry ${at + 1}`} />
                  </td>
                ))}
              {hasDetails ? (
                <td className="border-t border-l border-border text-center">
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    aria-label={`Details of entry ${at + 1} of ${field.label}`}
                    onClick={() => setDetailsAt(at)}
                  >
                    Details
                  </Button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {opened === undefined ? null : (
        <Dialog open onOpenChange={(isOpen) => (isOpen ? undefined : setDetailsAt(null))}>
          <DialogPopup className="sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>{`${field.label}, entry ${(detailsAt ?? 0) + 1}`}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <EntryFields fields={opened.fields} />
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      )}
    </>
  );
}

/** An entry's fields, labels above, as many to a row as fit at 200px each. */
function EntryFields({ fields }: { readonly fields: ReadonlyArray<FieldView> }) {
  return (
    <div className="grid min-w-0 flex-1 grid-cols-[repeat(auto-fit,minmax(min(12.5rem,100%),1fr))] gap-3">
      {fields.map((child) => (
        <InputField key={child.key} field={child} isStacked />
      ))}
    </div>
  );
}

/** A repeatable group's entries, as a table or as a form each; entries holding a group only as forms. */
function Entries({ field }: { readonly field: FieldView }) {
  const isTable = field.rowFields.every((child) => child.type !== "group");
  const [shown, setShown] = useState(isTable ? "table" : "form");
  const entries = field.rows.flatMap((row) =>
    row.id === null ? [] : [{ id: row.id, fields: row.fields }],
  );
  return (
    <Tabs value={shown} onValueChange={setShown}>
      <div className="py-2 pr-3 pl-4">
        <BlockHeading field={field}>
          <span className="text-xs text-muted-foreground">
            {plural(entries.length, "entry", "entries")}
          </span>
          {isTable && entries.length > 0 ? (
            <TabsList size="sm" aria-label={`Show ${field.label} as`} className="ml-auto">
              <TabsTab size="sm" value="table">
                Table
              </TabsTab>
              <TabsTab size="sm" value="form">
                Form
              </TabsTab>
            </TabsList>
          ) : null}
        </BlockHeading>
      </div>
      {entries.length > 0 ? (
        <>
          <TabsPanel value="table">
            <EntryTable field={field} entries={entries} />
          </TabsPanel>
          <TabsPanel value="form">
            <ol aria-label={field.label}>
              {entries.map((entry, at) => (
                <li
                  key={entry.id}
                  className="flex items-start gap-3 border-t border-border px-4 py-3"
                >
                  <span aria-hidden className="w-4 shrink-0 text-xs text-muted-foreground">
                    {at + 1}
                  </span>
                  <EntryFields fields={entry.fields} />
                </li>
              ))}
            </ol>
          </TabsPanel>
        </>
      ) : null}
    </Tabs>
  );
}

/** The records a records field links, in the collection's own table. */
function LinkedRecords({ field }: { readonly field: FieldView }) {
  return (
    <div className="flex flex-col gap-2 px-4 pt-3 pb-4">
      <BlockHeading field={field}>
        <span className="text-xs text-muted-foreground">
          {plural(field.records.length, "record", "records")}
        </span>
      </BlockHeading>
      {field.collection === null ? (
        <p className="text-sm text-muted-foreground">Its collection is gone.</p>
      ) : field.records.length > 0 ? (
        <RecordTable label={field.label} collection={field.collection} records={field.records} />
      ) : null}
    </div>
  );
}

/**
 * Fields in schema order, as blocks a line apart: a run of single fields, a group under its title,
 * a repeatable group's entries, a records field's records.
 */
function Blocks({ fields }: { readonly fields: ReadonlyArray<FieldView> }) {
  const runs: Array<Array<FieldView>> = [];
  for (const field of fields) {
    const run = runs.at(-1);
    if (!isBlock(field) && run !== undefined && !isBlock(run[0])) run.push(field);
    else runs.push([field]);
  }
  return (
    <div className="divide-y divide-border [&>:first-child]:pt-0">
      {runs.map((run) => {
        const [first] = run;
        const key = run.map((field) => field.key).join();
        if (first?.type === "records") return <LinkedRecords key={key} field={first} />;
        if (first?.type === "group") {
          return first.repeatable ? (
            <Entries key={key} field={first} />
          ) : (
            <div key={key} className="pt-3">
              <div className="px-4 pb-2">
                <BlockHeading field={first} />
              </div>
              <Blocks fields={first.rows.flatMap((row) => row.fields)} />
            </div>
          );
        }
        return (
          <div key={key} className="px-4 pt-3 pb-4">
            <FieldGrid fields={run} />
          </div>
        );
      })}
    </div>
  );
}

/** The values earlier steps gave this one, read-only, in a card that starts folded. */
export function StepInputs({ fields }: { readonly fields: ReadonlyArray<FieldView> }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <section aria-label="Inputs" className="card overflow-hidden">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div className="flex items-start gap-2 px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="flex">
              <CollapsibleTrigger className="group flex items-center gap-1.5 text-left text-sm font-semibold">
                Inputs
                <FoldChevron />
              </CollapsibleTrigger>
            </h2>
            <p className="text-xs text-muted-foreground">
              Information necessary to carry this step.
            </p>
          </div>
          <span className="ml-auto flex h-5 items-center gap-1 text-xs text-muted-foreground">
            <LockIcon aria-hidden className="size-3" />
            Read-only
          </span>
        </div>
        <CollapsiblePanel keepMounted>
          <Blocks fields={fields} />
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}
