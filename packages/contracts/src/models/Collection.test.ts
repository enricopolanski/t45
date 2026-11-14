import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  canEditRecords,
  Collection,
  fieldsChangeRefusal,
  recordKeyOf,
  recordProblem,
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
  it("only add fields, keeping the others and the primary key as they were", () => {
    const added = decodeFields([
      ...encodeFields(fields),
      { id: "f_checked", label: "Checked at", type: "text" },
    ]);
    assert.isNull(fieldsChangeRefusal(listings, { ...listings, fields: added }));
    assert.strictEqual(
      fieldsChangeRefusal(listings, { ...listings, fields: fields.slice(1) }),
      "fields_locked",
    );
    assert.strictEqual(
      fieldsChangeRefusal(listings, {
        ...listings,
        fields: fields.map((field) =>
          field.id === "f_price" ? { ...field, type: "text" as const } : field,
        ),
      }),
      "fields_locked",
    );
    assert.strictEqual(
      fieldsChangeRefusal(listings, { ...listings, fields: added, primaryKeyFieldId: "f_checked" }),
      "fields_locked",
    );
  });
});
