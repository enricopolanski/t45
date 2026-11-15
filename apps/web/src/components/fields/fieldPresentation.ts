import type {
  resolveFormLayout,
  resolveTableLayout,
  TableColumn,
} from "@t45/contracts/models/Layout";

/** How many ch `text` takes: capitals, m, w and % count wider than the "0" a ch measures. */
const measureText = (text: string) =>
  [...text].reduce((sum, char) => sum + (/[A-Zmw%]/u.test(char) ? 1.5 : 1), 0);

export const FIXED_WIDTHS = { narrow: 8, medium: 14, wide: 30 };

/**
 * How many ch a table column wants: its fixed width, or else its header's longest word, as
 * headers wrap only between words and are smaller than cells, or the widest of `shownValues`, its
 * entries' values as shown; a select its widest option, a tone's icon 3ch, and room for its
 * chevron; a date, switch or file at least its control. Text cut to one line stops at 28ch,
 * wrapped text at 40ch; then room for the padding.
 */
export const measureColumnWidth = (
  { field, header, width, isWrapped }: TableColumn,
  shownValues: ReadonlyArray<string>,
) => {
  if (width !== undefined) return FIXED_WIDTHS[width];
  const headerWidth = (Math.max(...header.split(/\s+/u).map(measureText)) * 12) / 14;
  const values =
    field.type === "select"
      ? field.options.map(
          (option) => (field.tones?.[option] === undefined ? measureText(option) : 3) + 2,
        )
      : shownValues.map(measureText);
  const control =
    field.type === "date" ? 14 : field.type === "boolean" ? 4 : field.type === "file" ? 10 : 0;
  return Math.min(Math.max(headerWidth, control, ...values), isWrapped ? 40 : 28) + 2;
};

/** The six parts of a form's row a field takes, from a phone's single column up. */
export const FORM_SPANS: Record<
  ReturnType<typeof resolveFormLayout>["fields"][number]["span"],
  string
> = {
  third: "sm:col-span-2",
  half: "sm:col-span-3",
  "two-thirds": "sm:col-span-4",
  full: "sm:col-span-6",
};

type Spacing = ReturnType<typeof resolveFormLayout>["spacing"];

/** The grid of an entry's or record's form: six parts to a row, one field to a row on a phone. */
export const FORM_GRIDS: Record<Spacing, string> = {
  compact: "grid grid-cols-1 gap-2 sm:grid-cols-6",
  normal: "grid grid-cols-1 gap-3 sm:grid-cols-6",
  relaxed: "grid grid-cols-1 gap-5 sm:grid-cols-6",
};

/**
 * A table's density for cells holding controls, whose own height and padding set the room: compact
 * shrinks them, relaxed pads the cell.
 */
export const CONTROL_CELL_DENSITY: Record<
  ReturnType<typeof resolveTableLayout>["density"],
  string
> = {
  compact: "[&_td>*]:min-h-7 [&_textarea]:min-h-7 [&_textarea]:py-1 [&_input]:h-7",
  normal: "",
  relaxed: "[&_td]:py-1",
};
