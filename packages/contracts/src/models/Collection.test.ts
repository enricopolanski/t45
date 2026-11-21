import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  canEditRecords,
  canReadRecords,
  Collection,
  fieldsChangeRefusal,
  filtersProblem,
  recordKeyOf,
  recordProblem,
  relinkProblem,
  removedFields,
  removedOptions,
} from "./Collection.ts";
import { Fields } from "./Field.ts";

const decodeCollection = Schema.decodeUnknownOption(Collection);
const decodeFields = Schema.decodeUnknownSync(Fields);
const encodeFields = Schema.encodeSync(Fields);

const fields = decodeFields([
  { id: "f_asin", label: "ASIN", type: "text" },
  { id: "f_price", label: "Price", type: "number" },
  {
    id: "f_packs",
    label: "Packs",
    type: "group",
    repeatable: true,
    fields: [{ id: "f_rolls", label: "Rolls", type: "number" }],
  },
  { id: "f_manual", label: "Manual", type: "file" },
]);
const listings = { fields, primaryKeyFieldId: "f_asin", memberUserIds: ["member01"] };

describe("collections", () => {
  const encoded = (primaryKeyFieldId: string) => ({
    id: "collection01",
    title: "Amazon listings",
    fields: encodeFields(fields),
    primaryKeyFieldId,
    memberUserIds: [],
    isPublished: false,
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
  });

  it("key their records by one of their own top-level text fields", () => {
    assert.isTrue(Option.isSome(decodeCollection(encoded("f_asin"))));
    assert.isTrue(Option.isNone(decodeCollection(encoded("f_price"))));
    assert.isTrue(Option.isNone(decodeCollection(encoded("f_rolls"))));
    assert.isTrue(Option.isNone(decodeCollection(encoded("f_missing"))));
  });

  it("show their records to admins and the members they list, while active", () => {
    const member = { id: "member01", role: "member", state: "active" } as const;
    assert.isTrue(canEditRecords(member, listings));
    assert.isTrue(canEditRecords({ id: "admin01", role: "admin", state: "active" }, listings));
    assert.isFalse(canEditRecords({ ...member, id: "member02" }, listings));
    assert.isFalse(canEditRecords({ ...member, state: "deactivated" }, listings));
  });

  it("give all active members read access to published collections", () => {
    const visitor = { id: "member02", role: "member", state: "active" } as const;
    const published = { ...listings, isPublished: true };
    assert.isTrue(canReadRecords(visitor, published));
    assert.isFalse(canEditRecords(visitor, published));
    assert.isFalse(canReadRecords({ ...visitor, state: "pending" }, published));
    assert.isFalse(canReadRecords(visitor, { ...published, isPublished: false }));
  });
});

describe("records", () => {
  it("take the trimmed primary key as their key", () => {
    assert.strictEqual(recordKeyOf(listings, { f_asin: " B0ABC " }), "B0ABC");
    assert.isNull(recordKeyOf(listings, { f_asin: "  " }));
    assert.isNull(recordKeyOf(listings, { f_price: 3 }));
  });

  it("need a key and values that fit their fields, in rows their groups list", () => {
    assert.isNull(
      recordProblem(listings, {
        f_asin: "B0ABC",
        f_price: 4.5,
        f_packs: ["row_01"],
        "f_packs.row_01.f_rolls": 6,
        f_manual: "0b0e4a52-8a3b-4f3e-9a51-2f0c3a1d2e4f.pdf",
      }),
    );
    assert.isNotNull(recordProblem(listings, { f_price: 4.5 }));
    assert.isNotNull(recordProblem(listings, { f_asin: "B0ABC", f_price: "4.5" }));
    assert.isNotNull(recordProblem(listings, { f_asin: "B0ABC", f_colour: "red" }));
    assert.isNotNull(recordProblem(listings, { f_asin: "B0ABC", "f_packs.row_02.f_rolls": 6 }));
    assert.isNotNull(recordProblem(listings, { f_asin: "B0ABC", f_manual: "manual.pdf" }));
  });
});

