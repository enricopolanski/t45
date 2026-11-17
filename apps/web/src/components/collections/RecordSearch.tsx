import type { Collection, RecordFilters } from "@t45/contracts/models/Collection";
import type { Field } from "@t45/contracts/models/Field";
import { resolveRecordSearch } from "@t45/contracts/models/Layout";
import type { CollectionRecordView } from "@t45/contracts/resources/Collections";
import { useCallback, useEffect, useState } from "react";

import { describeFailure } from "../../lib/failures";
import { api } from "../../rpc/api";
import { Choice } from "../fields/LayoutEditor";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { plural } from "../work/workLogic";

type Filters = typeof RecordFilters.Type;
type Range = Extract<Filters[string], object>;

const ALL = "$all";

/** How many records a page of a search shows. */
const RECORDS_PER_PAGE = 25;

/**
 * The records of a collection its search finds: their words, looked for in `fields` or the
 * layout's, and their filters, on `page` of their pages, with how many match of how many there are.
 */
export function useRecordSearch(collectionId: string, fields?: ReadonlyArray<string>, page = 1) {
  const [text, setText] = useState("");
  const [filters, setFilters] = useState<Filters>({});
  const [found, setFound] = useState<{
    readonly records: ReadonlyArray<CollectionRecordView>;
    readonly hasMore: boolean;
    readonly matchCount: number;
    readonly totalCount: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = useCallback(
    () =>
      api("collections.searchRecords", {
        collectionId,
        text,
        filters,
        offset: (page - 1) * RECORDS_PER_PAGE,
        limit: RECORDS_PER_PAGE,
        ...(fields === undefined ? {} : { fields }),
      }),
    [collectionId, text, filters, fields, page],
  );
  useEffect(() => {
    let current = true;
    void search().then(
      (loaded) => current && setFound(loaded),
      (cause: unknown) => current && setError(describeFailure(cause)),
    );
    return () => {
      current = false;
    };
  }, [search]);
  return {
    text,
    setText,
    filters,
    setFilters,
    found,
    error,
    refresh: () =>
      void search().then(setFound, (cause: unknown) => setError(describeFailure(cause))),
  };
}

/** The pages to offer around `page` of `last`: the first, the last and its neighbours, gaps as null. */
const pagesAround = (page: number, last: number) => {
  const shown = [...new Set([1, page - 1, page, page + 1, last])]
    .filter((each) => each >= 1 && each <= last)
    .toSorted((one, other) => one - other);
  return shown.flatMap((each, at) => (at > 0 && each - shown[at - 1]! > 1 ? [null, each] : [each]));
};

/** Which of `matchCount` records `page` shows, and the way to the other pages. */
export function RecordPager({
  page,
  matchCount,
  onPage,
}: {
  readonly page: number;
  readonly matchCount: number;
  readonly onPage: (page: number) => void;
}) {
  const last = Math.max(1, Math.ceil(matchCount / RECORDS_PER_PAGE));
  if (last === 1) return null;
  const first = (page - 1) * RECORDS_PER_PAGE + 1;
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center gap-1">
      <span className="me-2 text-sm text-muted-foreground tabular-nums">
        {first}–{Math.min(page * RECORDS_PER_PAGE, matchCount)} of {matchCount}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Previous page"
        disabled={page === 1}
        onClick={() => onPage(page - 1)}
      >
        <ChevronLeftIcon />
      </Button>
      {pagesAround(page, last).map((each, at) =>
        each === null ? (
          <span key={`gap-${at}`} className="px-1 text-sm text-muted-foreground">
            …
          </span>
        ) : (
          <Button
            key={each}
            size="sm"
            variant={each === page ? "secondary" : "ghost"}
            aria-label={`Page ${each}`}
            aria-current={each === page ? "page" : undefined}
            onClick={() => onPage(each)}
          >
            {each}
          </Button>
        ),
      )}
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Next page"
        disabled={page === last}
        onClick={() => onPage(page + 1)}
      >
        <ChevronRightIcon />
      </Button>
    </nav>
  );
}

/** One bound of a range as its input holds it: a number for a number field, else a date. */
const parseBound = (field: Field, input: string) =>
  input === "" ? undefined : field.type === "number" ? Number(input) : input;

