import { useTranslation } from "~/i18n/locale";
import {
  comparisonFieldReference,
  DerivedComparisonField,
  type Field as RecordField,
} from "@t45/contracts/models/Field";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  canUseInComparisonTemplate,
  resolveComparisonReference,
} from "../work/recordComparisonFields";

const isDerivedComparisonField = Schema.is(DerivedComparisonField);

const hasAvailableReferences = (template: string, fields: ReadonlyArray<RecordField>) =>
  [...template.matchAll(comparisonFieldReference)].every(
    ([, left, right]) =>
      left !== undefined &&
      resolveComparisonReference(fields, left, right !== undefined) !== undefined &&
      (right === undefined || resolveComparisonReference(fields, right, true) !== undefined),
  );

function TemplatePicker({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly options: ReadonlyArray<RecordField>;
  readonly onChange: (key: string) => void;
}) {
  const names = new Map(options.map(({ id, label }) => [id, label]));
  return (
    <Select
      value={value}
      onValueChange={(key) => {
        if (key !== null) onChange(key);
      }}
    >
      <SelectTrigger aria-label={label} className="w-fit">
        <SelectValue placeholder={label}>
          {(key: string | null) => (key === null ? label : names.get(key))}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {[...names].map(([id, name]) => (
          <SelectItem key={id} value={id}>
            {name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function TemplateInput({
  label,
  value,
  fields,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly fields: ReadonlyArray<RecordField>;
  readonly onChange: (template: string) => void;
}) {
  const t = useTranslation();
  const [groupId, setGroupId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<string | null>(null);
  const groups = fields
    .filter((field) => field.type === "group")
    .filter((field) => field.repeatable && field.fields.some((member) => member.type === "number"));
  const groupFields = groups
    .filter((group) => group.id === groupId)
    .flatMap((group) => group.fields);
  const insert = (expression: string) =>
    onChange([value.trimEnd(), "${" + expression + "}"].filter(Boolean).join(" "));
  return (
    <div className="flex flex-col gap-2">
      <Field
        label={label}
        description={
          <>
            {t("Insert a field, or divide two numeric values with")}{" "}
            <code>{"${amount / quantity}"}</code>.
          </>
        }
      >
        <Input value={value} onChange={(event) => onChange(event.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <TemplatePicker
          label={t("Insert field")}
          value={null}
          options={fields.filter(canUseInComparisonTemplate)}
          onChange={insert}
        />
        {groups.length === 0 ? null : (
          <TemplatePicker
            label={t("Repeatable group")}
            value={groupId}
            options={groups}
            onChange={(id) => {
              setGroupId(id);
              setSortBy(null);
            }}
          />
        )}
        {groupId === null ? null : (
          <TemplatePicker
            label={t("Lowest value of")}
            value={sortBy}
            options={groupFields.filter((field) => field.type === "number")}
            onChange={setSortBy}
          />
        )}
        {groupId === null || sortBy === null ? null : (
          <TemplatePicker
            label={t("Insert group field")}
            value={null}
            options={groupFields.filter(
              (field) =>
                resolveComparisonReference(
                  fields,
                  `minBy(${groupId}, ${sortBy}).${field.id}`,
                  false,
                ) !== undefined,
            )}
            onChange={(key) => insert(`minBy(${groupId}, ${sortBy}).${key}`)}
          />
        )}
      </div>
    </div>
  );
}

export function DerivedComparisonFieldDialog({
  field,
  sourceFields,
  proposedFields,
  onChange,
  onRemove,
  onClose,
}: {
  readonly field: DerivedComparisonField;
  readonly sourceFields: ReadonlyArray<RecordField>;
  readonly proposedFields: ReadonlyArray<RecordField>;
  readonly onChange: (field: DerivedComparisonField) => void;
  readonly onRemove: (() => void) | undefined;
  readonly onClose: () => void;
}) {
  const t = useTranslation();
  const [label, setLabel] = useState(field.label);
  const [template, setTemplate] = useState(field.template);
  const [proposedTemplate, setProposedTemplate] = useState(field.proposedTemplate);
  const usesSeparateTemplates = proposedTemplate !== undefined;
  const sharedFields = [...sourceFields, ...proposedFields];
  const availableSourceFields = usesSeparateTemplates ? sourceFields : sharedFields;
  const { proposedTemplate: _, ...base } = field;
  const next = {
    ...base,
    label: label.trim(),
    template: template.trim(),
    ...(proposedTemplate === undefined ? {} : { proposedTemplate: proposedTemplate.trim() }),
  };
  const isValid =
    isDerivedComparisonField(next) &&
    hasAvailableReferences(template, availableSourceFields) &&
    (proposedTemplate === undefined || hasAvailableReferences(proposedTemplate, proposedFields));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {onRemove === undefined ? t("Add derived field") : t("Edit derived field")}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Field label={t("Name")}>
            <Input value={label} onChange={(event) => setLabel(event.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              size="sm"
              checked={usesSeparateTemplates}
              onCheckedChange={(checked) => setProposedTemplate(checked ? template : undefined)}
            />
            {t("Separate templates")}
          </label>
          <TemplateInput
            key={usesSeparateTemplates ? "source" : "shared"}
            label={usesSeparateTemplates ? t("Source template") : t("Template")}
            value={template}
            fields={availableSourceFields}
            onChange={setTemplate}
          />
          {proposedTemplate === undefined ? null : (
            <TemplateInput
              label={t("Proposed template")}
              value={proposedTemplate}
              fields={proposedFields}
              onChange={setProposedTemplate}
            />
          )}
        </DialogPanel>
        <DialogFooter>
          {onRemove === undefined ? null : (
            <Button type="button" variant="ghost" className="sm:me-auto" onClick={onRemove}>
              {t("Remove derived field")}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button type="button" disabled={!isValid} onClick={() => onChange(next)}>
            {onRemove === undefined ? t("Add field") : t("Save field")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
