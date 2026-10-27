/** Space kept under the chat header fade above the first row. */
const CHAT_TIMELINE_TOP_OFFSET = 24;

/** How close to the end the timeline counts as at the end, so live follow re-arms. */
const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

/**
 * Whether the timeline's real rows extend past the viewport left above the
 * composer. The list's own content length includes the composer inset
 * spacer, so this measures from the last row instead. Unknown row geometry
 * or an unmeasured viewport counts as fitting.
 */
export function timelineContentOverflowsViewport(
  state: TimelineListMeasurementState | undefined,
  composerInset: number,
): boolean {
  if (!state || state.data.length === 0 || !(state.scrollLength > 0)) return false;
  const top = state.positionAtIndex(state.data.length - 1);
  const height = state.sizeAtIndex(state.data.length - 1);
  if (typeof top !== "number" || typeof height !== "number" || !Number.isFinite(top + height)) {
    return false;
  }
  return (
    top + Math.max(1, height) >
    Math.max(0, state.scrollLength - composerInset - CHAT_TIMELINE_TOP_OFFSET)
  );
}

/**
 * Whether the timeline sits at its live end. The content length includes the
 * composer inset spacer, but the composer hides the same amount of viewport,
 * so the inset cancels and the plain gap is what is left to scroll. LegendList's
 * own flag is only a fallback before the list is measured.
 */
export function resolveTimelineIsAtEnd(state: TimelineEndState | undefined): boolean | undefined {
  if (!state) return undefined;
  const { contentLength, scroll, scrollLength } = state;
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd;
  }
  return contentLength - scroll - scrollLength <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
}
