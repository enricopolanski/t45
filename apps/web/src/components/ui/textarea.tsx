"use client";

import { Field as FieldPrimitive } from "@base-ui/react/field";
import type * as React from "react";

import { cn } from "~/lib/utils";

function Textarea({ className, id, disabled, ...props }: React.ComponentProps<"textarea">) {
  return (
    <span className={cn("control-frame transition-shadow", className)} data-slot="textarea-control">
      <FieldPrimitive.Control
        id={id}
        disabled={disabled}
        render={
          <textarea
            // Auto-grows with content up to one cap, then scrolls.
            className="field-sizing-content min-h-17.5 max-h-64 w-full rounded-[inherit] px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] outline-none max-sm:min-h-20.5"
            data-slot="textarea"
            {...props}
          />
        }
      />
    </span>
  );
}

export { Textarea };
