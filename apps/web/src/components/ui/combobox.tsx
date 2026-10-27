"use client";

import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { SearchIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { ScrollArea } from "~/components/ui/scroll-area";

const Combobox = ComboboxPrimitive.Root;

function ComboboxSearchInput(props: ComboboxPrimitive.Input.Props) {
  return (
    <div className="min-w-0 shrink-0 px-3 pt-2.5">
      <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
        />
        <ComboboxPrimitive.Input
          className="h-6.5 w-full min-w-0 bg-transparent ps-5 pe-[calc(--spacing(2.5)-1px)] font-sans text-sm leading-6.5 outline-none placeholder:text-placeholder"
          data-slot="combobox-input"
          {...props}
        />
      </div>
    </div>
  );
}

function ComboboxTrigger(props: ComboboxPrimitive.Trigger.Props) {
  return <ComboboxPrimitive.Trigger data-slot="combobox-trigger" {...props} />;
}

function ComboboxPopup({ className, children, ...props }: ComboboxPrimitive.Popup.Props) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        align="start"
        className="z-[130] select-none"
        data-slot="combobox-positioner"
        side="bottom"
        sideOffset={4}
      >
        <span
          className={cn(
            "dropdown-glass relative flex max-h-full min-w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) rounded-lg transition-[scale,opacity]",
            className,
          )}
        >
          <ComboboxPrimitive.Popup
            className="flex min-w-0 max-h-[min(var(--available-height),23rem)] flex-1 flex-col overflow-hidden text-foreground"
            data-slot="combobox-popup"
            {...props}
          >
            {children}
          </ComboboxPrimitive.Popup>
        </span>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      className={cn(
        "popup-item in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] not-data-disabled:hover:bg-accent data-selected:bg-foreground/[0.08] data-selected:text-foreground [&[data-highlighted][data-selected]]:bg-accent [&[data-highlighted][data-selected]]:text-accent-foreground [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      data-slot="combobox-item"
      {...props}
    >
      {/* Children lay out as one row: a label that truncates, then any trailing meta. */}
      <div
        className="flex min-w-0 flex-1 items-center gap-2 [&_svg:not([class*='text-'])]:text-muted-foreground"
        data-slot="combobox-item-content"
      >
        {children}
      </div>
    </ComboboxPrimitive.Item>
  );
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      className={cn(
        "not-empty:p-2 text-center text-base text-muted-foreground sm:text-sm",
        className,
      )}
      data-slot="combobox-empty"
      {...props}
    />
  );
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ScrollArea scrollbarGutter scrollFade>
      <ComboboxPrimitive.List
        className={cn("not-empty:scroll-py-1 not-empty:px-1 not-empty:py-1", className)}
        data-slot="combobox-list"
        {...props}
      />
    </ScrollArea>
  );
}

export {
  Combobox,
  ComboboxSearchInput,
  ComboboxTrigger,
  ComboboxPopup,
  ComboboxItem,
  ComboboxEmpty,
  ComboboxList,
};
