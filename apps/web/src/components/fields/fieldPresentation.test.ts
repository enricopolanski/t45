import type { Field } from "@t45/contracts/models/Field";
import { describe, expect, it } from "vite-plus/test";

import { measureColumnWidth } from "./fieldPresentation";

const makeColumn = (field: Field, isWrapped = false) => ({
  field,
  header: field.label,
  width: undefined,
  isWrapped,
});

const text = (label: string, isWrapped?: boolean) =>
  makeColumn({ id: "field", label, type: "text" }, isWrapped);

describe("measureColumnWidth", () => {
  it("fits the widest value shown, capitals wider than digits", () => {
    expect(measureColumnWidth(text("Variant"), ["19MMX50M", "25MMX50M"])).toBeGreaterThanOrEqual(
      12,
    );
    expect(measureColumnWidth(text("Variant"), ["19MMX50M"])).toBeGreaterThan(
      measureColumnWidth(text("Variant"), ["19000500"]),
    );
  });

  it("fits its header's longest word, not the whole header", () => {
    expect(measureColumnWidth(text("Margin on purchase cost"), [])).toBeLessThan(
      measureColumnWidth(text("Marginonpurchasecost"), []),
    );
  });

  it("fits a select's widest option and its chevron, a toned option as its icon", () => {
    const select = (tones?: Record<string, "warning">) =>
      makeColumn({
        id: "pu",
        label: "PU",
        type: "select",
        options: ["PU1", "Long option"],
        ...(tones === undefined ? {} : { tones }),
      });
    expect(measureColumnWidth(select(), [])).toBeGreaterThan(
      measureColumnWidth(text("PU"), ["Long option"]),
    );
    expect(measureColumnWidth(select({ "Long option": "warning" }), [])).toBeLessThan(
      measureColumnWidth(select(), []),
    );
  });

  it("stops long text at 28ch on one line and 40ch wrapped", () => {
    const long = "x".repeat(100);
    expect(measureColumnWidth(text("Reason"), [long])).toBe(30);
    expect(measureColumnWidth(text("Reason", true), [long])).toBe(42);
  });

  it("takes a fixed width whatever it shows", () => {
    expect(measureColumnWidth({ ...text("Reason"), width: "narrow" }, ["x".repeat(100)])).toBe(8);
  });
});
