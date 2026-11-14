import { assert, describe, it } from "@effect/vitest";

import {
  defaultValues,
  type Field,
  fieldValueProblem,
  hasValidLinkTargets,
  valuesProblem,
  withFieldValue,
} from "./Field.ts";

const source = { id: "source", label: "Source", type: "url" } as const;
const link = "https://example.com/listing";

describe("URL fields", () => {
  it("can display their link on any other field in the same row", () => {
    const targets: ReadonlyArray<Field> = [
      { id: "title", label: "Title", type: "text" },
      { id: "price", label: "Price", type: "number" },
      { id: "available", label: "Available", type: "boolean" },
      { id: "checked", label: "Checked", type: "date" },
      { id: "brand", label: "Brand", type: "select", options: ["Tesa"] },
      { id: "manual", label: "Manual", type: "file" },
      { id: "website", label: "Website", type: "url" },
      { id: "specs", label: "Specs", type: "group", repeatable: false, fields: [] },
      { id: "listings", label: "Listings", type: "records", collectionId: "amazon" },
    ];
    for (const target of targets)
      assert.isTrue(hasValidLinkTargets([target, { ...source, displayLinkOn: target.id }]));
    assert.isFalse(hasValidLinkTargets([{ ...source, displayLinkOn: source.id }]));
    assert.isFalse(hasValidLinkTargets([{ ...source, displayLinkOn: "missing" }]));
    const title = targets[0]!;
    const references = {
      id: "references",
      label: "References",
      type: "group",
      repeatable: true,
      fields: [{ ...source, displayLinkOn: title.id }],
    } as const;
    assert.isFalse(hasValidLinkTargets([title, references]));
    assert.isTrue(hasValidLinkTargets([{ ...references, fields: [title, ...references.fields] }]));
  });

  it("hold a web address as a string without a separate label", () => {
    assert.isNull(fieldValueProblem(source, "source", link));
    assert.isNotNull(fieldValueProblem(source, "source", { url: link, label: "Product listing" }));
    assert.isNotNull(fieldValueProblem(source, "source", ""));
    assert.isNotNull(fieldValueProblem(source, "source", "https://"));
    assert.isNotNull(fieldValueProblem(source, "source", "javascript:alert(1)"));
    assert.isNotNull(fieldValueProblem(source, "source", "https://example.com/not a url"));
  });

  it("preserve URL strings through defaults, repeated rows, edits and clearing", () => {
    const fields: ReadonlyArray<Field> = [
      { ...source, defaultValue: link },
      { id: "references", label: "References", type: "group", repeatable: true, fields: [source] },
    ];
    const initial = defaultValues(fields);
    assert.deepStrictEqual(initial, { source: link });
    const rows = withFieldValue(fields, initial, "references", ["first01"]);
    const filled = withFieldValue(fields, rows, "references.first01.source", link);
    assert.isNull(valuesProblem(fields, filled));
    assert.deepStrictEqual(filled["references.first01.source"], link);
    const changed = withFieldValue(fields, filled, "source", "https://example.com/updated");
    assert.strictEqual(changed.source, "https://example.com/updated");
    assert.deepStrictEqual(withFieldValue(fields, changed, "source", null), {
      references: ["first01"],
      "references.first01.source": link,
    });
  });
});

describe("Records fields", () => {
  it("link records by their keys, each once, and start with none", () => {
    const listings = {
      id: "listings",
      label: "Listings",
      type: "records",
      collectionId: "amazon",
    } as const;
    assert.deepStrictEqual(defaultValues([listings]), {});
    assert.isNull(fieldValueProblem(listings, "listings", ["B0ABC 1", "B0XYZ"]));
    assert.isNotNull(fieldValueProblem(listings, "listings", ["B0ABC", "B0ABC"]));
    assert.isNotNull(fieldValueProblem(listings, "listings", [" "]));
    assert.isNotNull(fieldValueProblem(listings, "listings", "B0ABC"));
  });
});
