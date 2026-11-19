import { useTranslation } from "~/i18n/locale";
import type { Collection } from "@t45/contracts/models/Collection";
import { type Field, holdsData, isUrlFieldValue } from "@t45/contracts/models/Field";
import {
  listFieldFiles,
  resolveRecordDisplay,
  resolveTableLayout,
  sortRows,
} from "@t45/contracts/models/Layout";
import type { CollectionRecordView } from "@t45/contracts/resources/Collections";
import { getFieldLink } from "@t45/core/fieldViews";
import { ImageIcon } from "lucide-react";
import { useState } from "react";

import { attachmentUrl } from "../../lib/attachmentUrl";
import { cn } from "../../lib/utils";
import { webUrlHost } from "../../lib/webUrl";
import { Favicon } from "../ExternalUrl";
import { MarkdownText } from "../markdown/MarkdownText";
import { Badge } from "../ui/badge";
import { formatRecordValue, renderRecordValue } from "./Records";

type RecordShape = Pick<Collection, "fields" | "primaryKeyFieldId" | "layout">;
type RecordDisplay = ReturnType<typeof resolveRecordDisplay>;

const IMAGE_NAME = /\.(avif|gif|jpe?g|png|svg|webp)$/iu;

/** The addresses of the images a record's image field holds; its other files don't show. */
export const listImageUrls = (display: RecordDisplay, record: CollectionRecordView) =>
  display.image === undefined
    ? []
    : listFieldFiles(display.image, record.values).flatMap((id) => {
        const file = record.files.find((candidate) => candidate.id === id);
        return file !== undefined && IMAGE_NAME.test(file.name) ? [attachmentUrl(file)] : [];
      });

const showValue = (field: Field | undefined, record: CollectionRecordView) =>
  field === undefined ? "" : formatRecordValue(field, record.values[field.id], record.files);

const TONE_BADGES = {
  positive: "success",
  neutral: "secondary",
  warning: "warning",
  negative: "error",
} as const;

/** The site of the record's first web address, which its badges lead with. */
const linkHost = (collection: RecordShape, record: CollectionRecordView) => {
  for (const field of collection.fields) {
    const value = record.values[field.id];
    if (field.type === "url" && isUrlFieldValue(value)) return webUrlHost(value);
  }
  return null;
};

/** The icon of the site the record links to, then its options of `fields` as badges in their tones. */
function RecordBadges({
  collection,
  fields,
  record,
}: {
  readonly collection: RecordShape;
  readonly fields: ReadonlyArray<Field>;
  readonly record: CollectionRecordView;
}) {
  const host = linkHost(collection, record);
  const badges = fields.flatMap((field) => {
    const option = record.values[field.id];
    return field.type === "select" && typeof option === "string"
      ? [{ id: field.id, option, tone: field.tones?.[option] ?? "neutral" }]
      : [];
  });
  if (badges.length === 0 && host === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {host === null ? null : (
        <span className="leading-none">
          <Favicon host={host} />
        </span>
      )}
      {badges.map(({ id, option, tone }) => (
        <Badge key={id} variant={TONE_BADGES[tone]}>
          {option}
        </Badge>
      ))}
    </div>
  );
}

const CARD_SIZES = {
  small: "grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]",
  medium: "grid-cols-[repeat(auto-fill,minmax(13rem,1fr))]",
  large: "grid-cols-[repeat(auto-fill,minmax(18rem,1fr))]",
};
const IMAGE_RATIOS = {
  square: "aspect-square",
  portrait: "aspect-[3/4]",
  landscape: "aspect-[4/3]",
};
const IMAGE_FITS = { contain: "object-contain", cover: "object-cover" };

/**
 * Records as cards in a grid, in the order the collection's layout sorts them, each showing the
 * parts its display gives fields; a card opens its record.
 */