describe("field changes after records exist", () => {
  it("allows Markdown display to change without changing a text field's stored values or type", () => {
    const after = {
      ...listings,
      fields: listings.fields.map((field) =>
        field.type === "text" ? { ...field, isMarkdown: true } : field,
      ),
    };
    assert.isNull(fieldsChangeRefusal(listings, after));
    assert.isNull(fieldsChangeRefusal(after, listings));
    assert.strictEqual(
      fieldsChangeRefusal(after, {
        ...after,
        fields: after.fields.map((field) =>
          field.type === "text" ? { ...field, type: "number" as const } : field,
        ),
      }),
      "fields_locked",
    );
  });

  it("allow choosing and clearing a URL's display field without unlocking stored fields", () => {
    const before = {
      ...listings,
      fields: decodeFields([
        ...encodeFields(fields),
        { id: "product_url", label: "Product URL", type: "url" },
      ]),
    };
    const after = {
      ...before,
      fields: before.fields.map((field) =>
        field.type === "url" ? { ...field, displayLinkOn: "f_asin" } : field,
      ),
    };
    assert.isNull(fieldsChangeRefusal(before, after));
    assert.isNull(fieldsChangeRefusal(after, before));
    assert.strictEqual(
      fieldsChangeRefusal(after, {
        ...after,
        fields: after.fields.map((field) =>
          field.type === "url" ? { ...field, type: "text" as const } : field,
        ),
      }),
      "fields_locked",
    );
  });

  it("add fields or change how they show, keeping each field they keep as it was", () => {
    const added = decodeFields([
      ...encodeFields(fields),
      { id: "f_checked", label: "Checked at", type: "text" },
    ]);
    assert.isNull(fieldsChangeRefusal(listings, { ...listings, fields: added }));
    const detailOnly = decodeFields(
      encodeFields(fields).map((field) => ({ ...field, isDetailOnly: field.id === "f_manual" })),
    );
    assert.isNull(fieldsChangeRefusal(listings, { ...listings, fields: detailOnly }));
    const rounded = decodeFields(
      encodeFields(fields).map((field) =>
        field.id === "f_price" ? { ...field, decimals: 2, unit: "€" } : field,
      ),
    );
    assert.isNull(fieldsChangeRefusal(listings, { ...listings, fields: rounded }));
    const laidOut = decodeFields(
      encodeFields(fields).map((field) =>
        field.id === "f_packs"
          ? { ...field, layout: { table: { sortBy: [{ field: "f_rolls", direction: "desc" }] } } }
          : field,
      ),
    );
    assert.isNull(fieldsChangeRefusal(listings, { ...listings, fields: laidOut }));
    assert.strictEqual(
      fieldsChangeRefusal(listings, {
        ...listings,
        fields: fields.map((field) =>
          field.id === "f_price" && field.type === "number"
            ? { ...field, type: "text" as const }
            : field,
        ),
      }),
      "fields_locked",
    );
    assert.strictEqual(
      fieldsChangeRefusal(listings, { ...listings, fields: added, primaryKeyFieldId: "f_checked" }),
      "fields_locked",
    );
  });

  it("let any field but the primary key go, leaving the records' values to check", () => {
    const withoutPacks = fields.filter((field) => field.id !== "f_packs");
    assert.isNull(fieldsChangeRefusal(listings, { ...listings, fields: withoutPacks }));
    assert.deepStrictEqual(
      removedFields(fields, withoutPacks).map(({ id }) => id),
      ["f_packs"],
    );
    assert.strictEqual(
      fieldsChangeRefusal(listings, { ...listings, fields: fields.slice(1) }),
      "fields_locked",
    );
  });
});

describe("record filters", () => {
  it("take a value on a field, and a range only on a number or date field", () => {
    assert.isNull(filtersProblem(fields, { f_asin: "B0ABC", f_price: { min: 2, max: 5 } }));
    assert.isNotNull(filtersProblem(fields, { f_asin: { min: "A" } }));
    assert.isNotNull(filtersProblem(fields, { f_price: { min: "cheap" } }));
    assert.isNotNull(filtersProblem(fields, { f_packs: 2 }));
    assert.isNotNull(filtersProblem(fields, { f_missing: "x" }));
  });
});

