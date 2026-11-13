import { cn } from "~/lib/utils";

/** A control's name; `sm` for one above its input in a dense form, such as an entry's. */
function Label({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"label"> & { size?: "default" | "sm" }) {
  return (
    <label
      className={cn(
        "inline-flex items-center gap-2 font-medium text-foreground",
        size === "sm" ? "text-xs/4" : "text-base/4.5 sm:text-sm/4",
        className,
      )}
      data-slot="label"
      {...props}
    />
  );
}

export { Label };
