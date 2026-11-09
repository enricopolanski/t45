import type { AutomationId } from "@t45/contracts/models/Automation";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { stepAutomationList } from "../../state/agents";
import { useApiQuery } from "../../state/rpc";
import { useIsAdmin } from "../../state/session";
import { Button } from "../ui/button";
import {
  AlertDialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ErrorText } from "../ui/error-text";

export function StepAutomationsEditor({
  automationIds,
  busy,
  onSave,
  renderStatus,
}: {
  readonly automationIds: ReadonlyArray<AutomationId>;
  readonly busy: boolean;
  readonly onSave?: ((ids: ReadonlyArray<AutomationId>) => Promise<boolean>) | undefined;
  readonly renderStatus?: (id: AutomationId) => ReactNode;
}) {
  const query = useApiQuery(stepAutomationList);
  const isAdmin = useIsAdmin();
  const [removing, setRemoving] = useState<AutomationId | null>(null);
  const available = (query.data ?? []).filter(
    (automation) => !automationIds.includes(automation.id),
  );
  return (
    <div className="flex flex-col gap-3">
      {query.error && <ErrorText text={query.error} />}
      {automationIds.map((id) => {
        const automation = query.data?.find((automation) => automation.id === id);
        return (
          <div key={id} className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
            <p className="font-medium">{automation?.title ?? "Unavailable automation"}</p>
            <p className="whitespace-pre-wrap text-muted-foreground">{automation?.prompt}</p>
            {renderStatus?.(id)}
            {onSave && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRemoving(id)}>
                Remove
              </Button>
            )}
          </div>
        );
      })}
      {onSave && (
        <Select
          value={null}
          disabled={busy || available.length === 0}
          onValueChange={(value) => {
            const automation = available.find((automation) => automation.id === value);
            if (automation) void onSave([...automationIds, automation.id]);
          }}
        >
          <SelectTrigger aria-label="Add automation">
            <SelectValue placeholder="Add automation" />
          </SelectTrigger>
          <SelectPopup>
            {available.map((automation) => (
              <SelectItem key={automation.id} value={automation.id}>
                {automation.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
      {isAdmin && (
        <Link to="/settings/automations" className="text-sm text-muted-foreground underline">
          Manage automations
        </Link>
      )}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null);
        }}
      >
        <DialogPopup closeButton={false}>
          <DialogHeader>
            <DialogTitle>Remove this automation?</DialogTitle>
            <DialogDescription>Its current execution will be stopped.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              Keep automation
            </DialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (onSave && (await onSave(automationIds.filter((id) => id !== removing))))
                  setRemoving(null);
              }}
            >
              Remove automation
            </Button>
          </DialogFooter>
        </DialogPopup>
      </AlertDialog>
    </div>
  );
}
