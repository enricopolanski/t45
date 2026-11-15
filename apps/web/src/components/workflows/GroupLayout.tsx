import { Field, type Layout } from "@t45/contracts/models/Field";
import { resolveTableLayout } from "@t45/contracts/models/Layout";
import type { FieldView } from "@t45/contracts/resources/Workflows";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { describeFailure } from "../../lib/failures";
import { api } from "../../rpc/api";
import { LayoutEditor } from "../fields/LayoutEditor";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Button } from "../ui/button";
import { findEntryField, layOutEntryForm, sortEntries, shownValue } from "../work/StepFields";
import { EntryTable, ReadOnlyForm } from "../work/StepInputs";
import type { DraftField } from "./workflowLogic";

const decodeField = Schema.decodeUnknownOption(Field);

/** The repeatable group `fieldId` among `views`, inside plain groups too. */
const findGroupView = (views: ReadonlyArray<FieldView>, fieldId: string): FieldView | undefined => {
  for (const view of views) {
    if (view.type !== "group") continue;
    if (view.repeatable && view.key.split(".").at(-1) === fieldId) return view;
    const inner = view.repeatable
      ? undefined
      : findGroupView(
          view.rows.flatMap((row) => row.fields),
          fieldId,
        );
    if (inner !== undefined) return inner;
  }
  return undefined;
};

/**
 * The tickets' steps of the workflow's step `stepId` that the viewer sees, to preview a group's
 * entries with: those of the projects they manage that run the workflow.
 */
const findSteps = async (workflowId: string, stepId: string) => {
  const projects = (await api("workflows.listProjects", undefined)).filter(
    ({ workflow }) => workflow.id === workflowId,
  );
  const lists = await Promise.all(
    projects.map(({ project }) => api("workflows.listTickets", { projectId: project.id })),
  );
  return lists.flatMap(({ tickets }) =>
    tickets.flatMap((ticket) =>
      ticket.steps
        .filter((step) => step.stepDefinitionId === stepId)
        .map((step) => ({ id: step.id, label: `Ticket “${ticket.title}”` })),
    ),
  );
};

/**
 * Edits the layout of `group`, a repeatable group of the workflow's step `stepId`, previewed with
 * the entries a ticket holds in it; saving puts it in the workflow's draft.
 */
function GroupLayoutDialog({
  workflowId,
  stepId,
  trail,
  group,
  onChange,
  onClose,
}: {
  readonly workflowId: string;
  readonly stepId: string;
  readonly trail: string;
  readonly group: Extract<DraftField, { type: "group" }>;
  readonly onChange: (group: DraftField) => void;
  readonly onClose: () => void;
}) {
  const fields = group.fields.flatMap((field) => Option.toArray(decodeField(field)));
  const [steps, setSteps] = useState<ReadonlyArray<{ id: string; label: string }> | null>(null);
  const [shownStepId, setShownStepId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{
    readonly stepId: string;
    readonly view: FieldView | null;
  } | null>(null);
  // Undefined while the shown step loads, null when it has no such group.
  const view = loaded !== null && loaded.stepId === shownStepId ? loaded.view : undefined;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void findSteps(workflowId, stepId).then(
      (found) => {
        if (!current) return;
        setSteps(found);
        setShownStepId(found[0]?.id ?? null);
      },
      (cause: unknown) => current && setError(describeFailure(cause)),
    );
    return () => {
      current = false;
    };
  }, [workflowId, stepId]);
  useEffect(() => {
    if (shownStepId === null) return;
    let current = true;
    void api("workflows.getStep", { stepId: shownStepId }).then(
      (step) =>
        current &&
        setLoaded({ stepId: shownStepId, view: findGroupView(step.fields, group.id) ?? null }),
      (cause: unknown) => current && setError(describeFailure(cause)),
    );
    return () => {
      current = false;
    };
  }, [shownStepId, group.id]);
  // The ticket's entries under the group as the draft defines it and the working layout shows it.
  const preview = (layout: Layout | undefined) => {
    if (view === null || view === undefined) return null;
    const { layout: _, ...rest } = view;
    return { ...rest, rowFields: fields, ...(layout === undefined ? {} : { layout }) };
  };
  const entries = (() => {
    const shown = preview(group.layout);
    if (shown === null) return [];
    const [first] = resolveTableLayout(fields, shown.layout).columns;
    return sortEntries(shown).map((entry, at) => {
      const value = first === undefined ? undefined : findEntryField(shown, entry, first.field.id);
      return {
        id: entry.id,
        label: `Entry ${at + 1}${value === undefined || value.value === null ? "" : ` · ${shownValue(value)}`}`,
      };
    });
  })();
  return (
    <LayoutEditor
      trail={trail}
      title={group.label}
      fields={fields}
      layout={group.layout}
      defaultDialogWidth={1024}
      sourcePicker={
        steps !== null && shownStepId !== null ? (
          <div className="flex items-center gap-2">
            <span aria-hidden className="text-xs whitespace-nowrap text-muted-foreground">
              Preview with
            </span>
            <Select value={shownStepId} onValueChange={(id) => id !== null && setShownStepId(id)}>
              <SelectTrigger size="sm" aria-label="Preview with" className="max-w-64">
                <SelectValue>
                  {(id: string) => steps.find((step) => step.id === id)?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {steps.map((step) => (
                  <SelectItem key={step.id} value={step.id}>
                    {step.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        ) : null
      }
      entries={entries}
      previewNote={
        error ??
        (steps === null || (shownStepId !== null && view === undefined)
          ? "Loading a ticket's entries…"
          : steps.length === 0
            ? "No ticket you can see is in this step yet, so there are no entries to preview."
            : entries.length === 0
              ? "This ticket has no entries in this group yet."
              : null)
      }
      rowsHint="Sorting changes only how rows show, not the order kept."
      saveNote="Once the workflow is saved, every ticket shows the new layout, without a new version."
      renderTable={(layout) => {
        const shown = preview(layout);
        if (shown === null) return null;
        // Entries holding a group show as forms only, as the step and its inputs show them.
        return fields.some((field) => field.type === "group") ? (
          <div className="flex flex-col gap-6">
            {sortEntries(shown).map((entry) => (
              <ReadOnlyForm key={entry.id} form={layOutEntryForm(shown, entry)} />
            ))}
          </div>
        ) : (
          <EntryTable field={shown} entries={sortEntries(shown)} />
        );
      }}
      renderForm={(layout, entryId) => {
        const shown = preview(layout);
        const entry =
          shown === null ? undefined : sortEntries(shown).find(({ id }) => id === entryId);
        return shown === null || entry === undefined ? null : (
          <ReadOnlyForm form={layOutEntryForm(shown, entry)} />
        );
      }}
      isSaving={false}
      error={null}
      onSave={(layout) => {
        const { layout: _, ...rest } = group;
        onChange(layout === undefined ? rest : { ...rest, layout });
        onClose();
      }}
      onClose={onClose}
    />
  );
}

/** Opens the layout editor of a repeatable group of a workflow's step. */
export function GroupLayoutButton({
  disabled,
  ...props
}: Omit<Parameters<typeof GroupLayoutDialog>[0], "onClose"> & { readonly disabled: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() => setIsOpen(true)}
        disabled={disabled}
      >
        Layout
      </Button>
      {isOpen ? <GroupLayoutDialog {...props} onClose={() => setIsOpen(false)} /> : null}
    </>
  );
}
