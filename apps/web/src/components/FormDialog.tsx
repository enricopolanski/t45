import type { ReactNode } from "react";

import { useSubmit } from "../hooks/useSubmit";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { ErrorText } from "./ui/error-text";

interface FormProps {
  readonly title: string;
  readonly description?: string;
  readonly submitLabel: string;
  readonly onSubmit: (fields: FormData) => Promise<unknown>;
  readonly children: ReactNode;
}

export function FormDialog({
  open,
  onOpenChange,
  trigger,
  ...form
}: FormProps & {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly trigger?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger}
      <DialogPopup aria-label={form.title}>
        <DialogForm {...form} onDone={() => onOpenChange(false)} />
      </DialogPopup>
    </Dialog>
  );
}

function DialogForm({
  title,
  description,
  submitLabel,
  onSubmit,
  onDone,
  children,
}: FormProps & { readonly onDone: () => void }) {
  const { error, pending, ...form } = useSubmit(async (fields) => {
    if ((await onSubmit(fields)) !== false) onDone();
  });
  return (
    <form className="flex min-h-0 flex-col" {...form}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          {children}
          {error !== null ? <ErrorText>{error}</ErrorText> : null}
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
