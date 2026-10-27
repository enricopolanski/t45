"use client";

import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "~/lib/utils";

function Input({
  className,
  size = "default",
  ...props
}: Omit<InputPrimitive.Props, "size" | "className"> & {
  className?: string;
  size?: "default" | "sm";
}) {
  return (
    <span
      className={cn("control-frame transition-shadow has-autofill:bg-foreground/4", className)}
      data-slot="input-control"
    >
      <InputPrimitive
        className={cn(
          "h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] leading-8.5 outline-none placeholder:text-placeholder sm:h-7.5 sm:leading-7.5 [transition:background-color_5000000s_ease-in-out_0s]",
          size === "sm" &&
            "h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-6.5 sm:leading-6.5",
          // Number fields are typed into; browser spin buttons crowd narrow fields and step by 1.
          props.type === "number" &&
            "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
        )}
        data-slot="input"
        {...props}
      />
    </span>
  );
}

export { Input };
