import type { Field } from "@t45/contracts/models/Field";
import { holdsData } from "@t45/contracts/models/Field";
import { resolveRecordDisplay } from "@t45/contracts/models/Layout";
import type { CollectionRecordView } from "@t45/contracts/resources/Collections";
import type { FieldView } from "@t45/contracts/resources/Workflows";
import { getFieldLink } from "@t45/core/fieldViews";
import { useState } from "react";

import { RecordShowcase } from "../collections/RecordDisplay";
import { formatRecordValue, renderRecordValue } from "../collections/Records";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

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

const recordTitle = (collection: RecordCollection, record: CollectionRecordView) => {
  const title = resolveRecordDisplay(collection).title;
  return title === undefined
    ? record.key
    : formatRecordValue(title, record.values[title.id], record.files) || record.key;
};

function ComparisonValue({
  field,
  collection,
  record,
}: {
  readonly field: Field | undefined;
  readonly collection: RecordCollection;
  readonly record: CollectionRecordView;
}) {
  return field === undefined || !holdsData(record.values[field.id]) ? (
    <span className="text-muted-foreground">Not provided</span>
  ) : (
    renderRecordValue(
      field,
      record.values[field.id],
      record.files,
      getFieldLink(field.id, collection.fields, record.values),
      true,
    )
  );
}

/** A proposal's record beside an explicitly chosen input record, with shared fields aligned. */
export function RecordComparison({
  inputs,
  collection,
  record,
  rationale,
}: {
  readonly inputs: ReadonlyArray<FieldView>;
  readonly collection: RecordCollection;
  readonly record: CollectionRecordView;
  readonly rationale: string;
}) {
  const sources = listSources(inputs);
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
  const rows = [
    ...new Map(
      [...(source?.collection.fields ?? []), ...collection.fields].map((field) => [
        field.id,
        field,
      ]),
    ).values(),
  ].filter((field) => {
    if (
      field.id === collection.primaryKeyFieldId ||
      field.id === source?.collection.primaryKeyFieldId ||
      field.type === "group" ||
      field.type === "file"
    )
      return false;
    const left = source?.collection.fields.find((candidate) => candidate.id === field.id);
    const right = collection.fields.find((candidate) => candidate.id === field.id);
    if (!holdsData(source?.record.values[field.id]) && !holdsData(record.values[field.id]))
      return false;
    return [left, right].some(
      (candidate) =>
        candidate !== undefined &&
        (candidate.isDetailOnly !== true ||
          (candidate.type === "text" &&
            candidate.isMarkdown &&
            /^\s*\|.+\|/m.test(
              String(source?.record.values[field.id] ?? "") +
                "\n" +
                String(record.values[field.id] ?? ""),
            ))),
    );
  });
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Compare with step input</span>
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger aria-label="Compare with step input" className="w-full min-w-0" isWrapped>
            <SelectValue placeholder="Choose the article to compare">
              {source === undefined
                ? null
                : `${source.label} · ${recordTitle(source.collection, source.record)}`}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {sources.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.label} · {recordTitle(candidate.collection, candidate.record)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {source === undefined ? (
          <p className="text-sm text-muted-foreground">
            The proposal does not identify a source record. Choose one to compare; no match is
            assumed.
          </p>
        ) : null}
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table
          aria-label="Record comparison"
          className="w-full min-w-[36rem] table-fixed border-collapse text-sm"
        >
          <thead className="bg-muted/60 text-left align-top">
            <tr>
              <th scope="col" className="w-1/6 p-3 font-medium">
                Property
              </th>
              <th scope="col" className="w-5/12 border-l p-3">
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  {source?.label ?? "Step input"} · Source record
                </div>
                <h3 className="wrap-anywhere font-semibold">
                  {source === undefined
                    ? "Choose a source record"
                    : recordTitle(source.collection, source.record)}
                </h3>
              </th>
              <th scope="col" className="w-5/12 border-l p-3">
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  Proposed record
                </div>
                <h3 className="wrap-anywhere font-semibold">{recordTitle(collection, record)}</h3>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((field) => (
              <tr key={field.id} className="border-t align-top">
                <th
                  scope="row"
                  className="p-3 text-left font-medium text-muted-foreground wrap-anywhere"
                >
                  {field.label}
                </th>
                <td className="border-l p-3 wrap-anywhere whitespace-pre-wrap">
                  {source === undefined ? (
                    <span className="text-muted-foreground">Choose a source record</span>
                  ) : (
                    <ComparisonValue
                      field={source.collection.fields.find(
                        (candidate) => candidate.id === field.id,
                      )}
                      collection={source.collection}
                      record={source.record}
                    />
                  )}
                </td>
                <td className="border-l p-3 wrap-anywhere whitespace-pre-wrap">
                  <ComparisonValue
                    field={collection.fields.find((candidate) => candidate.id === field.id)}
                    collection={collection}
                    record={record}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">Full record details</summary>
        <div className="mt-4 grid min-w-0 gap-6 lg:grid-cols-2">
          {source === undefined ? null : (
            <section aria-label="Source record details" className="min-w-0">
              <RecordShowcase collection={source.collection} record={source.record} />
            </section>
          )}
          <section aria-label="Proposed record details" className="min-w-0">
            <RecordShowcase collection={collection} record={record} />
          </section>
        </div>
      </details>
    </div>
  );
}
