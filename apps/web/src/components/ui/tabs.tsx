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
 * row, its tabs as wide as their names.
 */
function TabsList({
  className,
  size = "default",
  ...props
}: TabsPrimitive.List.Props & { size?: "default" | "sm" }) {
  return (
    <TabsPrimitive.List
      className={cn(
        "flex gap-0.5 rounded-md border bg-accent",
        size === "sm" ? "p-0.5" : "p-0.75",
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
  ...props
}: TabsPrimitive.Tab.Props & { size?: "default" | "sm" }) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "cursor-pointer rounded-sm px-2.5 font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-active:bg-card data-active:text-foreground data-active:shadow-xs/12",
        size === "sm" ? "h-6 flex-none text-xs" : "h-7 flex-1 text-sm",
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
