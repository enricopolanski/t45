import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";

import { cn } from "~/lib/utils";

const MAX_ZOOM = 8;
const PAN_STEPS = new Map<string, ScrollToOptions>([
  ["ArrowLeft", { left: -40 }],
  ["ArrowRight", { left: 40 }],
  ["ArrowUp", { top: -40 }],
  ["ArrowDown", { top: 40 }],
]);

export interface ZoomableImageHandle {
  pan: (key: string) => boolean;
}

/** Zooms around the pointer and keeps the whole image accessible by dragging or scrolling. */
export function ZoomableImage({
  src,
  name,
  onError,
  ref,
}: {
  src: string;
  name: string;
  onError: () => void;
  ref?: Ref<ZoomableImageHandle>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [fitted, setFitted] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const anchorRef = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const suppressClickRef = useRef(false);

  useImperativeHandle(
    ref,
    () => ({
      pan(key) {
        const viewport = viewportRef.current;
        const step = PAN_STEPS.get(key);
        if (!viewport || !step || zoomRef.current <= 1) return false;
        // A vertical scrollbar alone must not swallow gallery navigation.
        if (step.left !== undefined && viewport.scrollWidth <= viewport.offsetWidth) return false;
        viewport.scrollBy(step);
        return true;
      },
    }),
    [],
  );

  const changeZoom = useCallback((next: number, point?: { x: number; y: number }) => {
    const viewport = viewportRef.current;
    const previous = zoomRef.current;
    const clamped = Math.min(MAX_ZOOM, Math.max(1, next));
    if (!viewport || previous === clamped) return;
    if (previous === 1) {
      const image = imageRef.current?.getBoundingClientRect();
      if (!image?.width) return;
      setFitted({ width: image.width, height: image.height });
    }
    const bounds = viewport.getBoundingClientRect();
    const x = point ? point.x - bounds.left : viewport.clientWidth / 2;
    const y = point ? point.y - bounds.top : viewport.clientHeight / 2;
    anchorRef.current = {
      x: (viewport.scrollLeft + x) / previous,
      y: (viewport.scrollTop + y) / previous,
      clientX: bounds.left + x,
      clientY: bounds.top + y,
    };
    zoomRef.current = clamped;
    setZoom(clamped);
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const anchor = anchorRef.current;
    if (!viewport || !anchor) return;
    const bounds = viewport.getBoundingClientRect();
    viewport.scrollLeft = anchor.x * zoom - (anchor.clientX - bounds.left);
    viewport.scrollTop = anchor.y * zoom - (anchor.clientY - bounds.top);
    anchorRef.current = null;
  }, [zoom]);

  useEffect(() => {
    const fit = () => changeZoom(1);
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [changeZoom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      changeZoom(zoomRef.current * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), {
        x: event.clientX,
        y: event.clientY,
      });
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, [changeZoom]);

  return (
    <div className="min-w-0">
      <div
        ref={viewportRef}
        role="region"
        aria-label={`${name}, zoomable image`}
        aria-description="Click to zoom in or return to fit. Scroll to zoom, drag to pan. Use Enter to toggle zoom, plus or minus to zoom, and 0 to fit."
        tabIndex={0}
        data-zoomed={zoom > 1 ? "" : undefined}
        className="max-h-(--media-height) w-fit max-w-(--media-width) cursor-zoom-in overflow-auto overscroll-contain rounded-lg bg-background shadow-2xl ring-1 ring-border/70 outline-none focus-visible:ring-2 focus-visible:ring-ring data-zoomed:cursor-grab data-zoomed:active:cursor-grabbing"
        onClick={(event) => {
          // Pointer capture also produces a click after dragging; leave the image zoomed.
          if (suppressClickRef.current || event.detail > 1) return;
          changeZoom(zoomRef.current > 1 ? 1 : 2, { x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!event.repeat) changeZoom(zoomRef.current > 1 ? 1 : 2);
          } else if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            changeZoom(zoomRef.current * 1.5);
          } else if (event.key === "-") {
            event.preventDefault();
            changeZoom(zoomRef.current / 1.5);
          } else if (event.key === "0") {
            event.preventDefault();
            changeZoom(1);
          }
        }}
        onPointerDown={(event) => {
          if (dragRef.current) return;
          suppressClickRef.current = false;
          if (event.pointerType !== "mouse" || event.button !== 0 || zoomRef.current <= 1) return;
          const viewport = event.currentTarget;
          const bounds = viewport.getBoundingClientRect();
          if (
            event.clientX - bounds.left >= viewport.clientWidth ||
            event.clientY - bounds.top >= viewport.clientHeight
          )
            return;
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: viewport.scrollLeft,
            top: viewport.scrollTop,
          };
          viewport.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) {
            suppressClickRef.current = true;
          }
          event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x);
          event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y);
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          dragRef.current = null;
        }}
        onLostPointerCapture={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
        }}
      >
        <img
          ref={imageRef}
          src={src}
          alt={name}
          draggable={false}
          className={cn(
            "block select-none",
            zoom > 1 ? "max-w-none" : "max-h-(--media-height) max-w-(--media-width)",
          )}
          style={
            zoom > 1 ? { width: fitted.width * zoom, height: fitted.height * zoom } : undefined
          }
          onError={onError}
        />
      </div>
      <span className="sr-only" aria-live="polite">
        {Math.round(zoom * 100)}% zoom
      </span>
    </div>
  );
}
