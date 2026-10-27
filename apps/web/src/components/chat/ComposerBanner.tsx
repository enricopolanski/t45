import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { ChevronDownIcon, XIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";

/** Stacks the drawers above the composer so they meet it as one seam. */
function Dock({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mx-auto -mb-(--chat-composer-attachment-overlap) flex w-[calc(100%-2*var(--chat-composer-drawer-inset))] flex-col empty:hidden",
        className,
      )}
      {...props}
    />
  );
}

function Root({
  className,
  density = "default",
  variant = "default",
  ...props
}: ComponentProps<"div"> & {
  density?: "default" | "comfortable";
  variant?: "default" | "error" | "warning";
}) {
  return (
    <div
      data-slot="composer-drawer"
      data-variant={variant}
      className={cn(
        "composer-drawer min-w-0 px-1 py-(--composer-banner-padding-block) after:block after:h-(--chat-composer-attachment-overlap) text-xs/4 [--composer-banner-icon-column:--spacing(7)] [--composer-banner-padding-block:--spacing(1)] sm:[--composer-banner-icon-column:--spacing(6)]",
        density === "comfortable" && "[--composer-banner-padding-block:--spacing(1.25)]",
        className,
      )}
      {...props}
    />
  );
}

/** The same row can be a status, a list item, or an entire disclosure button. */
function Row({ className, render, ...props }: useRender.ComponentProps<"div">) {
  const rowProps = {
    className: cn(
      "grid min-h-(--composer-banner-icon-column) w-full min-w-0 grid-cols-[var(--composer-banner-icon-column)_minmax(0,1fr)_auto] items-center gap-x-1 text-start",
      "not-has-[>[data-slot=composer-banner-actions]]:grid-cols-[var(--composer-banner-icon-column)_minmax(0,1fr)]",
      "[&:is(button)]:cursor-pointer [&:is(button)]:rounded-md [&:is(button)]:focus-visible:outline-2 [&:is(button)]:focus-visible:-outline-offset-2 [&:is(button)]:focus-visible:outline-ring",
      className,
    ),
    "data-composer-banner-row": "true",
  };
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(rowProps, props),
  });
}

function Icon({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="composer-banner-icon"
      className={cn(
        "col-start-1 row-start-1 flex w-(--composer-banner-icon-column) min-w-0 flex-none items-center justify-center text-muted-foreground [&>svg]:size-3",
        className,
      )}
      {...props}
    />
  );
}

function Content({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="composer-banner-content"
      className={cn("col-start-2 row-start-1 flex min-w-0 items-center gap-1", className)}
      {...props}
    />
  );
}

function Actions({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="composer-banner-actions"
      className={cn(
        "col-start-3 row-start-1 flex flex-wrap items-center justify-end gap-1",
        className,
      )}
      {...props}
    />
  );
}

/** Child rows keep their parent's columns and begin immediately after its header. */
function Children({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(
      { className: cn("grid gap-px [&_[data-composer-banner-row]]:min-h-5", className) },
      props,
    ),
  });
}

/** Bounded banner content uses the app's scroll area and fades only overflowing edges. */
function Scroll({ className, children, ...props }: ComponentProps<typeof ScrollArea>) {
  return (
    <ScrollArea
      radius="none"
      scrollFade
      className={cn("h-auto max-h-[min(24rem,40dvh)]", className)}
      {...props}
    >
      {/* Clears the overlay scrollbar only once there is something to scroll. */}
      <div className="[[data-has-overflow-y]>&]:pe-2">{children}</div>
    </ScrollArea>
  );
}

function Count({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex min-w-(--composer-banner-icon-column,1em) flex-none justify-center font-medium text-muted-foreground tabular-nums",
        className,
      )}
      {...props}
    />
  );
}

function Body({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("min-w-0 ps-8 sm:ps-7", className)} {...props} />;
}

// Decorative: the row itself is the control, so this only matches Dismiss's box.
function ToggleIcon({ expanded }: { expanded: boolean }) {
  return (
    <Button
      render={<span aria-hidden />}
      size="icon-xs"
      variant="ghost"
      tabIndex={-1}
      className="pointer-events-none"
    >
      <ChevronDownIcon className={cn("size-3.5", !expanded && "rotate-180")} />
    </Button>
  );
}

function Dismiss(props: ComponentProps<typeof Button>) {
  return (
    <Button size="icon-xs" variant="ghost" {...props}>
      <XIcon className="size-3.5" />
    </Button>
  );
}

export const ComposerBanner = {
  Dock,
  Root,
  Row,
  Icon,
  Content,
  Actions,
  Children,
  Scroll,
  Count,
  Body,
  ToggleIcon,
  Dismiss,
};
