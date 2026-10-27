import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";

const WIDTHS = {
  column: "max-w-[60rem]",
  split: "max-w-7xl",
  full: "",
};

/** The page's content, below its header, with the same spacing on every page. */
export function PageContent({
  width = "column",
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  /** A centered column; wider for an item beside its side cards; the full width for boards. */
  readonly width?: keyof typeof WIDTHS;
}) {
  return (
    <div
      className={cn("mx-auto flex w-full flex-col gap-8 px-6 py-7", WIDTHS[width], className)}
      {...props}
    />
  );
}
