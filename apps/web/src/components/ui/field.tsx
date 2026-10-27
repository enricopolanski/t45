"use client";

import { Field as FieldPrimitive } from "@base-ui/react/field";
import { Fieldset as FieldsetPrimitive } from "@base-ui/react/fieldset";
import type * as React from "react";

import { cn } from "~/lib/utils";
import { Switch } from "./switch";

const LABEL = {
  sm: "inline-flex items-center gap-2 text-base/4.5 font-medium text-foreground sm:text-sm/4",
  xs: "inline-flex items-center gap-2 text-xs font-medium text-muted-foreground",
};

function FieldDescription({ children }: { children: React.ReactNode }) {
  return (
    <FieldPrimitive.Description
      className="text-xs text-muted-foreground"
      data-slot="field-description"
    >
      {children}
    </FieldPrimitive.Description>
  );
}

function Field({
  label,
  description,
  size = "sm",
  className,
  children,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  size?: "sm" | "xs";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <FieldPrimitive.Root className={cn("flex flex-col gap-1.5", className)} data-slot="field">
      <FieldPrimitive.Label className={LABEL[size]} data-slot="label">
        {label}
      </FieldPrimitive.Label>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {children}
    </FieldPrimitive.Root>
  );
}

function SwitchField({
  label,
  description,
  ...props
}: Omit<React.ComponentProps<typeof Switch>, "className"> & {
  label: React.ReactNode;
  description?: React.ReactNode;
}) {
  return (
    <FieldPrimitive.Root className="flex items-center justify-between gap-4" data-slot="field">
      <div className="min-w-0 space-y-1">
        <FieldPrimitive.Label className={LABEL.sm} data-slot="label">
          {label}
        </FieldPrimitive.Label>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
      </div>
      <Switch {...props} />
    </FieldPrimitive.Root>
  );
}

function Fieldset({ disabled, ...props }: Omit<FieldsetPrimitive.Root.Props, "className">) {
  return (
    <FieldsetPrimitive.Root
      disabled={disabled}
      render={<fieldset disabled={disabled} />}
      className="flex flex-col gap-5"
      data-slot="fieldset"
      {...props}
    />
  );
}

export { Field, Fieldset, SwitchField };
