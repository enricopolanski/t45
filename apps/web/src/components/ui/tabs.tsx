"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { cn } from "~/lib/utils";

/** The tab strip with the active panel below it. */
function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      className={cn("flex flex-col gap-3", className)}
      data-slot="tabs"
      {...props}
    />
  );
}

/**
 * The tabs as a segmented control: the active one raised on a muted track. `sm` sits in a heading
 * row, its tabs as wide as their names. The `underline` variant switches a page's sections instead:
 * the tabs sit on a rule, the active one underlined; its tabs take the same variant.
 */
function TabsList({
  className,
  size = "default",
  variant = "segmented",
  ...props
}: TabsPrimitive.List.Props & { size?: "default" | "sm"; variant?: "segmented" | "underline" }) {
  return (
    <TabsPrimitive.List
      className={cn(
        "flex",
        variant === "underline"
          ? "gap-6 border-b"
          : ["gap-0.5 rounded-md border bg-accent", size === "sm" ? "p-0.5" : "p-0.75"],
        className,
      )}
      data-slot="tabs-list"
      {...props}
    />
  );
}

function TabsTab({
  className,
  size = "default",
  variant = "segmented",
  ...props
}: TabsPrimitive.Tab.Props & { size?: "default" | "sm"; variant?: "segmented" | "underline" }) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "cursor-pointer font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-active:text-foreground",
        variant === "underline"
          ? "-mb-px h-11 border-b-2 border-transparent px-1 text-sm data-active:border-primary data-active:font-semibold"
          : [
              "rounded-sm px-2.5 data-active:bg-card data-active:shadow-xs/12",
              size === "sm" ? "h-6 flex-none text-xs" : "h-7 flex-1 text-sm",
            ],
        className,
      )}
      data-slot="tabs-tab"
      {...props}
    />
  );
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      className={cn("outline-none", className)}
      data-slot="tabs-panel"
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsPanel, TabsTab };
