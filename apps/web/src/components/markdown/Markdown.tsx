import type { ChatContextKind } from "@t45/contracts/models/Chat";
import { parseComposerContextHref } from "@t45/core/composerContextReferences";
import { Check, Copy, Maximize2, Minimize2 } from "lucide";
import {
  ChevronRightIcon,
  GlobeIcon,
  InfoIcon,
  LightbulbIcon,
  MessageSquareWarningIcon,
  OctagonAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  Children,
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type ExtraProps,
} from "react-markdown";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  isImagePath,
  resolveProtocolRelativeUrl,
  safeDecodeURIComponent,
  webUrlFileName,
  webUrlHost,
} from "../../lib/webUrl";
import { cn } from "../../lib/utils";
import {
  ImageUnavailableLabel,
  type GalleryImage,
  type ImageGallery,
} from "../chat/ExpandedImageDialog";
import { GitHubIcon } from "../Icons";
import { MorphIcon } from "../MorphIcon";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { CodeBlock } from "./CodeBlock";
import { copySelectionAsMarkdown, setMarkdownSource, tableToCsv, tableToMarkdown } from "./copy";
import { MarkdownAction } from "./MarkdownAction";
import { createIncrementalMarkdownPlugin, hastText, rehypePlugins, remarkPlugins } from "./plugins";

interface MarkdownProps {
  text: string;
  isStreaming?: boolean;
  className?: string;
  /** Treat single newlines as hard breaks — chat-style user input. */
  lineBreaks?: boolean;
  /** Parse sanitized raw HTML instead of displaying its source text. */
  parseRawHtml?: boolean;
  onImageExpand: (gallery: ImageGallery) => void;
  /** Renders a `t45-context:` link as a chip; without it the link shows its label as text. */
  renderContextReference?: ((reference: MarkdownContextReference) => ReactNode) | undefined;
}

export interface MarkdownContextReference {
  kind: ChatContextKind;
  contextId: string;
  label: string;
}

interface MarkdownState {
  onImageExpand: (gallery: ImageGallery) => void;
  renderContextReference: ((reference: MarkdownContextReference) => ReactNode) | undefined;
  isStreaming: boolean;
}

type ElementProps<Tag extends keyof JSX.IntrinsicElements> = ComponentProps<Tag> &
  ExtraProps & { "data-md"?: string };

const MarkdownContext = createContext<MarkdownState>(null!);

/** Inside a link, an image follows the link instead of opening the preview. */
const MarkdownLinkContext = createContext(false);

export const Markdown = memo(function Markdown({
  text,
  isStreaming = false,
  className,
  lineBreaks = false,
  parseRawHtml = true,
  onImageExpand,
  renderContextReference,
}: MarkdownProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (rootRef.current) setMarkdownSource(rootRef.current, text);
  }, [text]);
  const remark = useMemo(
    () => [
      ...remarkPlugins(lineBreaks),
      ...(isStreaming ? [createIncrementalMarkdownPlugin()] : []),
    ],
    [isStreaming, lineBreaks],
  );
  const state = useMemo(
    () => ({ onImageExpand, renderContextReference, isStreaming }),
    [onImageExpand, renderContextReference, isStreaming],
  );

  return (
    <div
      ref={rootRef}
      className={cn("chat-markdown", className)}
      // Gates the fade-in for blocks that arrive while the response streams.
      data-streaming={isStreaming ? "" : undefined}
      onCopy={copySelectionAsMarkdown}
    >
      <MarkdownContext value={state}>
        {/* With skipHtml off, react-markdown shows unparsed HTML as its source text, which
            user messages (parseRawHtml off) rely on. */}
        <ReactMarkdown
          remarkPlugins={remark}
          rehypePlugins={rehypePlugins(parseRawHtml)}
          skipHtml={false}
          components={COMPONENTS}
          urlTransform={urlTransform}
        >
          {text}
        </ReactMarkdown>
      </MarkdownContext>
    </div>
  );
});

