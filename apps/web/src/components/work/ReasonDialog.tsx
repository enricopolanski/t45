import { useId, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

/**
 * Asks for a reason before acting: rejecting, blocking, and cancelling all record one. Opened by
 * its caller; `onConfirm` answers with an error message, or null on success.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  placeholder,
  confirmLabel,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly placeholder: string;
  readonly confirmLabel: string;
  readonly onConfirm: (reason: string) => Promise<string | null>;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setBusy(true);
    setError(null);
    void onConfirm(reason.trim()).then((failure) => {
      setBusy(false);
      if (failure !== null) {
        setError(failure);
        return;
      }
      setReason("");
      onOpenChange(false);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setError(null);
      }}
    >
      <DialogPopup aria-label={title}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-reason`}>Reason</Label>
                <Textarea
                  id={`${id}-reason`}
                  value={reason}
                  placeholder={placeholder}
                  onChange={(event) => setReason(event.target.value)}
                  disabled={busy}
                />
              </div>
              {error !== null ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="submit" disabled={busy || !reason.trim()}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
