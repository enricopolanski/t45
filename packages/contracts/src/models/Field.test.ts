import { assert, describe, it } from "@effect/vitest";

import {
  defaultValues,
  type Field,
  fieldValueProblem,
  valuesProblem,
  withFieldValue,
} from "./Field.ts";

const source = { id: "source", label: "Source", type: "url" } as const;
const link = { url: "https://example.com/listing", label: "Product listing" };

describe("URL fields", () => {
  it("require a web destination and non-empty link text together", () => {
    assert.isNull(fieldValueProblem(source, "source", link));
    assert.isNotNull(fieldValueProblem(source, "source", link.url));
    assert.isNotNull(fieldValueProblem(source, "source", { url: link.url }));
    assert.isNotNull(fieldValueProblem(source, "source", { ...link, label: " " }));
    assert.isNotNull(fieldValueProblem(source, "source", { ...link, url: "https://" }));
    assert.isNotNull(fieldValueProblem(source, "source", { ...link, url: "javascript:alert(1)" }));
  });

  it("keep each link together through defaults, repeated rows, edits and clearing", () => {
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
    const changed = withFieldValue(fields, filled, "source", { ...link, label: "Updated listing" });
    assert.deepStrictEqual(changed.source, { ...link, label: "Updated listing" });
    assert.deepStrictEqual(withFieldValue(fields, changed, "source", null), {
      references: ["first01"],
      "references.first01.source": link,
    });
  });
});
