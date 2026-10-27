const PAGE_SCROLL_ALIGNMENT_OFFSET_PX = 36;
const PAGE_SCROLL_BOUNDARY_EPSILON_PX = 1;

export type PageScrollKey = "PageUp" | "PageDown";

type PageScrollMetrics = {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
};

function canScrollInDirection(
  { clientHeight, scrollHeight, scrollTop }: PageScrollMetrics,
  key: PageScrollKey,
): boolean {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const clampedScrollTop = Math.min(maxScrollTop, Math.max(0, scrollTop));
  return key === "PageUp"
    ? clampedScrollTop > PAGE_SCROLL_BOUNDARY_EPSILON_PX
    : clampedScrollTop < maxScrollTop - PAGE_SCROLL_BOUNDARY_EPSILON_PX;
}

/**
 * The page key the composer hands to the timeline: a plain PageUp or PageDown, once the
 * composer's own text can't scroll that way.
 */
export function getTimelinePageScrollKey({
  altKey,
  clientHeight,
  ctrlKey,
  defaultPrevented,
  isComposing,
  key,
  keyCode,
  metaKey,
  scrollHeight,
  scrollTop,
  shiftKey,
}: {
  altKey: boolean;
  clientHeight: number;
  ctrlKey: boolean;
  defaultPrevented: boolean;
  isComposing: boolean;
  key: string;
  keyCode: number;
  metaKey: boolean;
  scrollHeight: number;
  scrollTop: number;
  shiftKey: boolean;
}): PageScrollKey | null {
  if (key !== "PageUp" && key !== "PageDown") return null;
  if (
    defaultPrevented ||
    isComposing ||
    keyCode === 229 ||
    altKey ||
    ctrlKey ||
    metaKey ||
    shiftKey
  ) {
    return null;
  }
  return canScrollInDirection({ clientHeight, scrollHeight, scrollTop }, key) ? null : key;
}

/**
 * Scrolls the timeline a page from `from` for a page key the composer handed over, less what the
 * composer covers and a margin that keeps the last line in view. A held key repeats from the
 * previous target, so the scroll keeps its pace instead of restarting. Returns the target, or
 * null when there is nowhere to scroll.
 */
export function scrollTimelinePage(
  timeline: HTMLElement,
  key: PageScrollKey,
  coveredPx: number,
  from: number,
): number | null {
  if (!canScrollInDirection(timeline, key)) return null;
  const page = Math.max(
    0,
    timeline.getBoundingClientRect().height - PAGE_SCROLL_ALIGNMENT_OFFSET_PX - coveredPx,
  );
  const end = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
  const top = Math.min(end, Math.max(0, from + (key === "PageUp" ? -page : page)));
  timeline.scrollTo({ top, behavior: "smooth" });
  return top;
}