function urlTransform(href: string): string {
  if (parseComposerContextHref(href)) return href;
  return runnerFileHref(href) ?? defaultUrlTransform(href);
}

/**
 * Agents link files on their runner, which the browser cannot open. Returns such a link's
 * destination as a path, still percent-encoded, with `file:` URLs unwrapped; null for web
 * links, in-page anchors and other schemes.
 */
function runnerFileHref(href: string): string | null {
  if (/^file:/i.test(href)) {
    try {
      const url = new URL(href);
      return `${url.pathname}${url.hash}`;
    } catch {
      return null;
    }
  }
  if (href === "" || href.startsWith("#") || href.startsWith("//")) return null;
  return /^[a-z][a-z0-9+.-]*:/i.test(href) ? null : href;
}

/** Whether a link's label already names the file it points at, so the path need not repeat. */
function labelNamesPath(label: string, path: string): boolean {
  const name = label.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  const target = path.replace(/\/+$/, "");
  return target === name || target.endsWith(`/${name}`);
}

/**
 * Marks a rendering that stands for its whole source, such as a chip for a link: a selection
 * touching it copies all of it (see copy.ts).
 */
function wholeSource(dataMd: string | undefined) {
  return { "data-md": dataMd, "data-md-whole": "" };
}

/** GitHub's own five alert kinds, in its colors: the glyph names the urgency, the title says it. */
const GITHUB_ALERTS = {
  note: { label: "Note", Icon: InfoIcon },
  tip: { label: "Tip", Icon: LightbulbIcon },
  important: { label: "Important", Icon: MessageSquareWarningIcon },
  warning: { label: "Warning", Icon: TriangleAlertIcon },
  caution: { label: "Caution", Icon: OctagonAlertIcon },
};

/**
 * The default `1.25rem` marker gutter (`.chat-markdown ol`) fits one-character
 * markers. Wider markers can extend past it and get clipped by a collapsed
 * message's overflow. Widen the gutter to fit the widest marker, including a
 * negative marker's minus sign.
 */
function orderedListGutterStyle(
  itemCount: number,
  start: unknown,
): { "--list-gutter": string } | undefined {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  const firstNumber = Number.isNaN(parsedStart) ? 1 : parsedStart;
  const lastNumber = firstNumber + Math.max(itemCount - 1, 0);
  const markerWidth = Math.max(String(firstNumber).length, String(lastNumber).length);
  if (markerWidth <= 1) return undefined;
  return { "--list-gutter": `${markerWidth + 1}ch` };
}

