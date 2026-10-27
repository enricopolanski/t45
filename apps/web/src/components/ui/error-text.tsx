import { cn } from "~/lib/utils";

function ErrorText({
  className,
  size = "sm",
  ...props
}: React.ComponentProps<"p"> & { size?: "sm" | "xs" }) {
  return (
    <p
      role="alert"
      className={cn(
        "text-destructive-foreground",
        size === "sm" ? "text-sm" : "text-xs",
        className,
      )}
      data-slot="error-text"
      {...props}
    />
  );
}

export { ErrorText };
