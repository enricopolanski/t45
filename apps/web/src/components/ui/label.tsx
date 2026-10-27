import { cn } from "~/lib/utils";

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      className={cn(
        "inline-flex items-center gap-2 text-base/4.5 sm:text-sm/4 font-medium text-foreground",
        className,
      )}
      data-slot="label"
      {...props}
    />
  );
}

export { Label };
