import { generateId } from "@t45/contracts/models/primitives";
import type { StepAutomation } from "@t45/contracts/models/Workflow";
import { type ReactNode, useState } from "react";

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
import { Textarea } from "../ui/textarea";
import { ActorPicker } from "./ActorPicker";
import { useWorkDirectory } from "./useWorkDirectory";
import { actorName } from "./workLogic";

export function StepAutomationsEditor({
  entries,
  busy,
  onSave,
  renderStatus,
}: {
  readonly entries: ReadonlyArray<StepAutomation>;
  readonly busy: boolean;
  readonly onSave?: ((entries: ReadonlyArray<StepAutomation>) => Promise<boolean>) | undefined;
  readonly renderStatus?: (id: string) => ReactNode;
}) {
  const directory = useWorkDirectory();
  const [draft, setDraft] = useState<StepAutomation | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const save = async () => {
    if (draft === null || onSave === undefined) return;
    const next = entries.some((entry) => entry.id === draft.id)
      ? entries.map((entry) => (entry.id === draft.id ? draft : entry))
      : [...entries, draft];
    if (await onSave(next)) setDraft(null);
  };
  return (
    <div className="flex flex-col gap-3">
      {entries.map((entry) => (
        <div key={entry.id} className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
          <p className="font-medium">{actorName(directory, entry.agentId)}</p>
          <p className="whitespace-pre-wrap text-muted-foreground">{entry.instructions}</p>
          {renderStatus?.(entry.id)}
          {onSave && (
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || draft !== null}
                onClick={() => setDraft(entry)}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || draft !== null}
                onClick={() => setRemoving(entry.id)}
              >
                Remove
              </Button>
            </div>
          )}
        </div>
      ))}
      {onSave &&
        (draft === null ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setDraft({ id: generateId(), agentId: "", instructions: "" })}
          >
            Add automation
          </Button>
        ) : (
          <fieldset className="flex flex-col gap-2 rounded-lg border p-3" disabled={busy}>
            <ActorPicker
              kind="agent"
              value={draft.agentId || null}
              onChange={(agentId) => setDraft({ ...draft, agentId })}
              placeholder="Choose an agent"
              aria-label="Automation agent"
              disabled={busy}
            />
            <Textarea
              aria-label="Automation instructions"
              value={draft.instructions}
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
              placeholder="What this automation contributes"
            />
            <div className="flex gap-2">
              <Button size="sm" disabled={!draft.agentId} onClick={() => void save()}>
                Save automation
              </Button>
              <Button variant="outline" size="sm" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </fieldset>
        ))}
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
                if (onSave && (await onSave(entries.filter((entry) => entry.id !== removing))))
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