/** The range `field` lies within, set from two inputs; an open range is no filter. */
function RangeFilter({
  field,
  range,
  onChange,
}: {
  readonly field: Field;
  readonly range: Range | undefined;
  readonly onChange: (range: Range | undefined) => void;
}) {
  const setBound = (bound: "min" | "max", input: string) => {
    const { [bound]: _, ...rest } = range ?? {};
    const value = parseBound(field, input);
    const next = value === undefined ? rest : { ...rest, [bound]: value };
    onChange(Object.keys(next).length === 0 ? undefined : next);
  };
  return (
    <div className="flex items-center gap-1">
      {(["min", "max"] as const).map((bound) => (
        <div key={bound} className="w-32">
          <Input
            size="sm"
            type={field.type === "number" ? "number" : "date"}
            aria-label={`${field.label} ${bound === "min" ? "from" : "to"}`}
            placeholder={bound === "min" ? "From" : "To"}
            value={String(range?.[bound] ?? "")}
            onChange={(event) => setBound(bound, event.target.value)}
          />
        </div>
      ))}
    </div>
  );
}

/** The values a filter on `field` picks from: its options, yes or no, or those its records hold. */
function useFilterChoices(collectionId: string, field: Field) {
  const [held, setHeld] = useState<ReadonlyArray<string>>([]);
  const isHeld = field.type === "text";
  useEffect(() => {
    if (!isHeld) return;
    let current = true;
    void api("collections.listFieldValues", { collectionId, fieldId: field.id }).then(
      (values) => current && setHeld(values.map(String)),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [collectionId, field.id, isHeld]);
  if (field.type === "select") return field.options.map((option) => [option, option] as const);
  if (field.type === "boolean")
    return [
      ["true", "Yes"],
      ["false", "No"],
    ] as const;
  return held.map((value) => [value, value] as const);
}

/** A filter picking one value of `field`, all of them without one. */
function ValueFilter({
  collectionId,
  field,
  value,
  onChange,
}: {
  readonly collectionId: string;
  readonly field: Field;
  readonly value: Filters[string] | undefined;
  readonly onChange: (value: string | boolean | undefined) => void;
}) {
  const choices = useFilterChoices(collectionId, field);
  return (
    <Choice
      label={field.label}
      value={value === undefined ? ALL : String(value)}
      choices={{ [ALL]: "All", ...Object.fromEntries(choices) }}
      onChange={(choice) =>
        onChange(choice === ALL ? undefined : field.type === "boolean" ? choice === "true" : choice)
      }
    />
  );
}

/** The filters a collection's layout shows above its records, each labeled by its field. */
export function RecordFilterBar({
  collection,
  filters,
  onChange,
}: {
  readonly collection: Pick<Collection, "id" | "fields" | "layout">;
  readonly filters: Filters;
  readonly onChange: (filters: Filters) => void;
}) {
  const shown = resolveRecordSearch(collection).filters;
  if (shown.length === 0) return null;
  const setFilter = (fieldId: string, value: Filters[string] | undefined) => {
    const { [fieldId]: _, ...rest } = filters;
    onChange(value === undefined ? rest : { ...rest, [fieldId]: value });
  };
  return (
    <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {shown.map((field) => (
        <div key={field.id} className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{field.label}</span>
          {field.type === "number" || field.type === "date" ? (
            <RangeFilter
              field={field}
              range={
                typeof filters[field.id] === "object" ? (filters[field.id] as Range) : undefined
              }
              onChange={(range) => setFilter(field.id, range)}
            />
          ) : (
            <ValueFilter
              collectionId={collection.id}
              field={field}
              value={filters[field.id]}
              onChange={(value) => setFilter(field.id, value)}
            />
          )}
        </div>
      ))}
      {Object.keys(filters).length > 0 ? (
        <Button size="xs" variant="ghost" onClick={() => onChange({})}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

/** How many records match, of how many the collection holds. */
export function RecordCount({
  matchCount,
  totalCount,
}: {
  readonly matchCount: number;
  readonly totalCount: number;
}) {
  return (
    <p className="text-sm text-muted-foreground tabular-nums">
      {matchCount === totalCount
        ? plural(totalCount, "record", "records")
        : `${matchCount} of ${plural(totalCount, "record", "records")}`}
    </p>
  );
}