// Screen readers take a heading's level from its tag, which would let a `#` in a
// message outrank the author's <h3> placed above it. Override only the exposed level:
// the tag keeps driving the stylesheet.
const AUTHOR_HEADING_LEVEL = 3;
function markdownHeading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${level}` as const;
  return function MarkdownHeading({ node: _node, ...props }: ElementProps<typeof Tag>) {
    return <Tag {...props} aria-level={Math.min(level + AUTHOR_HEADING_LEVEL, 6)} />;
  };
}

// Keep component types stable when streaming changes the message state.
const COMPONENTS = {
  h1: markdownHeading(1),
  h2: markdownHeading(2),
  h3: markdownHeading(3),
  h4: markdownHeading(4),
  h5: markdownHeading(5),
  h6: markdownHeading(6),
  blockquote: function MarkdownBlockquote({
    node: _node,
    children,
    "data-alert": kind = "",
    ...props
  }: ElementProps<"blockquote"> & { "data-alert"?: string }) {
    const alert = Object.hasOwn(GITHUB_ALERTS, kind)
      ? GITHUB_ALERTS[kind as keyof typeof GITHUB_ALERTS]
      : undefined;
    if (!alert) {
      return <blockquote {...props}>{children}</blockquote>;
    }
    // Not a <blockquote>: the stylesheet mutes those, and an alert's body is ordinary
    // text under a colored title — which is how the host renders it.
    return (
      <div role="note" data-alert={kind} data-md={props["data-md"]} className="chat-markdown-alert">
        <p data-md-ui="" className="flex items-center gap-1.5 font-medium select-none">
          <alert.Icon aria-hidden className="size-3.5 shrink-0" />
          {alert.label}
        </p>
        {children}
      </div>
    );
  },
  ol: function MarkdownOrderedList({ node, start, style, ...props }) {
    const itemCount =
      node?.children.filter((child) => child.type === "element" && child.tagName === "li").length ??
      0;
    const gutterStyle = orderedListGutterStyle(itemCount, start);
    return (
      <ol {...props} start={start} style={gutterStyle ? { ...style, ...gutterStyle } : style} />
    );
  },
  a: MarkdownLink,
  img: MarkdownImageRenderer,
  table: MarkdownTable,
  details: MarkdownDetails,
  summary: MarkdownSummary,
  pre: function MarkdownPre(props) {
    const { onImageExpand, isStreaming } = use(MarkdownContext);
    return (
      <CodeBlock
        {...props}
        isStreaming={isStreaming}
        onExpandDiagram={(src) =>
          onImageExpand({ images: [{ src, name: "Mermaid diagram" }], index: 0 })
        }
      />
    );
  },
} satisfies Components;

function MarkdownDetails({ node, children, ...props }: ElementProps<"details">) {
  const summarized = node?.children.some(
    (child) => child.type === "element" && child.tagName === "summary",
  );
  return (
    <details
      {...props}
      className="my-2 border-y border-border/60 ps-6 open:pb-3 [&[open]>summary>svg]:rotate-90"
    >
      {summarized ? null : <MarkdownSummary data-md-ui="">Details</MarkdownSummary>}
      {children}
    </details>
  );
}

function MarkdownSummary({ node: _node, children, ...props }: ElementProps<"summary">) {
  return (
    <summary
      {...props}
      className="-ms-6 flex cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden"
    >
      <ChevronRightIcon
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground transition-transform"
      />
      {children}
    </summary>
  );
}

function MarkdownLink({ node, href, children, title: _title, ...props }: ElementProps<"a">) {
  const { onImageExpand, renderContextReference } = use(MarkdownContext);
  // An empty or stripped destination leaves only the label.
  if (!href) return <a {...props}>{children}</a>;

  const source = wholeSource(props["data-md"]);
  const contextReference = parseComposerContextHref(href);
  if (contextReference) {
    const label = hastText(node) || contextReference.contextId;
    return (
      <span {...source}>
        {renderContextReference ? renderContextReference({ ...contextReference, label }) : label}
      </span>
    );
  }

  const fileHref = runnerFileHref(href);
  if (fileHref !== null) {
    // A file on the agent's runner: nothing here can open it, so show the path as code.
    const filePath = safeDecodeURIComponent(fileHref);
    const label = hastText(node);
    return !label.trim() ? (
      <code {...source}>{filePath}</code>
    ) : labelNamesPath(label, filePath) ? (
      <code {...source}>{children}</code>
    ) : (
      <span {...source}>
        {children} <code>{filePath}</code>
      </span>
    );
  }

  const webHost = webUrlHost(href);
  const isFragment = href.startsWith("#");
  return (
    <a
      {...props}
      href={href}
      target={isFragment ? undefined : "_blank"}
      rel={isFragment ? undefined : "noopener noreferrer"}
      onClick={(event) => {
        if (isFragment) {
          followFragmentLink(event, href);
          return;
        }
        if (
          webHost !== null &&
          isImagePath(href) &&
          !event.defaultPrevented &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          const image = event.target instanceof HTMLImageElement ? event.target : null;
          onImageExpand(
            messageImageGallery(
              image ?? event.currentTarget,
              webImageItem(href, image?.alt.trim() || webUrlFileName(href)),
            ),
          );
        }
        // Anything else keeps the `_blank` the browser already handles.
      }}
    >
      <MarkdownLinkContext value>
        {webHost && hastText(node).trim() ? (
          <ExternalLinkContent host={webHost}>{children}</ExternalLinkContent>
        ) : (
          children
        )}
      </MarkdownLinkContext>
    </a>
  );
}

/** Sanitizing prefixes ids with `user-content-`, footnote ids twice; hrefs keep one or none. */
const fragmentKey = (id: string) => id.replace(/^(?:user-content-)+/, "");

function followFragmentLink(event: ReactMouseEvent<HTMLAnchorElement>, href: string) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  const key = fragmentKey(safeDecodeURIComponent(href.slice(1)));
  const matches = (element: HTMLElement) => fragmentKey(element.id) === key;
  const message = event.currentTarget.closest(".chat-markdown");
  const target =
    [...(message?.querySelectorAll<HTMLElement>("[id]") ?? [])].find(matches) ??
    [...document.querySelectorAll<HTMLElement>("[id]")].find(matches);
  if (!target) return;

  event.preventDefault();
  const nextUrl = new URL(window.location.href);
  nextUrl.hash = href.slice(1);
  window.history.pushState(window.history.state, "", nextUrl);
  target.scrollIntoView({ block: "nearest" });
}

/** GitHub links get its mark, drawn in `currentColor`; every other link gets the globe. */
function MarkdownLinkIcon({ host }: { host: string }) {
  const hostname = host.toLowerCase();
  const Icon =
    hostname === "github.com" || hostname.endsWith(".github.com") ? GitHubIcon : GlobeIcon;
  return (
    <span
      className="ms-[0.25em] me-[0.2em] inline-flex size-[14px] [vertical-align:-0.125em]"
      aria-hidden
    >
      <Icon className="block size-full shrink-0 select-none" />
    </span>
  );
}

/**
 * The host's icon stays glued to the label's first character (or its `https://`), so it
 * never ends a line alone; the rest of the label breaks anywhere.
 */
