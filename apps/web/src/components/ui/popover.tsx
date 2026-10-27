"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "~/lib/utils";

const Popover = PopoverPrimitive.Root;

function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

// The inset around the content. "compact" suits dense content (a list, a code excerpt, a
// row of reactions).
const popoverViewportPaddingClassName = {
  default: "py-4 [--viewport-inline-padding:--spacing(4)]",
  compact: "py-2 [--viewport-inline-padding:--spacing(3)]",
} as const;

function PopoverPopup({
  children,
  className,
  padding = "default",
  width = "auto",
  side = "bottom",
  align = "center",
  anchor,
  ...props
}: PopoverPrimitive.Popup.Props & {
  padding?: keyof typeof popoverViewportPaddingClassName;
  side?: PopoverPrimitive.Positioner.Props["side"];
  align?: PopoverPrimitive.Positioner.Props["align"];
  anchor?: PopoverPrimitive.Positioner.Props["anchor"];
  /** Popovers that hold prose and forms take a fixed width, capped to the viewport. */
  width?: "auto" | "md";
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        anchor={anchor}
        className="z-[130] h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-transform data-instant:transition-none"
        data-slot="popover-positioner"
        side={side}
        sideOffset={4}
      >
        <PopoverPrimitive.Popup
          className={cn(
            "dropdown-glass relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-lg text-popover-foreground outline-none transition-[width,height,scale,opacity] edge-highlight data-starting-style:scale-98 data-starting-style:opacity-0",
            width === "md" && "w-80 max-w-[calc(100vw-2rem)]",
            className,
          )}
          data-slot="popover-popup"
          {...props}
        >
          <PopoverPrimitive.Viewport
            className={cn(
              "popup-viewport max-h-(--available-height) not-data-transitioning:overflow-y-auto",
              popoverViewportPaddingClassName[padding],
            )}
            data-slot="popover-viewport"
          >
            {children}
          </PopoverPrimitive.Viewport>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      className={cn("font-semibold text-sm leading-none", className)}
      data-slot="popover-title"
      {...props}
    />
  );
}

export { Popover, PopoverTrigger, PopoverPopup, PopoverTitle };
