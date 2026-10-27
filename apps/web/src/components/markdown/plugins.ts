import type { Element, Nodes as HastNodes, Root as HastRoot } from "hast";
import type { Blockquote, Nodes, Root, RootContent } from "mdast";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { Parser, PluggableList, Plugin } from "unified";

/**
 * The parse and transform steps behind every rendered message. Plugin order matters:
 * remark-breaks must follow the alert plugin, which reads the newline after the marker.
 */
export function remarkPlugins(lineBreaks: boolean): PluggableList {
  return [
    // A single tilde is not strikethrough, so `HEAD~1 … HEAD~2` stays plain text.
    [remarkGfm, { singleTilde: false }],
    remarkNoIndentedCode,
    remarkGithubAlerts,
    remarkCodeMeta,
    ...(lineBreaks ? [remarkBreaks] : []),
  ];
}

/** User messages show raw HTML as text; everything else parses it and then sanitizes. */
export function rehypePlugins(parseRawHtml: boolean): PluggableList {
  const parsing: PluggableList = parseRawHtml
    ? [rehypeRawWhenPresent, [rehypeSanitize, SANITIZE_SCHEMA]]
    : [];
  return [...parsing, rehypeStandaloneImages, rehypeSourceRanges];
}

function visitMarkdown(node: Nodes, visit: (node: Nodes) => void) {
  visit(node);
  if ("children" in node) for (const child of node.children) visitMarkdown(child, visit);
}

function visitElements(node: HastNodes, visit: (element: Element) => void) {
  if (node.type === "element") visit(node);
  if ("children" in node) for (const child of node.children) visitElements(child, visit);
}

/** The words under a node, through any nesting. */
export function hastText(node: HastNodes | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  return "children" in node ? node.children.map(hastText).join("") : "";
}

/**
 * Chat output pads list markers to align text (`-       text`), which CommonMark reads as an
 * indented code block: a code card per bullet. Agents fence real code, so indented code is off
 * and such a bullet renders as `- text`. Fenced code is unaffected.
 */
const remarkNoIndentedCode: Plugin<[], Root> = function () {
  (this.data().micromarkExtensions ??= []).push({ disable: { null: ["codeIndented"] } });
};

const GITHUB_ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i;

/**
 * GitHub's blockquote alerts: a quote whose first line is `[!NOTE]` — or TIP, IMPORTANT,
 * WARNING, CAUTION — renders as a titled callout. They are GitHub's own extension rather than
 * GFM, so remark-gfm leaves the marker as literal text in the quote. This lifts the marker into
 * a `data-alert` attribute for the blockquote renderer and removes the marker line.
 *
 * Only a marker with nothing after it on its own line counts, which is GitHub's rule:
 * `> [!NOTE] aside` is an ordinary quote.
 */
function remarkGithubAlerts() {
  return (tree: Root) => {
    visitMarkdown(tree, (node) => {
      if (node.type === "blockquote") readGithubAlert(node);
    });
  };
}

function readGithubAlert(quote: Blockquote) {
  const paragraph = quote.children[0];
  if (paragraph?.type !== "paragraph") return;
  const text = paragraph.children[0];
  if (text?.type !== "text") return;
  const match = GITHUB_ALERT_MARKER.exec(text.value);
  if (!match?.[1]) return;

  const remainder = text.value.slice(match[0].length);
  // Whether the marker's own line ended inside this text node. Without it, an empty remainder
  // is ambiguous: `[!NOTE]\n**bold**` parses as [text "[!NOTE]\n", strong] — next-line content
  // in a sibling — while `[!NOTE]*aside*` parses the same way minus the newline.
  const markerEndsItsLine = match[0].endsWith("\n");
  if (remainder.length > 0) {
    // The quote continues on the next line inside the same text node: keep the paragraph,
    // shed the marker line.
    text.value = remainder;
  } else if (markerEndsItsLine || paragraph.children.length === 1) {
    // The marker was the whole text node — a marker-only paragraph, or a marker line whose
    // next line starts as a sibling inline. Drop the node, and the paragraph if it empties.
    paragraph.children.shift();
    if (paragraph.children.length === 0) quote.children.shift();
  } else {
    // Something else shares the marker's line — `[!NOTE]*aside*` — which GitHub does not
    // read as an alert.
    return;
  }

  const data = (quote.data ??= {});
  data.hProperties = { ...data.hProperties, dataAlert: match[1].toLowerCase() };
}

