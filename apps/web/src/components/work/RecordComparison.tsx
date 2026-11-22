import { useTranslation } from "~/i18n/locale";
import type { ComparisonFields, DerivedComparisonField, Field } from "@t45/contracts/models/Field";
import {
  comparisonFieldReference,
  holdsData,
  isUrlFieldValue,
  rowIds,
} from "@t45/contracts/models/Field";
import { resolveRecordDisplay } from "@t45/contracts/models/Layout";
import type { CollectionRecordView } from "@t45/contracts/resources/Collections";
import type { Proposal } from "@t45/contracts/models/Workflow";
import { ComparisonCriteriaTable } from "./ComparisonCriteriaTable";
import type { FieldView, StepView } from "@t45/contracts/resources/Workflows";
import { getFieldLink } from "@t45/core/fieldViews";
import { useId, useState } from "react";

import { RecordShowcase } from "../collections/RecordDisplay";
import { formatRecordValue, renderRecordValue } from "../collections/Records";
import { ExternalUrl } from "../ExternalUrl";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { FoldChevron } from "./CardFold";
import {
  listComparisonFields,
  orderComparisonFields,
  resolveComparisonFields,
  resolveComparisonReference,
} from "./recordComparisonFields";
import { currencyFractionLimit, formatNumber } from "./workLogic";

type RecordCollection = NonNullable<FieldView["collection"]>;

const listSources = (
  fields: ReadonlyArray<FieldView>,
): Array<{
  id: string;
  label: string;
  collection: RecordCollection;
  record: CollectionRecordView;
}> =>
  fields.flatMap((field) => {
    const collection = field.collection;
    return [
      ...(collection === null
        ? []
        : field.records.map((record) => ({
            id: `${field.key}:${record.key}`,
            label: field.label,
            collection,
            record,
          }))),
      ...field.rows.flatMap((row) => listSources(row.fields)),
    ];
  });

const getRecordHeading = (collection: RecordCollection, record: CollectionRecordView) => {
  const title = resolveRecordDisplay(collection).title;
  const text =
    title === undefined
      ? record.key
      : formatRecordValue(title, record.values[title.id], record.files) || record.key;
  const fieldIds = new Set<string>();
  if (title !== undefined) fieldIds.add(title.id);
  const link = collection.fields.find(
    (field) =>
      field.type === "url" &&
      field.displayLinkOn !== undefined &&
      field.displayLinkOn === title?.id,
  );
  const url = link === undefined ? undefined : record.values[link.id];
  if (link === undefined || !isUrlFieldValue(url)) return { text, fieldIds };

  fieldIds.add(link.id);
  // A filter that takes its site icon from this URL is represented by the same icon in the heading.
  for (const filter of collection.layout?.search?.filters ?? []) {
    if (filter.iconLink === link.id) fieldIds.add(filter.field);
  }
  return { text, url, fieldIds };
};

function RecordHeading({ heading }: { readonly heading: ReturnType<typeof getRecordHeading> }) {
  return heading.url === undefined ? (
    heading.text
  ) : (
    <ExternalUrl href={heading.url}>{heading.text}</ExternalUrl>
  );
}

const readComparisonValue = (
  collection: RecordCollection,
  record: CollectionRecordView,
  reference: string,
  isNumber: boolean,
) => {
  const resolved = resolveComparisonReference(collection.fields, reference, isNumber);
  if (resolved === undefined) return undefined;
  const { field, group } = resolved;
  if (group === undefined) return { field, value: record.values[field.id] };
  let lowest = Infinity;
  let selected: string | undefined;
  for (const row of rowIds(record.values[group.id])) {
    const prefix = `${group.id}.${row}`;
    const value = record.values[`${prefix}.${group.sortBy}`];
    if (typeof value === "number" && Number.isFinite(value) && value < lowest) {
      lowest = value;
      selected = prefix;
    }
  }
  return selected === undefined
    ? undefined
    : { field, value: record.values[`${selected}.${field.id}`] };
};

const formatComparisonExpression = (
  collection: RecordCollection,
  record: CollectionRecordView,
  numerator: string,
  denominator: string | undefined,
) => {
  const left = readComparisonValue(collection, record, numerator, denominator !== undefined);
  if (left === undefined || !holdsData(left.value)) return null;
  const unit = left.field.type === "number" ? left.field.unit : undefined;
  const maximumFractionDigits = currencyFractionLimit(unit);
  if (denominator === undefined) {
    return maximumFractionDigits !== undefined && typeof left.value === "number"
      ? formatNumber(left.value, { unit, maximumFractionDigits })
      : formatRecordValue(left.field, left.value, record.files);
  }
  const right = readComparisonValue(collection, record, denominator, true);
  if (typeof left.value !== "number" || typeof right?.value !== "number") return null;
  const ratio = left.value / right.value;
  return Number.isFinite(ratio)
    ? formatNumber(Number(ratio.toPrecision(12)), { maximumFractionDigits })
    : null;
};