function ExternalLinkContent({ host, children }: { host: string; children: ReactNode }) {
  const [first, ...rest] = Children.toArray(children);
  const text = typeof first === "string" ? first : "";
  const lead = /^https?:\/\//i.exec(text)?.[0].length ?? 1;
  return (
    <>
      <span className="whitespace-nowrap">
        <MarkdownLinkIcon host={host} />
        {text ? text.slice(0, lead) : first}
      </span>
      {text ? <span className="break-all">{text.slice(lead)}</span> : null}
      {rest}
    </>
  );
}

function webImageItem(url: string, name: string | undefined): GalleryImage {
  return { src: resolveProtocolRelativeUrl(url), name: name || "image", url };
}

/**
 * The message's images in document order, for the preview's arrows, gathered only when one
 * opens. A linked image stands for what its link points at; one linking elsewhere is skipped.
 */
function messageImageGallery(clicked: Element, selected: GalleryImage): ImageGallery {
  const images: GalleryImage[] = [];
  let index = -1;
  const message = clicked.closest(".chat-markdown");
  for (const image of message?.querySelectorAll<HTMLImageElement>("img[data-gallery-image]") ??
    []) {
    const href = image.closest("a")?.getAttribute("href");
    if (href != null && !isImagePath(href)) continue;
    const item = webImageItem(href ?? image.getAttribute("src") ?? "", image.alt.trim());
    if (
      image === clicked ||
      (index < 0 && clicked.tagName !== "IMG" && item.src === selected.src)
    ) {
      index = images.length;
      images.push(selected);
    } else {
      images.push(item);
    }
  }
  return index < 0 ? { images: [selected], index: 0 } : { images, index };
}

