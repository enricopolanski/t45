import { LoaderCircleIcon } from "lucide-react";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { cn } from "~/lib/utils";

// Decorative: the text beside it says what is loading. No default size: inside a Button the
// parent's svg rule sizes the glyph.
function Spinner({
  className,
  size,
  ...props
}: React.ComponentPropsWithoutRef<typeof LoaderCircleIcon> & { size?: "sm" | "md" }) {
  return (
    <LoaderCircleIcon
      aria-hidden
      ref={observeVisibleAnimation}
      className={cn(
        "motion-safe:visible-animate-spin",
        size === "sm" && "size-3.5",
        size === "md" && "size-4",
        className,
      )}
      {...props}
    />
  );
}

export { Spinner };
