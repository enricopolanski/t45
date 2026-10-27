"use client";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import * as React from "react";

import { cn } from "~/lib/utils";

type ToggleGroupVariant = "segmented" | "outline";

const TOGGLE_CLASS =
  "[&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg border font-medium text-base text-foreground outline-none transition-shadow edge-highlight pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:bg-accent focus-ring disabled:pointer-events-none disabled:opacity-64 aria-disabled:opacity-64 data-pressed:bg-input/64 data-pressed:text-accent-foreground sm:text-sm [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0";

const TOGGLE_VARIANT_CLASS = {
  segmented:
    "h-6 min-w-0 rounded-md border-transparent px-2.5 text-xs text-muted-foreground shadow-none transition-colors before:rounded-[calc(var(--radius-md)-1px)] before:shadow-none hover:bg-background/55 hover:text-foreground data-pressed:bg-background data-pressed:text-foreground data-pressed:shadow-xs/10",
  outline:
    "h-8 min-w-8 border-input bg-background bg-clip-padding px-[calc(--spacing(1.5)-1px)] shadow-xs/5 sm:h-7 sm:min-w-7 [:disabled,:active,[data-pressed]]:shadow-none [:disabled,:active,[data-pressed]]:before:shadow-none",
} satisfies Record<ToggleGroupVariant, string>;

const ToggleGroupContext = React.createContext<ToggleGroupVariant>("segmented");

/** `segmented` is a pill track of options; `outline` joins bordered buttons into one row. */
function ToggleGroup({
  className,
  variant = "segmented",
  children,
  ...props
}: ToggleGroupPrimitive.Props & { variant?: ToggleGroupVariant }) {
  return (
    <ToggleGroupPrimitive
      className={cn(
        "flex w-fit *:focus-visible:z-10 *:pointer-coarse:after:min-w-auto",
        variant === "segmented"
          ? "gap-0.5 rounded-lg bg-input/40 p-0.5"
          : "*:not-first:before:-start-[0.5px] *:not-last:before:-end-[0.5px] *:not-first:rounded-s-none *:not-last:rounded-e-none *:not-first:border-s-0 *:not-last:border-e-0 *:not-first:before:rounded-s-none *:not-last:before:rounded-e-none",
        className,
      )}
      data-slot="toggle-group"
      {...props}
    >
      <ToggleGroupContext value={variant}>{children}</ToggleGroupContext>
    </ToggleGroupPrimitive>
  );
}

function Toggle({ className, ...props }: TogglePrimitive.Props) {
  const variant = React.use(ToggleGroupContext);
  return (
    <TogglePrimitive
      className={cn(TOGGLE_CLASS, TOGGLE_VARIANT_CLASS[variant], className)}
      data-slot="toggle"
      {...props}
    />
  );
}

export { ToggleGroup, Toggle };
