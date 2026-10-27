import { assert, describe, it } from "vite-plus/test";
import { buildToastLayout } from "./toast.logic";

function slots(layout: {
  items: ReadonlyArray<{ toast: { id: string }; index: number; offsetY: number }>;
}) {
  return layout.items.map(({ toast, index, offsetY }) => ({ id: toast.id, index, offsetY }));
}

describe("buildToastLayout", () => {
  it("stacks toasts by index and the heights in front of them", () => {
    const layout = buildToastLayout([
      { id: "a", height: 48 },
      { id: "b", height: 72 },
      { id: "c", height: 24 },
    ]);

    assert.equal(layout.frontmostHeight, 48);
    assert.deepEqual(slots(layout), [
      { id: "a", index: 0, offsetY: 0 },
      { id: "b", index: 1, offsetY: 48 },
      { id: "c", index: 2, offsetY: 120 },
    ]);
  });

  it("reflows live toasts forward when the front toast is dismissed", () => {
    const layout = buildToastLayout([
      { id: "a", height: 48, transitionStatus: "ending" as const },
      { id: "b", height: 72 },
      { id: "c", height: 24 },
    ]);

    // The stack sizes to the first toast that stays, not the one leaving.
    assert.equal(layout.frontmostHeight, 72);
    assert.deepEqual(slots(layout), [
      { id: "a", index: 0, offsetY: 0 },
      { id: "b", index: 0, offsetY: 0 },
      { id: "c", index: 1, offsetY: 72 },
    ]);
  });

  it("keeps a non-front ending toast at its current slot so it exits straight", () => {
    const layout = buildToastLayout([
      { id: "a", height: 48 },
      { id: "b", height: 72, transitionStatus: "ending" as const },
      { id: "c", height: 24 },
    ]);

    assert.equal(layout.frontmostHeight, 48);
    assert.deepEqual(slots(layout), [
      { id: "a", index: 0, offsetY: 0 },
      // The leaving toast exits from where it was seen while the one behind takes its slot.
      { id: "b", index: 1, offsetY: 48 },
      { id: "c", index: 1, offsetY: 48 },
    ]);
  });
});
