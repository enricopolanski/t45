import { describe, expect, it } from "vite-plus/test";

import { resolveTimelineIsAtEnd, timelineContentOverflowsViewport } from "./timelineScroll";

function buildState({
  positions,
  sizes,
  scrollLength = 700,
}: {
  readonly positions: readonly number[];
  readonly sizes: readonly number[];
  readonly scrollLength?: number;
}) {
  return {
    data: positions.map((_, index) => index),
    scrollLength,
    positionAtIndex: (index: number) => positions[index],
    sizeAtIndex: (index: number) => sizes[index],
  };
}

describe("timelineContentOverflowsViewport", () => {
  const inset = 100;

  it("reports overflow from the last row, not the inset spacer", () => {
    const fits = buildState({ positions: [0, 200], sizes: [200, 300], scrollLength: 700 });
    expect(timelineContentOverflowsViewport(fits, inset)).toBe(false);

    const overflows = buildState({ positions: [0, 200], sizes: [200, 400], scrollLength: 700 });
    expect(timelineContentOverflowsViewport(overflows, inset)).toBe(true);
  });

  it("treats an empty or unmeasured list as fitting", () => {
    expect(timelineContentOverflowsViewport(undefined, inset)).toBe(false);
    expect(
      timelineContentOverflowsViewport(
        buildState({ positions: [0, 200], sizes: [200, 400], scrollLength: 0 }),
        inset,
      ),
    ).toBe(false);
    expect(timelineContentOverflowsViewport(buildState({ positions: [], sizes: [] }), inset)).toBe(
      false,
    );
    expect(
      timelineContentOverflowsViewport(
        buildState({ positions: [0, 200], sizes: [200, Number.NaN] }),
        inset,
      ),
    ).toBe(false);
  });
});

describe("resolveTimelineIsAtEnd", () => {
  it("counts the last few pixels above the composer as the end", () => {
    expect(resolveTimelineIsAtEnd({ contentLength: 1000, scroll: 280, scrollLength: 700 })).toBe(
      true,
    );
    expect(resolveTimelineIsAtEnd({ contentLength: 1000, scroll: 100, scrollLength: 700 })).toBe(
      false,
    );
  });

  it("falls back to the list's own flag before it is measured", () => {
    expect(resolveTimelineIsAtEnd({ isAtEnd: true })).toBe(true);
    expect(resolveTimelineIsAtEnd(undefined)).toBeUndefined();
  });
});
