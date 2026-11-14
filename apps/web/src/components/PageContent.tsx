import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";

const WIDTHS = {
  column: "max-w-[60rem]",
  full: "",
};

/** The page's content, below its header, with the same spacing on every page. */
export function PageContent({
  width = "column",
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  /** A centered column, or the full available width. */
  readonly width?: keyof typeof WIDTHS;
}) {
  return (
    <div
      className={cn("mx-auto flex w-full flex-col gap-8 px-6 py-7", WIDTHS[width], className)}
      {...props}
    />
  );
}
