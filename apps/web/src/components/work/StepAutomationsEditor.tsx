import { generateId } from "@t45/contracts/models/primitives";
import type { StepAutomation } from "@t45/contracts/models/Workflow";
import { useState } from "react";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ActorPicker } from "./ActorPicker";

export function StepAutomationsEditor({
  entries,
  busy,
  onSave,
}: {
  readonly entries: ReadonlyArray<StepAutomation>;
  readonly busy: boolean;
  readonly onSave: (entries: ReadonlyArray<StepAutomation>) => void;
}) {
  const [source, setSource] = useState(entries);
  const [draft, setDraft] = useState(entries);
  if (source !== entries) {
    setSource(entries);
    setDraft(entries);
  }
  const update = (id: string, change: Partial<StepAutomation>) =>
    setDraft(draft.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)));
  return (
    <div className="flex flex-col gap-3">
      {draft.map((entry) => (
        <fieldset
          key={entry.id}
          className="flex flex-col gap-2 rounded-lg border p-3"
          disabled={busy}
        >
          <ActorPicker
            kind="agent"
            value={entry.agentId || null}
            onChange={(agentId) => update(entry.id, { agentId })}
            placeholder="Choose an agent"
            aria-label="Automation agent"
            disabled={busy}
          />
          <Textarea
            aria-label="Automation instructions"
            value={entry.instructions}
            onChange={(event) => update(entry.id, { instructions: event.target.value })}
            placeholder="What this automation contributes"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDraft(draft.filter((other) => other.id !== entry.id))}
          >
            Remove automation
          </Button>
        </fieldset>
      ))}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setDraft([...draft, { id: generateId(), agentId: "", instructions: "" }])}
        >
          Add automation
        </Button>
        <Button
          size="sm"
          disabled={busy || draft === entries || draft.some((entry) => !entry.agentId)}
          onClick={() => onSave(draft)}
        >
          Save automations
        </Button>
      </div>
    </div>
  );
}
