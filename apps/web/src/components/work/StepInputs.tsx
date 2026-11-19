import { isUrlFieldValue } from "@t45/contracts/models/Field";
import { resolveRecordDisplay, resolveTableLayout } from "@t45/contracts/models/Layout";
import type { CollectionRecordView } from "@t45/contracts/resources/Collections";
import type { FieldView, StepView } from "@t45/contracts/resources/Workflows";
import { buildFieldViews } from "@t45/core/fieldViews";
import { CheckIcon } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { RecordTable } from "../collections/Records";
import { RecordShowcase } from "../collections/RecordDisplay";
import { ExternalUrl } from "../ExternalUrl";
import { CONTROL_CELL_DENSITY, FORM_GRIDS, FORM_SPANS } from "../fields/fieldPresentation";
import { OneLineValue } from "../fields/OneLineValue";
import { MarkdownText } from "../markdown/MarkdownText";
import { OptionValue } from "../fields/OptionValue";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import { CardFold } from "./CardFold";
import {
  AttachmentLink,
  measureColumnWidths,
  type Entry,
  layOutEntryForm,
  type layOutForm,
  FieldValue,
  findEntryField,
  sortEntries,
  shownValue,
} from "./StepFields";
import { plural } from "./workLogic";

// Read-only: no text cursor or caret, so nothing suggests typing; the value still selects and copies.
const readOnlyCursor = "cursor-default caret-transparent";
const readOnlyBox = cn(
  readOnlyCursor,
  "rounded-md border border-border bg-muted text-sm text-foreground/80",
);

/** A field's value runs over lines, so it takes the whole row. */
const isMultiline = (field: FieldView) =>
  field.type === "text" &&
  (field.isMarkdown === true || (typeof field.value === "string" && field.value.includes("\n")));

const isBlock = (field: FieldView | undefined) =>
  field?.type === "group" || field?.type === "records";

/**
 * A field's value in a read-only control, selectable and copyable; `isStacked` in an entry's form,
 * where text and a choice show all of their value.
 */