/** Fill the expressions from one record, leaving the cell empty if an operand is missing. */
const formatDerivedComparisonValue = (
  template: string,
  collection: RecordCollection,
  record: CollectionRecordView,
) => {
  let hasMissingValue = false;
  const text = template.replaceAll(comparisonFieldReference, (_, left: string, right?: string) => {
    const value = formatComparisonExpression(collection, record, left, right);
    if (value === null) hasMissingValue = true;
    return value ?? "";
  });
  return hasMissingValue || text.trim() === "" ? null : text;
};

function ComparisonValue({
  field,
  collection,
  record,
  isProposed = false,
}: {
  readonly field: Field | DerivedComparisonField | undefined;
  readonly collection: RecordCollection;
  readonly record: CollectionRecordView;
  readonly isProposed?: boolean;
}) {
  const t = useTranslation();
  if (field !== undefined && "template" in field) {
    return (
      formatDerivedComparisonValue(
        (isProposed ? field.proposedTemplate : undefined) ?? field.template,
        collection,
        record,
      ) ?? <span className="text-muted-foreground">{t("Not provided")}</span>
    );
  }
  return field === undefined || !holdsData(record.values[field.id]) ? (
    <span className="text-muted-foreground">{t("Not provided")}</span>
  ) : (
    renderRecordValue(
      field,
      record.values[field.id],
      record.files,
      getFieldLink(field.id, collection.fields, record.values),
      true,
      t,
    )
  );
}

const hasMarkdownTable = (field: Field | DerivedComparisonField | undefined, value: unknown) =>
  field !== undefined &&
  "type" in field &&
  field.type === "text" &&
  field.isMarkdown &&
  typeof value === "string" &&
  /^\s*\|.+\|/m.test(value);

function ComparisonPropertyRow({
  field,
  source,
  collection,
  record,
}: {
  readonly field: Field | DerivedComparisonField;
  readonly source: ReturnType<typeof listSources>[number] | undefined;
  readonly collection: RecordCollection;
  readonly record: CollectionRecordView;
}) {
  const t = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const cellId = useId();
  const left =
    "template" in field ? field : source?.collection.fields.find(({ id }) => id === field.id);
  const right = "template" in field ? field : collection.fields.find(({ id }) => id === field.id);
  const isCollapsible =
    hasMarkdownTable(left, source?.record.values[field.id]) ||
    hasMarkdownTable(right, record.values[field.id]);
  const showsValues = !isCollapsible || isExpanded;
  return (
    <tr className="border-t align-top">
      <th scope="row" className="p-3 text-left font-medium text-muted-foreground wrap-anywhere">
        {isCollapsible ? (
          <button
            type="button"
            aria-expanded={isExpanded}
            aria-controls={`${cellId}-source ${cellId}-proposed`}
            data-panel-open={isExpanded ? "" : undefined}
            className="group flex w-full cursor-pointer items-center gap-1.5 text-left hover:text-foreground"
            onClick={() => setIsExpanded((expanded) => !expanded)}
          >
            <FoldChevron />
            {field.label}
          </button>
        ) : (
          field.label
        )}
      </th>
      <td id={`${cellId}-source`} className="border-l p-3 wrap-anywhere whitespace-pre-wrap">
        {showsValues &&
          (source === undefined ? (
            <span className="text-muted-foreground">{t("Choose a source record")}</span>
          ) : (
            <ComparisonValue field={left} collection={source.collection} record={source.record} />
          ))}
      </td>
      <td id={`${cellId}-proposed`} className="border-l p-3 wrap-anywhere whitespace-pre-wrap">
        {showsValues && (
          <ComparisonValue field={right} collection={collection} record={record} isProposed />
        )}
      </td>
    </tr>
  );
}