/** Carries a fence's meta (```ts title="x.ts") to the code block, which shows it as a title. */
function remarkCodeMeta() {
  return (tree: Root) => {
    visitMarkdown(tree, (node) => {
      const meta = node.type === "code" ? node.meta?.trim() : undefined;
      if (!meta) return;
      const data = (node.data ??= {});
      data.hProperties = { ...data.hProperties, dataCodeMeta: meta };
    });
  };
}

function hasRawHtml(node: HastNodes): boolean {
  return node.type === "raw" || ("children" in node && node.children.some(hasRawHtml));
}

/**
 * rehype-raw re-parses the whole tree through parse5, on every streamed token. Most messages
 * hold no HTML, and they skip it.
 */
function rehypeRawWhenPresent() {
  const parseRawHtml = rehypeRaw();
  return (tree: HastRoot, file: Parameters<typeof parseRawHtml>[1]) =>
    hasRawHtml(tree) ? parseRawHtml(tree, file) : tree;
}

const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    code: [...(defaultSchema.attributes?.code ?? []), "dataCodeMeta"],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), "dataAlert"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file", "t45-context"],
    src: [...(defaultSchema.protocols?.src ?? []), "t45-context"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

/** Containers whose sole child image reads as a figure rather than part of a sentence. */
const STANDALONE_IMAGE_BLOCKS = new Set([
  "p",
  "div",
  "li",
  "td",
  "th",
  "figure",
  "center",
  "blockquote",
]);

function soleImage(parent: HastRoot | Element): Element | undefined {
  const children = parent.children.filter(
    (child) => !(child.type === "text" && child.value.trim() === ""),
  );
  const only = children.length === 1 ? children[0] : undefined;
  if (only?.type !== "element") return undefined;
  if (only.tagName === "img") return only;
  // A link, emphasis, or similar inline wrapper around the image still counts as long as
  // nothing else shares the block.
  return only.tagName === "a" || only.tagName === "strong" || only.tagName === "em"
    ? soleImage(only)
    : undefined;
}

/**
 * An image that is the only content of its block (optionally wrapped in a link) is almost
 * always a screenshot or figure, so it gets a reserved slot while it loads. Images mixed with
 * text or other images — badge rows, icons in a sentence — stay inline at their natural size,
 * since a placeholder taller than the image would move the page more than the image does.
 */
function rehypeStandaloneImages() {
  return (tree: HastRoot) => {
    const mark = (image: Element | undefined) => {
      if (image) image.properties.dataStandalone = true;
    };
    // A raw `<img>` on its own line reaches the root without a paragraph.
    mark(soleImage(tree));
    visitElements(tree, (element) => {
      if (STANDALONE_IMAGE_BLOCKS.has(element.tagName)) mark(soleImage(element));
    });
  };
}

/**
 * Stamps each element with where it came from in the message, `start end [contentStart]` as
 * source offsets, so copying a selection can hand back the original text (see copy.ts).
 * `contentStart` is where the element's first child begins, past markup such as `## ` or `**`;
 * it is left out when the two coincide or the first child has no position.
 */
function rehypeSourceRanges() {
  const stamp = (node: HastNodes) => {
    if (node.type === "element") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const content = node.children[0]?.position?.start.offset;
      if (start !== undefined && end !== undefined) {
        node.properties.dataMd =
          content === undefined || content === start
            ? `${start} ${end}`
            : `${start} ${end} ${content}`;
      }
      // A code block copies as a whole or as plain code, never by its inner elements.
      if (node.tagName === "pre") return;
    }
    if ("children" in node) for (const child of node.children) stamp(child);
  };
  return stamp;
}