function MarkdownImageRenderer({
  node: _node,
  src,
  alt,
  title: _title,
  width,
  height,
  className,
  style: _style,
  "data-standalone": standalone,
  "data-md": dataMd,
  ...imageProps
}: ElementProps<"img"> & { "data-standalone"?: boolean }) {
  const { onImageExpand, renderContextReference } = use(MarkdownContext);
  const insideLink = use(MarkdownLinkContext);
  const source = wholeSource(dataMd);
  const altText = alt ?? "";
  const srcText = typeof src === "string" ? src : "";

  const contextReference = parseComposerContextHref(srcText);
  if (contextReference) {
    const label = altText || contextReference.contextId;
    return (
      <span {...source}>
        {renderContextReference ? renderContextReference({ ...contextReference, label }) : label}
      </span>
    );
  }
  // Only web images load; a path names a file on the agent's runner, which nothing serves.
  if (webUrlHost(srcText) === null) return <MarkdownImageFallback alt={altText} {...source} />;
  const mediaSrc = resolveProtocolRelativeUrl(srcText);
  return (
    <MarkdownImage
      key={mediaSrc}
      src={mediaSrc}
      alt={altText}
      standalone={standalone === true}
      className={className}
      style={authoredImageSizeStyle(width, height)}
      imageProps={imageProps}
      source={source}
      url={srcText}
      onImageExpand={insideLink ? undefined : onImageExpand}
    />
  );
}

/**
 * An authored size keeps its aspect ratio inside the 30rem bound: `max-height` alone would
 * not feed back through `aspect-ratio` once `width` is definite, so the height cap is folded
 * into the width bound.
 */
function authoredImageSizeStyle(
  width: string | number | undefined,
  height: string | number | undefined,
): CSSProperties | undefined {
  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  const hasWidth = Number.isFinite(parsedWidth) && parsedWidth > 0;
  const hasHeight = Number.isFinite(parsedHeight) && parsedHeight > 0;
  if (hasWidth && hasHeight) {
    return {
      width: parsedWidth,
      height: "auto",
      aspectRatio: `${parsedWidth} / ${parsedHeight}`,
      maxWidth: `min(100%, 30rem, ${(30 * parsedWidth) / parsedHeight}rem)`,
    };
  }
  if (hasWidth) return { maxWidth: `min(100%, 30rem, ${parsedWidth}px)` };
  if (hasHeight) return { maxHeight: `min(30rem, ${parsedHeight}px)` };
  return undefined;
}

/** Inline chip for an image that sits in a line of text or can never load. */
function MarkdownImageFallback({
  alt,
  ...props
}: {
  alt: string;
  "data-md"?: string | undefined;
  "data-md-whole"?: string;
}) {
  return (
    <span
      {...props}
      className="inline-block! rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
    >
      <ImageUnavailableLabel alt={alt} />
    </span>
  );
}

/**
 * A standalone image holds a 16:9 slot (or its authored size) until it has
 * decoded, and keeps that slot if it fails, so a timeline row moves at most
 * once: when the natural size arrives. A bare `<img>` is zero height until
 * then. Once decoded the image drops the slot, so its box, hit area, and
 * alignment are exactly the image's own. Inline images (badges, icons in a
 * sentence) skip the slot: a placeholder taller than the image would move the
 * page more than the image does.
 */
