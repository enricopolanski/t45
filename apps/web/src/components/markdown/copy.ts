import { replaceComposerContextReferences } from "@t45/core/composerContextReferences";
import type { ClipboardEvent } from "react";

/**
 * Copying a selection out of rendered markdown puts the selected part of the original message
 * on the clipboard, never text rebuilt from the rendered HTML. The parse pipeline stamps each
 * element with its source range (`data-md`, see plugins.ts); the selection's two ends are
 * mapped to source offsets and the text between them is copied as written.
 */

const sources = new WeakMap<Element, string>();

/** Remembers the text a rendered message came from, keyed by its `.chat-markdown` root. */
export function setMarkdownSource(root: Element, text: string) {
  sources.set(root, text);
}

export function copySelectionAsMarkdown(event: ClipboardEvent<HTMLElement>) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !event.clipboardData) return;
  const slices: string[] = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    for (const root of markdownRoots(range)) {
      const slice = selectedSource(root, range);
      if (slice) slices.push(slice);
    }
  }
  if (slices.length === 0) return;
  event.preventDefault();
  // Context never travels through the clipboard: a context reference copies as its label.
  const text = replaceComposerContextReferences(
    slices.join("\n\n"),
    (reference) => reference.label,
  );
  event.clipboardData.setData("text/plain", text);
}

/** A table as the message wrote it. */
export function tableToMarkdown(table: HTMLTableElement): string | null {
  const source = sources.get(table.closest(".chat-markdown") ?? table);
  const range = sourceRange(table);
  return source !== undefined && range ? source.slice(range.start, range.end) : null;
}

export function tableToCsv(table: HTMLTableElement): string {
  return [...table.rows]
    .map((row) => [...row.cells].map((cell) => csvCell(cell.textContent ?? "")).join(","))
    .join("\n");
}

