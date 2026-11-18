import type { Collection, CollectionLayout } from "@t45/contracts/models/Collection";
import type { Field } from "@t45/contracts/models/Field";
import {
  isFilterable,
  isSearchable,
  resolveRecordDisplay,
  resolveRecordSearch,
} from "@t45/contracts/models/Layout";
import type { CollectionRecordView } from "@t45/contracts/resources/Collections";
import { XIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";

import {
  Choice,
  type LayoutView,
  MoveButtons,
  PanelSection,
  withKey,
  withPart,
} from "../fields/LayoutEditor";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { ErrorText } from "../ui/error-text";
import { Field as LabeledField } from "../ui/field";
import { Input } from "../ui/input";
import { moveEntry } from "../workflows/workflowLogic";
import { RecordCards, RecordShowcase } from "./RecordDisplay";
import { RecordTable } from "./Records";
import { RecordCount, RecordFilterBar, useRecordSearch } from "./RecordSearch";

type Display = NonNullable<CollectionLayout["display"]>;
type Cards = NonNullable<CollectionLayout["cards"]>;
type Search = NonNullable<CollectionLayout["search"]>;
type Role = "image" | "title" | "subtitle" | "highlight";

const NONE = "$none";
const ROLES: ReadonlyArray<readonly [Role, string]> = [
  ["image", "Image"],
  ["title", "Title"],
  ["subtitle", "Subtitle"],
  ["highlight", "Highlight"],
];
const SIZES = { small: "Small", medium: "Medium", large: "Large" };
const RATIOS = { square: "Square", portrait: "Portrait", landscape: "Landscape" };
const FITS = { contain: "Whole image", cover: "Fill, cropped" };
const VIEWS = { table: "Table", cards: "Grid" };
const TEMPLATES = { form: "Form", showcase: "Showcase" };

/** Some of `fields`, up to `max`, picked by checkbox in the order picked. */
function PickFields({
  label,
  fields,
  picked,
  max = Infinity,
  onChange,
}: {
  readonly label: string;
  readonly max?: number;
  readonly fields: ReadonlyArray<Field>;
  readonly picked: ReadonlyArray<string>;
  readonly onChange: (picked: ReadonlyArray<string>) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-xs font-medium">{label}</legend>
      {fields.map((field) => (
        <label key={field.id} className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={picked.includes(field.id)}
            disabled={!picked.includes(field.id) && picked.length >= max}
            onCheckedChange={(isPicked) =>
              onChange(isPicked ? [...picked, field.id] : picked.filter((id) => id !== field.id))
            }
          />
          {field.label}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The grid's settings: the field playing each part of a card and a record's page, the cards'
 * extra lines, size and image, and which view the collection's page starts on.
 */
function GridSettings({
  collection,
  layout,
  onChange,
}: {
  readonly collection: Collection;
  readonly layout: CollectionLayout | undefined;
  readonly onChange: (layout: CollectionLayout | undefined) => void;
}) {
  const resolved = resolveRecordDisplay({ ...collection, layout: layout ?? {} });
  // A display starts from the parts shown without one.
  const display: Display = layout?.display ?? {
    ...(resolved.image ? { image: resolved.image.id } : {}),
    ...(resolved.title ? { title: resolved.title.id } : {}),
  };
  const cards: Cards = layout?.cards ?? {};
  const setDisplay = (next: Display) => onChange(withPart(layout, "display", next));
  const setCards = (next: Cards) => onChange(withPart(layout, "cards", next));
  const lines = collection.fields.filter(
    (field) =>
      !["group", "file", "records"].includes(field.type) &&
      (field.type !== "text" || field.isMarkdown !== true),
  );
  const fitting: Record<Role, ReadonlyArray<Field>> = {
    image: collection.fields.filter(
      (field) =>
        field.type === "file" ||
        (field.type === "group" && field.fields.some((inner) => inner.type === "file")),
    ),
    title: lines,
    subtitle: lines,
    highlight: lines,
  };
  return (
    <>
      <PanelSection title="Parts" hint="Which field each part of a card and a record's page shows.">
        {ROLES.map(([role, label]) => (
          <LabeledField
            key={role}
            label={label}
            size="xs"
            className="flex-row items-center justify-between"
          >
            <Choice
              label={label}
              value={resolved[role]?.id ?? NONE}
              // A record always has a title: the primary key without one.
              choices={{
                ...(role === "title" ? {} : { [NONE]: "None" }),
                ...Object.fromEntries(fitting[role].map((field) => [field.id, field.label])),
              }}
              onChange={(id) => setDisplay(withKey(display, role, id === NONE ? undefined : id))}
            />
          </LabeledField>
        ))}
        <PickFields
          label="Badges"
          max={3}
          fields={collection.fields.filter((field) => field.type === "select")}
          picked={resolved.badges.map((field) => field.id)}
          onChange={(badges) =>
            setDisplay(withKey(display, "badges", badges.length === 0 ? undefined : badges))
          }
        />
      </PanelSection>
      <PanelSection title="Cards">
        <PickFields
          label="Lines under the title"
          max={3}
          fields={lines}
          picked={resolved.extra.map((field) => field.id)}
          onChange={(extra) =>
            setCards(withKey(cards, "extra", extra.length === 0 ? undefined : extra))
          }
        />
        <LabeledField label="Card size" size="xs" className="flex-row items-center justify-between">
          <Choice
            label="Card size"
            value={resolved.size}
            choices={SIZES}
            onChange={(size) =>
              setCards(withKey(cards, "size", size === "medium" ? undefined : size))
            }
          />
        </LabeledField>
        <LabeledField
          label="Image shape"
          size="xs"
          className="flex-row items-center justify-between"
        >
          <Choice
            label="Image shape"
            value={resolved.imageRatio}
            choices={RATIOS}
            onChange={(ratio) =>
              setCards(withKey(cards, "imageRatio", ratio === "square" ? undefined : ratio))
            }
          />
        </LabeledField>
        <LabeledField label="Image fit" size="xs" className="flex-row items-center justify-between">
          <Choice
            label="Image fit"
            value={resolved.imageFit}
            choices={FITS}
            onChange={(fit) =>
              setCards(withKey(cards, "imageFit", fit === "contain" ? undefined : fit))
            }
          />
        </LabeledField>
        <LabeledField
          label="Records show first as"
          size="xs"
          className="flex-row items-center justify-between"
        >
          <Choice
            label="Records show first as"
            value={resolved.defaultView}
            choices={VIEWS}
            onChange={(view) =>
              onChange(withPart(layout, "defaultView", view === "table" ? undefined : view))
            }
          />
        </LabeledField>
      </PanelSection>
    </>
  );
}

/** The search's settings: the fields its words are looked for in, and its filters in order. */
function SearchSettings({
  collection,
  layout,
  onChange,
}: {
  readonly collection: Collection;
  readonly layout: CollectionLayout | undefined;
  readonly onChange: (layout: CollectionLayout | undefined) => void;
}) {
  const search: Search = layout?.search ?? {};
  const resolved = resolveRecordSearch({ ...collection, layout: layout ?? {} });
  const filterIds = resolved.filters.map((field) => field.id);
  const setSearch = (next: Search) => onChange(withPart(layout, "search", next));
  const setFilters = (ids: ReadonlyArray<string>, iconLinks = resolved.iconLinks) =>
    setSearch(
      withKey(
        search,
        "filters",
        ids.length === 0
          ? undefined
          : ids.map((field) =>
              iconLinks[field] === undefined ? { field } : { field, iconLink: iconLinks[field] },
            ),
      ),
    );
  const urlFields = collection.fields.filter((field) => field.type === "url");
  const addable = collection.fields.filter(
    (field) => isFilterable(field) && !filterIds.includes(field.id),
  );
  return (
    <>
      <PanelSection
        title="Search"
        hint="Every word of a search appears in one of these fields. With none picked, it looks in every text value."
      >
        <PickFields
          label="Search in"
          fields={collection.fields.filter(isSearchable)}
          picked={resolved.fields?.map((field) => field.id) ?? []}
          onChange={(ids) =>
            setSearch(withKey(search, "fields", ids.length === 0 ? undefined : ids))
          }
        />
      </PanelSection>
      <PanelSection
        title="Filters"
        hint="Shown above the records in this order: a select, yes/no or text field picks a value, a number or date field a range."
      >
        {resolved.filters.length > 0 ? (
          <ol className="flex flex-col divide-y rounded-lg border">
            {resolved.filters.map((field, at) => (
              <li key={field.id} className="flex items-center gap-1.5 px-2 py-1.5">
                <MoveButtons
                  what={field.label}
                  onMove={(delta) => setFilters(moveEntry(filterIds, at, delta))}
                  isFirst={at === 0}
                  isLast={at === filterIds.length - 1}
                />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{field.label}</span>
                {urlFields.length > 0 && field.type !== "number" && field.type !== "date" ? (
                  <Choice
                    label={`Site icons of the ${field.label} filter`}
                    value={resolved.iconLinks[field.id] ?? NONE}
                    choices={{
                      [NONE]: "No site icons",
                      ...Object.fromEntries(
                        urlFields.map((url) => [url.id, `Site icons from ${url.label}`]),
                      ),
                    }}
                    onChange={(id) => {
                      const { [field.id]: _, ...rest } = resolved.iconLinks;
                      setFilters(filterIds, id === NONE ? rest : { ...rest, [field.id]: id });
                    }}
                  />
                ) : null}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove the ${field.label} filter`}
                  onClick={() => setFilters(filterIds.filter((id) => id !== field.id))}
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ol>
        ) : null}
        {addable.length > 0 ? (
          <Choice
            label="Add a filter"
            value={NONE}
            choices={{
              [NONE]: "Add a filter…",
              ...Object.fromEntries(addable.map((field) => [field.id, field.label])),
            }}
            onChange={(id) => (id === NONE ? undefined : setFilters([...filterIds, id]))}
          />
        ) : null}
      </PanelSection>
    </>
  );
}

/** The collection's search as `layout` sets it up, over its real records. */
function SearchPreview({
  collection,
  layout,
}: {
  readonly collection: Collection;
  readonly layout: CollectionLayout | undefined;
}) {
  // The editor's unsaved fields, none for every text value, replace the saved layout's.
  const searched = layout?.search?.fields;
  const fields = useMemo(() => searched ?? [], [searched]);
  const { text, setText, filters, setFilters, found, error } = useRecordSearch(
    collection.id,
    fields,
  );
  const shown = { ...collection, layout: layout ?? {} };
  return (
    <div className="flex flex-col gap-3">
      <Input
        type="search"
        aria-label="Search records"
        placeholder="Search records"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <RecordFilterBar collection={shown} filters={filters} onChange={setFilters} />
      {error && <ErrorText text={error} />}
      {found === null ? null : (
        <>
          <RecordCount matchCount={found.matchCount} totalCount={found.totalCount} />
          <RecordTable label="Records" collection={shown} records={found.records} />
        </>
      )}
    </div>
  );
}

/**
 * A collection's own views in its layout editor: its records as cards, how people search them, and
 * one record on its page, previewed with `records`; `renderForm` shows a record's form.
 */
export const makeCollectionViews = (
  collection: Collection,
  records: ReadonlyArray<CollectionRecordView>,
  renderForm: (layout: CollectionLayout | undefined, key: string) => ReactNode,
): ReadonlyArray<LayoutView<CollectionLayout>> => [
  {
    value: "cards",
    label: "Grid",
    isPerEntry: false,
    settings: (layout, onChange) => (
      <GridSettings collection={collection} layout={layout} onChange={onChange} />
    ),
    preview: (layout, _, onOpen) => (
      <RecordCards
        label="Records"
        collection={{ ...collection, layout: layout ?? {} }}
        records={records}
        onOpen={(record) => onOpen(record.key, "page")}
      />
    ),
  },
  {
    value: "search",
    label: "Search",
    isPerEntry: false,
    settings: (layout, onChange) => (
      <SearchSettings collection={collection} layout={layout} onChange={onChange} />
    ),
    preview: (layout) => <SearchPreview collection={collection} layout={layout} />,
  },
  {
    value: "page",
    label: "Page",
    isPerEntry: true,
    settings: (layout, onChange) => (
      <PanelSection
        title="Record page"
        hint="Showcase shows a record's images beside its parts and values, its long text below, and edits it on demand."
      >
        <LabeledField label="Template" size="xs" className="flex-row items-center justify-between">
          <Choice
            label="Template"
            value={layout?.page?.template ?? "form"}
            choices={TEMPLATES}
            onChange={(template) =>
              onChange(withPart(layout, "page", template === "form" ? undefined : { template }))
            }
          />
        </LabeledField>
      </PanelSection>
    ),
    preview: (layout, key) => {
      const record = records.find((candidate) => candidate.key === key);
      if (record === undefined) return null;
      return layout?.page?.template === "showcase" ? (
        <RecordShowcase collection={{ ...collection, layout: layout ?? {} }} record={record} />
      ) : (
        renderForm(layout, key)
      );
    },
  },
];