function MarkdownImage({
  src,
  alt,
  standalone,
  className,
  style,
  imageProps,
  source,
  url,
  onImageExpand,
}: {
  src: string;
  alt: string;
  standalone: boolean;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  /** Sanitized authored attributes (`id`, `align`, …) that fragment links and layout rely on. */
  imageProps: Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">;
  source: ReturnType<typeof wholeSource>;
  /** The authored web URL, which the preview offers to open when the image fails there. */
  url: string;
  onImageExpand?: ((gallery: ImageGallery) => void) | undefined;
}) {
  const [status, setStatus] = useState<"loading" | "loaded" | "failed">("loading");
  // Cached images are complete before `onLoad` can fire.
  const markLoadedIfComplete = useCallback((image: HTMLImageElement | null) => {
    if (image?.complete && image.naturalWidth > 0) setStatus("loaded");
  }, []);

  if (status === "failed") {
    return standalone ? (
      <span
        {...source}
        id={imageProps.id}
        role="alert"
        className="relative inline-block! aspect-video w-full max-w-[min(100%,30rem)] overflow-hidden rounded-lg border border-border/40 bg-muted/60"
        style={style}
      >
        <span className="flex size-full items-center justify-center p-2 text-center text-xs text-muted-foreground">
          <ImageUnavailableLabel alt={alt} />
        </span>
      </span>
    ) : (
      <MarkdownImageFallback alt={alt} {...source} />
    );
  }
  const expand = (
    event: ReactMouseEvent<HTMLImageElement> | ReactKeyboardEvent<HTMLImageElement>,
  ) => {
    if (!onImageExpand) return;
    event.preventDefault();
    event.stopPropagation();
    onImageExpand(
      messageImageGallery(event.currentTarget, { src, name: alt.trim() || "image", url }),
    );
  };
  return (
    <img
      {...imageProps}
      {...source}
      ref={markLoadedIfComplete}
      src={src}
      alt={alt}
      data-gallery-image=""
      data-loading={standalone && status === "loading" ? "" : undefined}
      decoding="async"
      draggable={false}
      className={cn(
        "h-auto max-h-[30rem] w-auto max-w-[min(100%,30rem)] object-contain data-loading:aspect-video data-loading:w-full data-loading:align-baseline data-loading:rounded-lg data-loading:border data-loading:border-border/40 data-loading:bg-muted/60",
        className,
        onImageExpand && "cursor-zoom-in",
      )}
      style={style}
      {...(onImageExpand
        ? {
            role: "button" as const,
            tabIndex: 0,
            "aria-label": `Preview ${alt.trim() || "image"}`,
            onClick: expand,
            onKeyDown: (event: ReactKeyboardEvent<HTMLImageElement>) => {
              if (event.key === "Enter" || event.key === " ") expand(event);
            },
          }
        : {})}
      onLoad={() => setStatus("loaded")}
      onError={() => setStatus("failed")}
    />
  );
}

function MarkdownTable({ node: _node, children, ...props }: ElementProps<"table">) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [expanded, setExpanded] = useState(true);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1200 });
  const expandLabel = expanded ? "Collapse table cells" : "Expand table cells";
  const copyLabel = isCopied ? "Copied" : "Copy table";

  function toggleExpanded() {
    const table = tableRef.current;
    if (!table) return;

    if (!expanded) {
      const columnWidths = [...table.rows].reduce<number[]>((widths, row) => {
        [...row.cells].forEach((cell, columnIndex) => {
          widths[columnIndex] = Math.max(
            widths[columnIndex] ?? 0,
            cell.getBoundingClientRect().width,
          );
        });
        return widths;
      }, []);

      [...(table.tHead?.rows[0]?.cells ?? [])].forEach((cell, columnIndex) => {
        cell.style.minWidth = `${columnWidths[columnIndex] ?? cell.getBoundingClientRect().width}px`;
      });
    }

    setExpanded((value) => !value);
  }

  return (
    <div className="chat-markdown-table-container" data-expanded={expanded ? "true" : "false"}>
      <ScrollArea radius="none" chainVerticalScroll scrollFade className="w-full max-w-full">
        <table ref={tableRef} {...props}>
          {children}
        </table>
      </ScrollArea>
      <div data-md-ui="" className="mt-0.5 flex items-center justify-between select-none">
        <MarkdownAction label={expandLabel} pressed={expanded} onClick={toggleExpanded}>
          <MorphIcon className="size-3" icon={expanded ? Minimize2 : Maximize2} />
        </MarkdownAction>
        <Menu>
          <MenuTrigger render={<MarkdownAction label={copyLabel} />}>
            <MorphIcon className="size-3" icon={isCopied ? Check : Copy} />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              onClick={() => {
                const markdown = tableRef.current && tableToMarkdown(tableRef.current);
                if (markdown) copyToClipboard(markdown);
              }}
            >
              Copy as Markdown
            </MenuItem>
            <MenuItem
              onClick={() => {
                if (tableRef.current) copyToClipboard(tableToCsv(tableRef.current));
              }}
            >
              Copy as CSV
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
