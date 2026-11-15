import { assert, describe, it } from "@effect/vitest";

import type { Field } from "./Field.ts";
import { resolveFormLayout, resolveTableLayout, sortRows } from "./Layout.ts";

const fields: ReadonlyArray<Field> = [
  { id: "notes", label: "Notes", type: "text" },
  { id: "size", label: "Size", type: "text" },
  { id: "price", label: "Price per packaging unit", type: "number" },
  { id: "rating", label: "Rating", type: "select", options: ["Good", "Bad"] },
  { id: "manual", label: "Manual", type: "file", isDetailOnly: true },
];

describe("Tables", () => {
  it("list every field not shown only in details, as defined, without a layout", () => {
    const table = resolveTableLayout(fields, undefined);
    assert.deepStrictEqual(
      table.columns.map((column) => [column.field.id, column.header, column.isWrapped]),
      [
        ["notes", "Notes", false],
        ["size", "Size", false],
        ["price", "Price per packaging unit", false],
        ["rating", "Rating", false],
      ],
    );
    assert.deepStrictEqual(table.sortBy, []);
    assert.strictEqual(table.density, "normal");
  });

  it("list exactly the layout's columns, in its order, with their headers, widths and wrapping", () => {
    const table = resolveTableLayout(fields, {
      table: {
        columns: [
          { field: "manual" },
          { field: "price", header: "Price", width: "narrow" },
          { field: "gone" },
          { field: "notes", isWrapped: true },
        ],
        density: "compact",
      },
    });
    assert.deepStrictEqual(
      table.columns.map((column) => [
        column.field.id,
        column.header,
        column.width,
        column.isWrapped,
      ]),
      [
        ["manual", "Manual", undefined, false],
        ["price", "Price", "narrow", false],
        ["notes", "Notes", undefined, true],
      ],
    );
    assert.strictEqual(table.density, "compact");
  });

  it("sort only on fields that are still there", () => {
    const table = resolveTableLayout(fields, {
      table: {
        sortBy: [
          { field: "gone", direction: "asc" },
          { field: "size", direction: "desc" },
        ],
      },
    });
    assert.deepStrictEqual(table.sortBy, [{ field: "size", direction: "desc" }]);
  });
});

describe("Forms", () => {
  const shown = (layout?: Parameters<typeof resolveFormLayout>[1]) =>
    resolveFormLayout(fields, layout).fields.map(({ field, span }) => [field.id, span]);

  it("show every other field before the text fields, text whole rows and choices half", () => {
    assert.deepStrictEqual(shown(), [
      ["price", "third"],
      ["rating", "half"],
      ["manual", "third"],
      ["notes", "full"],
      ["size", "full"],
    ]);
    assert.strictEqual(resolveFormLayout(fields, undefined).dialogWidth, undefined);
  });

  it("show the layout's fields in its order and spans, then the rest as usual", () => {
    assert.deepStrictEqual(
      shown({
        form: {
          fields: [
            { field: "size", span: "two-thirds" },
            { field: "gone", span: "full" },
            { field: "rating", span: "third" },
          ],
        },
      }),
      [
        ["size", "two-thirds"],
        ["rating", "third"],
        ["price", "third"],
        ["manual", "third"],
        ["notes", "full"],
      ],
    );
  });
});

describe("Sorted rows", () => {
  const rows = [
    { id: "r1", size: "100MM", price: 2 },
    { id: "r2", size: null, price: 1 },
    { id: "r3", size: "19mm", price: 5 },
    { id: "r4", size: "19MM", price: 3 },
    { id: "r5", size: "100MM", price: 10 },
  ];
  const order = (sortBy: Parameters<typeof sortRows>[1]) =>
    sortRows(rows, sortBy, (row, fieldId) => row[fieldId as "size" | "price"]).map((row) => row.id);

  it("compare numbers inside text as numbers, keeping ties in stored order and empty last", () => {
    assert.deepStrictEqual(order([{ field: "size", direction: "asc" }]), [
      "r3",
      "r4",
      "r1",
      "r5",
      "r2",
    ]);
    assert.deepStrictEqual(order([]), ["r1", "r2", "r3", "r4", "r5"]);
  });

  it("reverse descending sorts but still show empty values last", () => {
    assert.deepStrictEqual(order([{ field: "size", direction: "desc" }]), [
      "r1",
      "r5",
      "r3",
      "r4",
      "r2",
    ]);
  });

  it("settle ties with the next sort, numbers by size", () => {
    assert.deepStrictEqual(
      order([
        { field: "size", direction: "asc" },
        { field: "price", direction: "desc" },
      ]),
      ["r3", "r4", "r5", "r1", "r2"],
    );
    assert.deepStrictEqual(order([{ field: "price", direction: "asc" }]), [
      "r2",
      "r1",
      "r4",
      "r3",
      "r5",
    ]);
  });
});