describe("links to another collection's record", () => {
  const specs = decodeFields([
    { id: "f_product", label: "Product", type: "foreignKey", collectionId: "competitor_products" },
    { id: "f_width", label: "Width", type: "number" },
  ]);

  it("key a collection's records by the record they link", () => {
    const tapes = {
      id: "masking_tapes",
      title: "Masking tapes",
      fields: encodeFields(specs),
      primaryKeyFieldId: "f_product",
      memberUserIds: [],
      isPublished: false,
      createdAt: "2026-11-20T00:00:00.000Z",
      updatedAt: "2026-11-20T00:00:00.000Z",
    };
    assert.isTrue(Option.isSome(decodeCollection(tapes)));
    assert.strictEqual(recordKeyOf(tapes, { f_product: "wurth-0992619" }), "wurth-0992619");
    assert.isNotNull(recordProblem({ ...tapes, fields: specs }, { f_product: ["wurth-0992619"] }));
  });

  it("only sit at the top level of a collection", () => {
    assert.throws(() =>
      decodeFields([
        {
          id: "f_specs",
          label: "Specs",
          type: "group",
          repeatable: false,
          fields: [
            {
              id: "f_product",
              label: "Product",
              type: "foreignKey",
              collectionId: "competitor_products",
            },
          ],
        },
      ]),
    );
  });

  it("are set and cleared, but not pointed to another record", () => {
    const linked = { f_product: "wurth-0992619", f_width: 18 };
    assert.isNull(relinkProblem(specs, { f_width: 18 }, linked));
    assert.isNull(relinkProblem(specs, linked, { ...linked, f_width: 19 }));
    assert.isNull(relinkProblem(specs, linked, { f_width: 18 }));
    assert.isNotNull(relinkProblem(specs, linked, { ...linked, f_product: "wurth-0992620" }));
  });
});

describe("selects", () => {
  const tapes = {
    fields: decodeFields([
      { id: "f_product", label: "Product", type: "text" },
      {
        id: "f_uses",
        label: "Uses",
        type: "select",
        options: ["Masking", "Sealing"],
        isMultiple: true,
      },
    ]),
    primaryKeyFieldId: "f_product",
  };

  it("hold several distinct options when multiple, and filter on one of them", () => {
    assert.isNull(recordProblem(tapes, { f_product: "p1", f_uses: ["Masking", "Sealing"] }));
    assert.isNotNull(recordProblem(tapes, { f_product: "p1", f_uses: "Masking" }));
    assert.isNotNull(recordProblem(tapes, { f_product: "p1", f_uses: ["Masking", "Masking"] }));
    assert.isNotNull(recordProblem(tapes, { f_product: "p1", f_uses: ["Bundling"] }));
    assert.isNull(filtersProblem(tapes.fields, { f_uses: "Sealing" }));
    assert.isNotNull(filtersProblem(tapes.fields, { f_uses: "Bundling" }));
  });

  it("hold several options only at a collection's top level", () => {
    assert.throws(() =>
      decodeFields([
        {
          id: "f_specs",
          label: "Specs",
          type: "group",
          repeatable: false,
          fields: [
            { id: "f_uses", label: "Uses", type: "select", options: ["Masking"], isMultiple: true },
          ],
        },
      ]),
    );
  });

  it("change their options after records exist, telling which ones they lose", () => {
    const renamed = tapes.fields.map((field) =>
      field.type === "select" ? { ...field, options: ["Masking", "Abdichten", "Bundling"] } : field,
    );
    assert.isNull(fieldsChangeRefusal(tapes, { ...tapes, fields: renamed }));
    assert.deepStrictEqual(
      removedOptions(tapes.fields, renamed).map(({ option }) => option),
      ["Sealing"],
    );
    const single = tapes.fields.map((field) =>
      field.type === "select" ? { ...field, isMultiple: false } : field,
    );
    assert.strictEqual(fieldsChangeRefusal(tapes, { ...tapes, fields: single }), "fields_locked");
  });
});