function csvCell(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return /[",\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
}

/** Every message the range touches, so a drag across two parts of one reply copies both. */
function markdownRoots(range: Range): Element[] {
  const ancestor = elementOf(range.commonAncestorContainer);
  const enclosing = ancestor?.closest(".chat-markdown");
  if (enclosing) return [enclosing];
  return [...(ancestor?.querySelectorAll(".chat-markdown") ?? [])].filter((root) =>
    range.intersectsNode(root),
  );
}

interface SourceRange {
  start: number;
  end: number;
  /** Where the element's first child begins, past markup such as `## ` or `**`. */
  content: number;
}

function sourceRange(element: Element): SourceRange | null {
  const [start = Number.NaN, end = Number.NaN, content = start] = (
    element.getAttribute("data-md") ?? ""
  )
    .split(" ")
    .map(Number);
  return Number.isNaN(start) || Number.isNaN(end) ? null : { start, end, content };
}

/** Inline markup that would be left unbalanced by a selection ending inside it. */
const MARKUP_TAGS = new Set(["A", "B", "CODE", "DEL", "EM", "I", "S", "STRONG", "SUP"]);

/** UI around the content (code-block headers, link icons, alert titles) that the source lacks. */
const HIDDEN = '[aria-hidden="true"], [data-md-ui]';

function selectedSource(root: Element, range: Range): string | null {
  const source = sources.get(root);
  if (source === undefined) return null;
  const selected = range.cloneRange();
  if (!root.contains(range.startContainer)) selected.setStart(root, 0);
  if (!root.contains(range.endContainer)) selected.setEnd(root, root.childNodes.length);

  // A drag that starts in a code block and adds nothing visible after it copies the code
  // itself, without fences, even when it ends past the block's last line.
  const pre = elementOf(selected.startContainer)?.closest("pre");
  if (pre && root.contains(pre)) {
    const after = selected.cloneRange();
    after.setStartAfter(pre);
    if (visibleText(after).trim() === "") {
      if (!pre.contains(selected.endContainer)) selected.setEndAfter(pre);
      return selected.toString().replace(/\n$/, "");
    }
  }

  const start = widen(root, selected, "start", sourceOffset(root, source, selected, "start"));
  const end = widen(root, selected, "end", sourceOffset(root, source, selected, "end"));
  return start < end
    ? source
        .slice(start, end)
        .replace(/^(?:[ \t]*\n)+/, "")
        .replace(/(?:\n[ \t]*)+$/, "")
    : null;
}

/**
 * The source offset of one end of the selection. The closest element with a source range
 * owns the point; the visible text between the last ranged element before the point (or the
 * owner's content start) and the point is matched against the source from there, skipping
 * the markup the rendering dropped.
 */
function sourceOffset(root: Element, source: string, selected: Range, side: "start" | "end") {
  const [container, offset] =
    side === "start"
      ? [selected.startContainer, selected.startOffset]
      : [selected.endContainer, selected.endOffset];
  const owner = closestRanged(root, container);
  const ownerRange = owner ? sourceRange(owner) : { start: 0, end: source.length, content: 0 };
  if (!ownerRange) return side === "start" ? 0 : source.length;
  if (owner?.hasAttribute("data-md-whole")) {
    return side === "start" ? ownerRange.start : ownerRange.end;
  }

  const before = document.createRange();
  before.selectNodeContents(owner ?? root);
  before.setEnd(container, offset);
  let base = ownerRange.content;
  for (const element of (owner ?? root).querySelectorAll("[data-md]")) {
    if (closestRanged(root, element.parentElement) !== owner) continue;
    const span = document.createRange();
    span.selectNode(element);
    if (before.compareBoundaryPoints(Range.END_TO_END, span) < 0) break;
    const range = sourceRange(element);
    if (!range) continue;
    base = range.end;
    before.setStartAfter(element);
  }

  let index = base;
  for (const character of visibleText(before)) {
    const found = source.indexOf(character, index);
    if (found !== -1 && found < ownerRange.end) index = found + 1;
  }
  // A start inside text begins at its first selected character, past anything the rendering
  // dropped before it, such as an alert's `[!NOTE]` line.
  if (
    side === "start" &&
    container.nodeType === Node.TEXT_NODE &&
    !isHidden(container, owner ?? root)
  ) {
    const next = (container.nodeValue ?? "").charAt(offset);
    const found = next ? source.indexOf(next, index) : -1;
    if (found !== -1 && found < ownerRange.end) index = found;
  }
  return index;
}

/**
 * Widens one end of the selection to the whole of an element it cuts into: always for inline
 * markup and atomic renderings (chips, images, code blocks), and for blocks when nothing of
 * the block is left out, so a selection from a bullet's first word keeps its `- ` marker.
 */
function widen(root: Element, selected: Range, side: "start" | "end", offset: number) {
  const [container, other] =
    side === "start"
      ? [selected.startContainer, selected.endContainer]
      : [selected.endContainer, selected.startContainer];
  let widened = offset;
  for (let element = elementOf(container); element && element !== root;) {
    if (element.contains(other)) break;
    const range = sourceRange(element);
    if (range) {
      const outside = document.createRange();
      outside.selectNodeContents(element);
      if (side === "start") outside.setEnd(selected.startContainer, selected.startOffset);
      else outside.setStart(selected.endContainer, selected.endOffset);
      if (
        MARKUP_TAGS.has(element.tagName) ||
        element.hasAttribute("data-md-whole") ||
        visibleText(outside).trim() === ""
      ) {
        widened = side === "start" ? Math.min(widened, range.start) : Math.max(widened, range.end);
      }
    }
    element = element.parentElement;
  }
  return widened;
}

function closestRanged(root: Element, node: Node | null): Element | null {
  const ranged = elementOf(node)?.closest("[data-md]");
  return ranged && root.contains(ranged) ? ranged : null;
}

function elementOf(node: Node | null): Element | null {
  return node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node?.parentElement ?? null);
}

/** Whether UI hides the node from the source, inside `within` (outside it, nothing is visible). */
function isHidden(node: Node, within: Node): boolean {
  const hidden = node.parentElement?.closest(HIDDEN);
  return hidden != null && hidden !== within && within.contains(hidden);
}

function visibleText(range: Range): string {
  const container = range.commonAncestorContainer;
  if (container.nodeType === Node.TEXT_NODE) return range.toString();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node) || isHidden(node, container)) continue;
    const value = node.nodeValue ?? "";
    text += value.slice(
      node === range.startContainer ? range.startOffset : 0,
      node === range.endContainer ? range.endOffset : value.length,
    );
  }
  return text;
}