export function RecordCards({
  label,
  collection,
  records,
  onOpen,
}: {
  readonly label: string;
  readonly collection: RecordShape;
  readonly records: ReadonlyArray<CollectionRecordView>;
  readonly onOpen: (record: CollectionRecordView) => void;
}) {
  const t = useTranslation();
  const display = resolveRecordDisplay(collection);
  const { sortBy } = resolveTableLayout(collection.fields, collection.layout);
  return (
    <ul aria-label={label} className={cn("grid gap-4", CARD_SIZES[display.size])}>
      {sortRows(records, sortBy, (record, id) => record.values[id]).map((record) => {
        const [image] = listImageUrls(display, record);
        return (
          <li key={record.key} className="flex">
            <button
              type="button"
              aria-label={t("Record {0}", record.key)}
              onClick={() => onOpen(record)}
              className="flex w-full flex-col overflow-hidden rounded-xl border bg-card text-left transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-primary"
            >
              {display.image === undefined ? null : (
                <div
                  className={cn(
                    "flex w-full items-center justify-center overflow-hidden bg-muted",
                    IMAGE_RATIOS[display.imageRatio],
                  )}
                >
                  {image === undefined ? (
                    <ImageIcon className="size-8 text-muted-foreground/40" />
                  ) : (
                    <img
                      src={image}
                      alt=""
                      loading="lazy"
                      className={cn("size-full", IMAGE_FITS[display.imageFit])}
                    />
                  )}
                </div>
              )}
              <div className="flex flex-1 flex-col gap-1 p-3">
                <RecordBadges collection={collection} fields={display.badges} record={record} />
                <span className="line-clamp-2 font-medium">{showValue(display.title, record)}</span>
                {display.subtitle ? (
                  <span className="text-sm text-muted-foreground">
                    {showValue(display.subtitle, record)}
                  </span>
                ) : null}
                {display.extra.map((field) => (
                  <span key={field.id} className="text-xs text-muted-foreground tabular-nums">
                    {`${field.label}: ${showValue(field, record)}`}
                  </span>
                ))}
                {display.highlight ? (
                  <span className="mt-auto pt-1 text-lg font-semibold tabular-nums">
                    {showValue(display.highlight, record)}
                  </span>
                ) : null}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const isLongText = (field: Field) => field.type === "text" && field.isMarkdown === true;

/**
 * A record as a showcase: its images as a gallery beside its title, highlight, badges and other
 * values, and its long text below. Groups other than the images show only in its form.
 */
export function RecordShowcase({
  collection,
  record,
}: {
  readonly collection: RecordShape;
  readonly record: CollectionRecordView;
}) {
  const t = useTranslation();
  const hidden = new Set(collection.layout?.page?.hiddenFields);
  const visible = {
    ...collection,
    fields: collection.fields.filter((field) => !hidden.has(field.id)),
  };
  const display = resolveRecordDisplay(visible);
  const images = listImageUrls(display, record);
  const [shownImage, setShownImage] = useState(0);
  const featured = new Set([
    display.image,
    display.title,
    display.subtitle,
    display.highlight,
    ...display.badges,
  ]);
  const shown = visible.fields.filter(
    (field) =>
      !featured.has(field) &&
      field.type !== "group" &&
      (field.type !== "url" || field.displayLinkOn === undefined) &&
      holdsData(record.values[field.id]),
  );
  const description = shown.find(
    (field) => field.type === "text" && field.id === collection.layout?.page?.description,
  );
  const properties = shown.filter((field) => field !== description && !isLongText(field));
  const title = showValue(display.title, record);
  return (
    <div
      className={cn("grid gap-8", display.image && "md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]")}
    >
      {display.image ? (
        <div className="flex flex-col gap-2">
          <div className="flex aspect-square items-center justify-center overflow-hidden rounded-xl border bg-muted">
            {images[shownImage] === undefined ? (
              <ImageIcon className="size-10 text-muted-foreground/40" />
            ) : (
              <img src={images[shownImage]} alt={title} className="size-full object-contain" />
            )}
          </div>
          {images.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {images.map((url, at) => (
                <button
                  key={url}
                  type="button"
                  aria-label={t("Image {0}", at + 1)}
                  aria-pressed={at === shownImage}
                  onClick={() => setShownImage(at)}
                  className="size-16 overflow-hidden rounded-md border-2 border-transparent bg-muted aria-pressed:border-primary"
                >
                  <img src={url} alt="" loading="lazy" className="size-full object-cover" />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-col gap-3">
        <RecordBadges collection={visible} fields={display.badges} record={record} />
        {title === "" ? null : <h2 className="text-2xl font-semibold text-balance">{title}</h2>}
        {display.subtitle ? (
          <p className="text-muted-foreground">{showValue(display.subtitle, record)}</p>
        ) : null}
        {display.highlight ? (
          <p className="text-3xl font-semibold tabular-nums">
            {showValue(display.highlight, record)}
          </p>
        ) : null}
        {description === undefined ? null : (
          <section className="flex flex-col gap-2">
            <h3 className="font-semibold">{description.label}</h3>
            <MarkdownText text={String(record.values[description.id])} />
          </section>
        )}
        {properties.length === 0 ? null : (
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t pt-3 text-sm">
            {properties.map((field) => (
              <div key={field.id} className="contents">
                <dt className="text-muted-foreground">{field.label}</dt>
                <dd className="break-words tabular-nums">
                  {renderRecordValue(
                    field,
                    record.values[field.id],
                    record.files,
                    getFieldLink(field.id, visible.fields, record.values),
                    true,
                    t,
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {shown
        .filter((field) => field !== description && isLongText(field))
        .map((field) => (
          <section key={field.id} className="flex flex-col gap-2 border-t pt-4 md:col-span-2">
            <h3 className="font-semibold">{field.label}</h3>
            <MarkdownText text={String(record.values[field.id])} />
          </section>
        ))}
    </div>
  );
}
