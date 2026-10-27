import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-transparent font-medium [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
    },
    variants: {
      size: {
        default:
          "h-5.5 min-w-5.5 px-[calc(--spacing(1)-1px)] text-sm sm:h-4.5 sm:min-w-4.5 sm:text-xs",
        // leading-none: with the inherited fractional leading the rounded font metrics
        // leave the label sitting high in the fixed-height box, worse under renderer zoom.
        sm: "h-5 min-w-5 rounded-[.25rem] px-[calc(--spacing(1)-1px)] text-xs leading-none sm:h-4 sm:min-w-4 sm:text-[.625rem]",
      },
      variant: {
        error: "bg-destructive/8 text-destructive-foreground",
        info: "bg-info/8 text-info-foreground",
        outline: "border-input bg-background text-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        success: "bg-success/8 text-success-foreground",
        warning: "bg-warning/8 text-warning-foreground",
      },
    },
  },
);

function Badge({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"span"> & {
  variant: NonNullable<VariantProps<typeof badgeVariants>["variant"]>;
  size?: VariantProps<typeof badgeVariants>["size"];
}) {
  return (
    <span
      className={cn(badgeVariants({ size, variant }), className)}
      data-slot="badge"
      {...props}
    />
  );
}

export { Badge };
