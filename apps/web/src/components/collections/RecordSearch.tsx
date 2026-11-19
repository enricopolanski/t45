import type { Collection, RecordFilters } from "@t45/contracts/models/Collection";
import type { Field } from "@t45/contracts/models/Field";
import { resolveRecordSearch } from "@t45/contracts/models/Layout";
import { useEffect, useMemo, useReducer, useState } from "react";

import { describeFailure } from "../../lib/failures";
import { webUrlHost } from "../../lib/webUrl";
import { api, type ApiInput, type ApiSuccess } from "../../rpc/api";
import { Favicon } from "../ExternalUrl";
import { Choice } from "../fields/LayoutEditor";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { plural } from "../work/workLogic";

type Filters = typeof RecordFilters.Type;
type Range = Extract<Filters[string], object>;
type SearchInput = ApiInput<"collections.searchRecords">;
type SearchResult = ApiSuccess<"collections.searchRecords">;
type FilterChoices = NonNullable<SearchResult["filterChoices"]>;

const ALL = "$all";

/** How many records a page of a search shows. */
const RECORDS_PER_PAGE = 25;

/**
 * The records a collection's search finds on `page`, with counts and choices for its filter menus.
 */
export function useRecordSearch(collection: Collection | null, page = 1) {
  const [text, setText] = useState("");
  const [filters, setFilters] = useState<Filters>({});
  const [loaded, setLoaded] = useState<{
    readonly criteria: SearchInput;
    readonly revision: number;
    readonly result: SearchResult;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, refresh] = useReducer((count: number) => count + 1, 0);
  const criteria = useMemo<SearchInput | null>(() => {
    if (collection === null) return null;
    const shown = resolveRecordSearch(collection);
    return {
      collectionId: collection.id,
      text,
      filters,
      fields: shown.fields?.map((field) => field.id) ?? [],
      filterChoices: shown.filters
        .filter((field) => field.type !== "number" && field.type !== "date")
        .map(({ id: fieldId }) => {
          const linkFieldId = collection.fields.find(
            (field) => field.id === shown.iconLinks[fieldId] && field.type === "url",
          )?.id;
          return { fieldId, ...(linkFieldId === undefined ? {} : { linkFieldId }) };
        }),
    };
  }, [collection, text, filters]);
  useEffect(() => {
    if (criteria === null) return;
    let current = true;
    void api("collections.searchRecords", {
      ...criteria,
      offset: (page - 1) * RECORDS_PER_PAGE,
      limit: RECORDS_PER_PAGE,
    }).then(
      (result) => {
        if (!current) return;
        setLoaded({ criteria, revision, result });
        setError(null);
      },
      (cause: unknown) => current && setError(describeFailure(cause)),
    );
    return () => {
      current = false;
    };
  }, [criteria, page, revision]);
  return {
    text,
    setText,
    filters,
    setFilters,
    found: loaded?.result ?? null,
    filterChoices:
      loaded?.criteria === criteria && loaded.revision === revision
        ? loaded.result.filterChoices
        : undefined,
    error,
    refresh,
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

/** A filter picking one value of `field`, all of them without one. */
function ValueFilter({
  field,
  value,
  available,
  onChange,
}: {
  readonly field: Field;
  readonly value: Filters[string] | undefined;
  readonly available: FilterChoices[string] | undefined;
  readonly onChange: (value: string | boolean | undefined) => void;
}) {
  const held = new Map(
    available?.map(({ value, ...rest }) => [
      field.type === "boolean" ? String(value === 1) : String(value),
      rest,
    ]),
  );
  const selected = value === undefined ? ALL : String(value);
  // Keep a selected value visible even when another filter rules it out.
  const keys = new Set(held.keys());
  if (selected !== ALL) keys.add(selected);
  const ordered =
    field.type === "boolean"
      ? ["true", "false"].filter((key) => keys.has(key))
      : [...keys].toSorted((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const choices = ordered.map((key) => {
    const host = webUrlHost(held.get(key)?.link);
    const label = field.type === "boolean" ? (key === "true" ? "Yes" : "No") : key;
    return [
      key,
      <span key={key} className="inline-flex items-center">
        {host === null ? null : <Favicon host={host} />}
        {available === undefined ? label : `${label} (${held.get(key)?.count ?? 0})`}
      </span>,
    ] as const;
  });
  return (
    <Choice
      label={field.label}
      value={selected}
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
  filterChoices,
  onChange,
}: {
  readonly collection: Pick<Collection, "fields" | "layout">;
  readonly filters: Filters;
  readonly filterChoices: FilterChoices | undefined;
  readonly onChange: (filters: Filters) => void;
}) {
  const { filters: shown } = resolveRecordSearch(collection);
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
              field={field}
              value={filters[field.id]}
              available={filterChoices?.[field.id]}
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