function ReadOnlyControl({
  field,
  id,
  isStacked,
}: {
  readonly field: FieldView;
  readonly id: string;
  readonly isStacked: boolean;
}) {
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
  if (field.type === "text" && field.isMarkdown && value !== "")
    return (
      <div id={id} className={cn(readOnlyBox, "px-2.5 py-1.5")}>
        <MarkdownText text={value} />
      </div>
    );
  return isMultiline(field) || (isStacked && (field.type === "text" || field.type === "select")) ? (
    <textarea
      id={id}
      readOnly
      value={value}
      placeholder="Not filled in"
      className={cn(
        readOnlyBox,
        "block w-full resize-none px-2.5 field-sizing-content placeholder:text-muted-foreground",
        isStacked ? "min-h-8 py-1.5 leading-4.5" : "min-h-18 py-1.5",
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

/** A field with its label beside the control, or with a form's `span` above it. */
function InputField({
  field,
  span,
}: {
  readonly field: FieldView;
  readonly span?: keyof typeof FORM_SPANS;
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
      className={
        span !== undefined ? "text-xs font-medium text-foreground/80" : "text-sm font-medium"
      }
    >
      {field.label}
    </label>
  );
  const hint = field.description ? (
    <p className="text-xs text-muted-foreground">{field.description}</p>
  ) : null;
  return span !== undefined ? (
    <div className={cn("flex min-w-0 flex-col gap-1", FORM_SPANS[span])}>
      {label}
      <ReadOnlyControl field={field} id={id} isStacked />
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
        <ReadOnlyControl field={field} id={id} isStacked={false} />
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

/**
 * An entry's field as a table cell holds it: unframed, named by `label`. Text, a web address or a
 * choice wraps when its column is `isWrapped`, else shows one line, whole in its tooltip.
 */
function CellValue({
  field,
  label,
  isWrapped,
}: {
  readonly field: FieldView;
  readonly label: string;
  readonly isWrapped: boolean;
}) {
  if (field.linkUrl !== undefined || field.type === "url") {
    const link =
      field.linkUrl !== undefined ? (
        <ExternalUrl href={field.linkUrl}>{shownValue(field)}</ExternalUrl>
      ) : isUrlFieldValue(field.value) ? (
        <ExternalUrl href={field.value} />
      ) : null;
    const box = "min-h-9 bg-muted px-2 py-2 text-sm";
    return isWrapped || field.value === null ? (
      <div className={cn(box, "wrap-break-word")}>{link}</div>
    ) : (
      <OneLineValue value={shownValue(field)} className={box}>
        {link}
      </OneLineValue>
    );
  }
  if (
    field.type === "select" &&
    typeof field.value === "string" &&
    field.tones?.[field.value] !== undefined
  )
    return (
      <div className="flex min-h-9 items-center bg-muted px-2 py-1 text-sm text-foreground/80">
        <OptionValue option={field.value} tones={field.tones} />
      </div>
    );
  if (field.type === "file") {
    return (
      <div className="flex min-h-9 items-center bg-muted px-2 py-1 text-sm">
        {field.file === null ? null : <AttachmentLink attachment={field.file} />}
      </div>
    );
  }
  if (field.type === "text" && field.isMarkdown && typeof field.value === "string")
    return (
      <MarkdownText
        text={field.value}
        isClamped={!isWrapped}
        className="min-h-9 bg-muted px-2 py-2"
      />
    );
  const isOneLine = !isWrapped && (field.type === "text" || field.type === "select");
  const shown = field.value === null ? "" : shownValue(field);
  const value = (
    <textarea
      aria-label={label}
      readOnly
      rows={1}
      value={shown}
      className={cn(
        readOnlyCursor,
        "block min-h-9 w-full resize-none bg-muted px-2 py-2 text-sm text-foreground/80 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        field.type === "number" && "text-right",
        isOneLine ? "truncate" : "field-sizing-content",
      )}
    />
  );
  return isOneLine && shown !== "" ? <OneLineValue value={shown}>{value}</OneLineValue> : value;
}

const headerCell =
  "border-t border-l border-border bg-muted/50 p-2 first:border-l-0 text-left align-top text-xs font-medium text-foreground/80";

/**
 * The entries as rows, a column per field its layout shows in the table; each entry opens to all
 * its fields.
 */
export function EntryTable({
  field,
  entries,
}: {
  readonly field: FieldView;
  readonly entries: ReadonlyArray<Entry>;
}) {
  const { columns, density } = resolveTableLayout(field.rowFields, field.layout);
  const hasDetails = field.rowFields.some(
    (child) => !columns.some((column) => column.field.id === child.id),
  );
  const [detailsAt, setDetailsAt] = useState<number | null>(null);
  const opened = detailsAt === null ? undefined : entries[detailsAt];
  const form = opened === undefined ? null : layOutEntryForm(field, opened);
  // Columns share the table by the width they want, which it never squeezes: it scrolls instead.
  const widths = measureColumnWidths(field, columns, entries);
  const total = widths.reduce((sum, width) => sum + width, 0);
  return (
    <div className="overflow-x-auto">
      <table
        aria-label={field.label}
        className={cn(
          "w-full table-fixed border-separate border-spacing-0 text-sm",
          CONTROL_CELL_DENSITY[density],
        )}
        style={{ minWidth: `calc(${total}ch + ${hasDetails ? 5 : 0}rem)` }}
      >
        <colgroup>
          {columns.map((column, at) => (
            <col key={column.field.id} style={{ width: `${(100 * widths[at]!) / total}%` }} />
          ))}
          {hasDetails ? <col className="w-20" /> : null}
        </colgroup>
        <thead>
          <tr>
            {columns.map(({ field: child, header }) => (
              <th
                key={child.id}
                scope="col"
                className={cn(headerCell, child.type === "number" && "text-right")}
              >
                {header}
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
              {columns.map((column) => {
                const child = findEntryField(field, entry, column.field.id);
                return (
                  <td
                    key={column.field.id}
                    className="border-t border-l border-border p-0 align-top first:border-l-0"
                  >
                    {child === undefined ? null : (
                      <CellValue
                        field={child}
                        label={`${child.label}, entry ${at + 1}`}
                        isWrapped={column.isWrapped}
                      />
                    )}
                  </td>
                );
              })}
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
      {form === null ? null : (
        <Dialog open onOpenChange={(isOpen) => (isOpen ? undefined : setDetailsAt(null))}>
          <DialogPopup
            className={
              form.dialogWidth === 768
                ? "sm:max-w-3xl"
                : form.dialogWidth === 1280
                  ? "sm:max-w-7xl"
                  : "sm:max-w-5xl"
            }
          >
            <DialogHeader>
              <DialogTitle>{`${field.label}, entry ${(detailsAt ?? 0) + 1}`}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <ReadOnlyForm form={form} />
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      )}
    </div>
  );
}

/** A form's fields as `layOutForm` lays them out, read-only, labels above. */
export function ReadOnlyForm({ form }: { readonly form: ReturnType<typeof layOutForm> }) {
  return (
    <div className={cn(FORM_GRIDS[form.spacing], "min-w-0 flex-1")}>
      {form.fields.map(({ view, span }) => (
        <InputField key={view.key} field={view} span={span} />
      ))}
    </div>
  );
}

/** A repeatable group's entries, as a table or as a form each; entries holding a group only as forms. */
function Entries({ field }: { readonly field: FieldView }) {
  const isTable = field.rowFields.every((child) => child.type !== "group");
  const [shown, setShown] = useState(isTable ? "table" : "form");
  const entries = sortEntries(field);
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
                  <ReadOnlyForm form={layOutEntryForm(field, entry)} />
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
function LinkedRecords({
  field,
  renderStatus,
  reviewFields,
}: {
  readonly field: FieldView;
  readonly renderStatus?: ((record: CollectionRecordView) => ReactNode) | undefined;
  readonly reviewFields?: ((record: CollectionRecordView) => ReadonlyArray<FieldView>) | undefined;
}) {
  const [openedKey, setOpenedKey] = useState<string | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const opened = field.records.find((record) => record.key === openedKey);
  const collection = field.collection;
  const details =
    opened === undefined || collection === null
      ? []
      : [
          ...(reviewFields?.(opened) ?? []),
          ...buildFieldViews(
            collection.fields.filter(
              (candidate) =>
                candidate.type === "group" &&
                candidate.id !== resolveRecordDisplay(collection).image?.id &&
                !collection.layout?.page?.hiddenFields?.includes(candidate.id),
            ),
            opened.values,
            (id) => opened.files.find((file) => file.id === id) ?? null,
          ),
        ];
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
        <RecordTable
          label={field.label}
          collection={field.collection}
          records={field.records}
          onView={(record) => setOpenedKey(record.key)}
          renderStatus={renderStatus}
        />
      ) : null}
      {opened === undefined || field.collection === null ? null : (
        <Dialog open onOpenChange={(isOpen) => (isOpen ? undefined : setOpenedKey(null))}>
          <DialogPopup ref={popupRef} initialFocus={popupRef} className="sm:max-w-5xl">
            <DialogHeader>
              <DialogTitle>{`${field.label} · ${opened.key}`}</DialogTitle>
              <DialogDescription>Read-only</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <RecordShowcase collection={field.collection} record={opened} />
              {details.length > 0 ? (
                <div className="mt-5 border-t pt-4">
                  <ReadOnlyStepFields fields={details} />
                </div>
              ) : null}
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      )}
    </div>
  );
}

/**
 * Fields in schema order, as blocks a line apart: a run of single fields, a group under its title,
 * a repeatable group's entries, a records field's records.
 */
function ReadOnlyStepFields({
  fields,
  recordStatus,
  recordReviewFields,
}: {
  readonly fields: ReadonlyArray<FieldView>;
  readonly recordStatus?:
    | ((field: FieldView) => ((record: CollectionRecordView) => ReactNode) | undefined)
    | undefined;
  readonly recordReviewFields?:
    | ((field: FieldView, record: CollectionRecordView) => ReadonlyArray<FieldView>)
    | undefined;
}) {
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
        if (first?.type === "records")
          return (
            <LinkedRecords
              key={key}
              field={first}
              renderStatus={recordStatus?.(first)}
              reviewFields={
                recordReviewFields === undefined
                  ? undefined
                  : (record) => recordReviewFields(first, record)
              }
            />
          );
        if (first?.type === "group") {
          return first.repeatable ? (
            <Entries key={key} field={first} />
          ) : (
            <div key={key} className="pt-3">
              <div className="px-4 pb-2">
                <BlockHeading field={first} />
              </div>
              <ReadOnlyStepFields
                fields={first.rows.flatMap((row) => row.fields)}
                recordStatus={recordStatus}
                recordReviewFields={recordReviewFields}
              />
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

export function ConfirmedRecord() {
  return (
    <span className="inline-flex items-center gap-1.5 font-semibold">
      <CheckIcon aria-hidden className="size-4 text-success-foreground" />
      Confirmed
    </span>
  );
}

type ReadOnlyRecordReview = Pick<
  StepView["recordReviews"][number],
  "entries" | "recordKeyFieldId"
> & { readonly group: FieldView; readonly records: FieldView };

export function ReadOnlyStepFieldCard({
  title,
  fields,
  reviews,
  defaultOpen,
}: {
  readonly title: string;
  readonly fields: ReadonlyArray<FieldView>;
  readonly reviews: ReadonlyArray<ReadOnlyRecordReview>;
  readonly defaultOpen: boolean;
}) {
  if (fields.length === 0) return null;
  const shown = fields.filter((field) => {
    const review = reviews.find(({ group }) => group === field);
    return (
      review === undefined ||
      field.rows.some((row) => !review.entries.some(({ rowId }) => rowId === row.id))
    );
  });
  return (
    <CardFold title={title} defaultOpen={defaultOpen}>
      <ReadOnlyStepFields
        fields={shown}
        recordStatus={(field) => {
          const linked = reviews.filter(({ records }) => records === field);
          if (linked.length === 0) return undefined;
          return (record) =>
            linked.map(({ group, entries }) =>
              entries.some(
                ({ recordKey, isConfirmed }) => record.key === recordKey && isConfirmed,
              ) ? (
                <ConfirmedRecord key={group.key} />
              ) : null,
            );
        }}
        recordReviewFields={(field, record) =>
          reviews.flatMap(({ group, records, entries, recordKeyFieldId }) => {
            if (records !== field) return [];
            const rowId = entries.find(({ recordKey }) => recordKey === record.key)?.rowId;
            if (rowId == null) return [];
            const row = group.rows.find(({ id }) => id === rowId);
            return (
              row?.fields.filter(
                ({ key }) => key !== `${group.key}.${rowId}.${recordKeyFieldId}`,
              ) ?? []
            );
          })
        }
      />
    </CardFold>
  );
}
