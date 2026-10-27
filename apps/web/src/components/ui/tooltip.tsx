import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";

type TooltipActionsRef = RefObject<TooltipPrimitive.Root.Actions | null>;
const TooltipHoverContext = createContext<TooltipActionsRef | null>(null);

/** Remembers the last hovered trigger in a scroll area, outside React state. */
function makeHoveredTooltipTracker() {
  let hovered: { trigger: HTMLElement; actionsRef: TooltipActionsRef } | null = null;
  return {
    enter: (trigger: HTMLElement, actionsRef: TooltipActionsRef) => {
      hovered = { trigger, actionsRef };
    },
    /** Forgets the hovered trigger when it belongs to `actionsRef`. */
    leave: (actionsRef: TooltipActionsRef) => {
      if (hovered?.actionsRef === actionsRef) hovered = null;
    },
    /** Closes the hovered tooltip unless its trigger holds focus. */
    dismiss: () => {
      const tooltip = hovered;
      if (!tooltip || tooltip.trigger.contains(tooltip.trigger.ownerDocument.activeElement)) {
        return;
      }
      hovered = null;
      // Base UI also cancels delayed hover opens through this action.
      tooltip.actionsRef.current?.close();
    },
  };
}
const TooltipScrollContext = createContext<ReturnType<typeof makeHoveredTooltipTracker> | null>(
  null,
);

/** Dismisses hovered descendants on real scroll events without rerendering the timeline. */
function TooltipScrollDismissArea({ onScrollCapture, ...props }: ComponentProps<"div">) {
  const [hovered] = useState(makeHoveredTooltipTracker);
  return (
    <TooltipScrollContext value={hovered}>
      <div
        {...props}
        onScrollCapture={(event) => {
          onScrollCapture?.(event);
          hovered.dismiss();
        }}
      />
    </TooltipScrollContext>
  );
}

function Tooltip({ children }: { children: ReactNode }) {
  const hovered = use(TooltipScrollContext);
  const actionsRef = useRef<TooltipPrimitive.Root.Actions | null>(null);
  useEffect(() => () => hovered?.leave(actionsRef), [hovered]);

  if (!hovered) return <TooltipPrimitive.Root>{children}</TooltipPrimitive.Root>;
  return (
    <TooltipHoverContext value={actionsRef}>
      <TooltipPrimitive.Root
        actionsRef={actionsRef}
        onOpenChange={(open, details) => {
          if (!open && !details.isCanceled) hovered.leave(actionsRef);
        }}
      >
        {children}
      </TooltipPrimitive.Root>
    </TooltipHoverContext>
  );
}

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  const hovered = use(TooltipScrollContext);
  const actionsRef = use(TooltipHoverContext);
  if (!hovered || !actionsRef) {
    return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
  }
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      onMouseEnter={(event) => {
        props.onMouseEnter?.(event);
        hovered.enter(event.currentTarget, actionsRef);
      }}
    />
  );
}

function TooltipPopup({
  className,
  side = "top",
  children,
  ...props
}: TooltipPrimitive.Popup.Props & {
  side?: TooltipPrimitive.Positioner.Props["side"];
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        className="pointer-events-none z-[140] h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none"
        data-slot="tooltip-positioner"
        side={side}
        sideOffset={4}
      >
        <TooltipPrimitive.Popup
          className={cn(
            "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-balance rounded-md text-popover-foreground text-xs transition-[width,height,scale,opacity] edge-highlight before:rounded-[calc(var(--radius-md)-1px)] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0 border bg-popover bg-clip-padding shadow-md/5 max-w-80 wrap-anywhere whitespace-normal leading-snug",
            className,
          )}
          data-slot="tooltip-popup"
          {...props}
        >
          <TooltipPrimitive.Viewport
            className="popup-viewport py-1 [--viewport-inline-padding:--spacing(2)] **:data-previous:truncate"
            data-slot="tooltip-viewport"
          >
            {children}
          </TooltipPrimitive.Viewport>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipPopup, TooltipScrollDismissArea };