/** A proposal's record beside an explicitly chosen input record, with shared fields aligned. */
export function RecordComparison({
  inputs,
  collection,
  record,
  rationale,
  comparison,
  criteriaSources,
  comparisonFields,
}: {
  readonly inputs: ReadonlyArray<FieldView>;
  readonly collection: RecordCollection;
  readonly record: CollectionRecordView;
  readonly rationale: string;
  readonly comparison: Proposal["comparison"];
  readonly criteriaSources: NonNullable<StepView["comparisonSources"]>[string] | undefined;
  readonly comparisonFields: ComparisonFields | undefined;
}) {
  const t = useTranslation();
  const sourceInput = criteriaSources && inputs[criteriaSources.recordsIndex];
  const sources = listSources(sourceInput ? [sourceInput] : inputs).filter(
    (source) => !comparison || source.record.key === comparison.sourceRecordKey,
  );
  const [selected, setSelected] = useState(() => {
    // Existing proposals name source keys in their rationale rather than a structured link.
    const references = rationale.split(/[\s`,;()]+/u);
    const referenced = sources.filter((source) => references.includes(source.record.key));
    return referenced.length === 1
      ? (referenced[0]?.id ?? null)
      : sources.length === 1
        ? (sources[0]?.id ?? null)
        : null;
  });
  const source = sources.find((candidate) => candidate.id === selected);
  if (sources.length === 0) return <RecordShowcase collection={collection} record={record} />;
  const sourceHeading =
    source === undefined ? undefined : getRecordHeading(source.collection, source.record);
  const proposedHeading = getRecordHeading(collection, record);
  const confirmed = criteriaSources?.records.find((row) => row.recordKey === source?.record.key);
  const { shown, hidden, order, derived } = resolveComparisonFields(comparisonFields);
  const available = [
    ...new Map(
      [...listComparisonFields(collection, source?.collection), ...derived].map((field) => [
        field.id,
        field,
      ]),
    ).values(),
  ];
  const ordered =
    shown === undefined
      ? orderComparisonFields(available, (field) => field.id, order)
      : shown.flatMap((id) => available.filter((field) => field.id === id));
  const rows = ordered.filter((field) => {
    if (hidden.includes(field.id)) return false;
    if ("template" in field)
      return (
        formatDerivedComparisonValue(
          field.proposedTemplate ?? field.template,
          collection,
          record,
        ) !== null ||
        (source !== undefined &&
          formatDerivedComparisonValue(field.template, source.collection, source.record) !== null)
      );
    if (
      (!holdsData(source?.record.values[field.id]) || sourceHeading?.fieldIds.has(field.id)) &&
      (!holdsData(record.values[field.id]) || proposedHeading.fieldIds.has(field.id))
    )
      return false;
    if (shown !== undefined) return true;
    const left = source?.collection.fields.find((candidate) => candidate.id === field.id);
    const right = collection.fields.find((candidate) => candidate.id === field.id);
    return (
      (left !== undefined && left.isDetailOnly !== true) ||
      (right !== undefined && right.isDetailOnly !== true) ||
      hasMarkdownTable(left, source?.record.values[field.id]) ||
      hasMarkdownTable(right, record.values[field.id])
    );
  });
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          {t("Compare with step input")}
        </span>
        {comparison && sourceHeading ? (
          <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 text-sm sm:grid-cols-2">
            <span>
              <span className="block text-xs text-muted-foreground">{source?.label}</span>
              <strong>
                <RecordHeading heading={sourceHeading} />
              </strong>
            </span>
            <span>
              <span className="block text-xs text-muted-foreground">{t("Proposed record")}</span>
              <strong>
                <RecordHeading heading={proposedHeading} />
              </strong>
            </span>
          </div>
        ) : (
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger
              aria-label={t("Compare with step input")}
              className="w-full min-w-0"
              isWrapped
            >
              <SelectValue placeholder={t("Choose the article to compare")}>
                {source === undefined || sourceHeading === undefined
                  ? null
                  : `${source.label} · ${sourceHeading.text}`}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {sources.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.label} ·{" "}
                  {getRecordHeading(candidate.collection, candidate.record).text}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
        {source === undefined ? (
          <p className="text-sm text-muted-foreground">
            {t(
              "The proposal does not identify a source record. Choose one to compare; no match is assumed.",
            )}
          </p>
        ) : null}
      </div>
      {confirmed && (
        <ComparisonCriteriaTable
          key={confirmed.recordKey}
          source={confirmed}
          assessments={comparison?.assessments ?? []}
        />
      )}
      <div className="overflow-x-auto rounded-lg border">
        <table
          aria-label={t("Record comparison")}
          className="w-full min-w-[36rem] table-fixed border-collapse text-sm"
        >
          <thead className="bg-muted/60 text-left align-top">
            <tr>
              <th scope="col" className="w-1/6 p-3 font-medium">
                {t("Property")}
              </th>
              <th scope="col" className="w-5/12 border-l p-3">
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  {source?.label ?? t("Step input")} {t("· Source record")}
                </div>
                {!comparison && (
                  <h3 className="wrap-anywhere font-semibold">
                    {sourceHeading === undefined ? (
                      t("Choose a source record")
                    ) : (
                      <RecordHeading heading={sourceHeading} />
                    )}
                  </h3>
                )}
              </th>
              <th scope="col" className="w-5/12 border-l p-3">
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  {t("Proposed record")}
                </div>
                {!comparison && (
                  <h3 className="wrap-anywhere font-semibold">
                    <RecordHeading heading={proposedHeading} />
                  </h3>
                )}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((field) => (
              <ComparisonPropertyRow
                key={field.id}
                field={field}
                source={source}
                collection={collection}
                record={record}
              />
            ))}
          </tbody>
        </table>
      </div>
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">{t("Full record details")}</summary>
        <div className="mt-4 grid min-w-0 gap-6 lg:grid-cols-2">
          {source === undefined ? null : (
            <section aria-label={t("Source record details")} className="min-w-0">
              <RecordShowcase collection={source.collection} record={source.record} />
            </section>
          )}
          <section aria-label={t("Proposed record details")} className="min-w-0">
            <RecordShowcase collection={collection} record={record} />
          </section>
        </div>
      </details>
    </div>
  );
}
