import { assert, describe, it } from "@effect/vitest";

import {
  defaultValues,
  type Field,
  fieldValueProblem,
  valuesProblem,
  withFieldValue,
} from "./Field.ts";

const source = { id: "source", label: "Source", type: "url" } as const;
const link = "https://example.com/listing";

describe("URL fields", () => {
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
