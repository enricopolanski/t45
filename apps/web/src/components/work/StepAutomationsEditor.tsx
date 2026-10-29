import { generateId } from "@t45/contracts/models/primitives";
import type { StepAutomation } from "@t45/contracts/models/Workflow";
import { PencilIcon, PlayIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ActorPicker } from "./ActorPicker";
import { ActorAvatar } from "./ActorAvatar";
import { useWorkDirectory } from "./useWorkDirectory";
import { actorName } from "./workLogic";

/** Saved automations are list entries; adding or editing opens one temporary form. */
export function StepAutomationsEditor({
  entries,
  busy,
  readOnly = false,
  canRun,
  onRun,
  onSave,
}: {
  readonly entries: ReadonlyArray<StepAutomation>;
  readonly busy: boolean;
  readonly readOnly?: boolean;
  readonly canRun?: (automationId: string) => boolean;
  readonly onRun?: ((automationId: string) => void) | undefined;
  readonly onSave: (entries: ReadonlyArray<StepAutomation>) => Promise<boolean>;
}) {
  const directory = useWorkDirectory();
  const [draft, setDraft] = useState<StepAutomation | null>(null);
  const save = async () => {
    if (draft === null || !draft.agentId || busy || readOnly) return;
    const next = entries.some((entry) => entry.id === draft.id)
      ? entries.map((entry) => (entry.id === draft.id ? draft : entry))
      : [...entries, draft];
    if (await onSave(next)) setDraft(null);
  };
  const editor =
    draft === null ? null : (
      <fieldset className="flex flex-col gap-2 rounded-lg border p-3" disabled={busy || readOnly}>
        <ActorPicker
          kind="agent"
          value={draft.agentId || null}
          onChange={(agentId) => setDraft({ ...draft, agentId })}
          placeholder="Choose an agent"
          aria-label="Automation agent"
          disabled={busy || readOnly}
        />
        <Textarea
          aria-label="Automation instructions"
          value={draft.instructions}
          onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
          placeholder="What this automation contributes"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy || readOnly || !draft.agentId}
            onClick={() => void save()}
          >
            Save automation
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </div>
      </fieldset>
    );
  return (
    <div className="flex flex-col gap-3">
      {entries.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {entries.map((entry) => {
            const name = actorName(directory, entry.agentId);
            return (
              <li key={entry.id}>
                {draft?.id === entry.id ? (
                  editor
                ) : (
                  <div className="flex items-start gap-2">
                    <ActorAvatar actor={entry.agentId} />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="text-sm font-medium">{name}</span>
                      {entry.instructions ? (
                        <p className="text-xs whitespace-pre-wrap text-muted-foreground">
                          {entry.instructions}
                        </p>
                      ) : null}
                    </div>
                    {onRun !== undefined && (canRun?.(entry.id) ?? true) ? (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Run ${name} automation`}
                        title={`Run ${name} automation`}
                        disabled={busy || draft !== null}
                        onClick={() => onRun(entry.id)}
                      >
                        <PlayIcon />
                      </Button>
                    ) : null}
                    {!readOnly ? (
                      <>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Edit ${name} automation`}
                          disabled={busy || draft !== null}
                          onClick={() => setDraft(entry)}
                        >
                          <PencilIcon />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Remove ${name} automation`}
                          disabled={busy || draft !== null}
                          onClick={() =>
                            void onSave(entries.filter((other) => other.id !== entry.id))
                          }
                        >
                          <XIcon />
                        </Button>
                      </>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : draft === null ? (
        <p className="text-sm text-muted-foreground">No automations.</p>
      ) : null}
      {draft !== null && !entries.some((entry) => entry.id === draft.id) ? editor : null}
      {!readOnly && draft === null ? (
        <div>
          {entries.length > 0 ? <hr className="mb-3 border-border" /> : null}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setDraft({ id: generateId(), agentId: "", instructions: "" })}
          >
            Add automation
          </Button>
        </div>
      ) : null}
    </div>
  );
}