interface ParsedPrefix {
  source: string;
  offset: number;
  line: number;
  children: RootContent[];
}

function hasDefinitions(node: Root | RootContent): boolean {
  return (
    node.type === "definition" ||
    node.type === "footnoteDefinition" ||
    ("children" in node && node.children.some((child) => hasDefinitions(child)))
  );
}

function shiftPositions(node: Root | RootContent, offset: number, lines: number): void {
  if (node.position) {
    for (const point of [node.position.start, node.position.end]) {
      if (point.offset !== undefined) point.offset += offset;
      point.line += lines;
    }
  }
  if ("children" in node) {
    for (const child of node.children) shiftPositions(child, offset, lines);
  }
}

/**
 * Where parsing can restart after a finished top-level block: past a closed fence and the
 * blank line after it, or past a whole ATX heading line. Nothing later in the document can
 * change how either parsed.
 */
function restartOffset(node: RootContent, source: string): number | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return undefined;
  const value = source.slice(start, end);
  if (node.type === "heading") {
    return /^ {0,3}#/.test(value) && source[end] === "\n" ? end + 1 : undefined;
  }
  if (node.type !== "code") return undefined;
  const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(value)?.[1];
  if (!opening) return undefined;
  const lastLine = value.slice(value.lastIndexOf("\n") + 1);
  const closing = new RegExp(`^ {0,3}${opening[0]}{${opening.length},}[ \\t]*$`);
  const separator = /^\n[ \t]*\n/.exec(source.slice(end))?.[0];
  return closing.test(lastLine) && separator ? end + separator.length : undefined;
}

/**
 * Keeps the full document pipeline while a reply streams, without parsing its finished prefix
 * again on every token: the tree up to the last restart point is cached and only the rest is
 * parsed. Definitions are document-wide, so they require a full parse.
 */
function createIncrementalParser(parse: Parser<Root>): Parser<Root> {
  let cached: ParsedPrefix | undefined;

  return (source, file) => {
    // A streaming CR can become half of a CRLF. A BOM at the suffix boundary
    // would be stripped by a new parser although it is inside the full document.
    if (source.includes("\r") || source.includes("﻿")) return parse(source, file);

    const prefix = cached && source.startsWith(cached.source) ? cached : undefined;
    let root: Root;
    if (prefix) {
      root = parse(source.slice(prefix.offset), file);
      if (hasDefinitions(root)) return parse(source, file);
      shiftPositions(root, prefix.offset, prefix.line - 1);
      if (root.position) root.position.start = { line: 1, column: 1, offset: 0 };
      // Remark transforms mutate their input. The cache owns pristine nodes and
      // each render receives its own copy, including source positions.
      root.children.unshift(...structuredClone(prefix.children));
    } else {
      root = parse(source, file);
      if (hasDefinitions(root)) return root;
    }

    for (let index = root.children.length - 1; index >= 0; index--) {
      const node = root.children[index];
      const end = node?.position?.end;
      if (!node || !end || end.offset === undefined) continue;
      if (prefix && end.offset < prefix.offset) break;
      const offset = restartOffset(node, source);
      if (offset === undefined) continue;
      cached = {
        source: source.slice(0, offset),
        offset,
        line: end.line + source.slice(end.offset, offset).split("\n").length - 1,
        children: structuredClone(root.children.slice(0, index + 1)),
      };
      break;
    }
    return root;
  };
}

/** One cache per streaming message; add it last, after the other remark plugins. */
export function createIncrementalMarkdownPlugin(): Plugin<[], Root> {
  let parser: Parser<Root> | undefined;
  return function () {
    const original = this.parser;
    if (!original) return;
    parser ??= createIncrementalParser((source, file) => original(source, file) as Root);
    this.parser = parser;
  };
}
