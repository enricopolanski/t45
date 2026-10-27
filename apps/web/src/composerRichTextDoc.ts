import { wrappingInputRule } from "@tiptap/core";
import { Mark, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { closeHistory, isHistoryTransaction } from "@tiptap/pm/history";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { Code } from "@tiptap/extension-code";
import { TaskItem } from "@tiptap/extension-task-item";

import { parseInlineTokens } from "~/inlineTokens";
import { collectInlineContextIds } from "~/lib/composerContextReferences";

/**
 * Pure document and transaction model for the rich text (Tiptap) composer.
 *
 * The stored prompt stays markdown (`**bold**`, `@file` chips as canonical
 * links). The Tiptap document holds styled text plus inline atom chips, so
 * this module translates both ways, maps cursor offsets between the three
 * coordinate spaces the composer speaks, and groups undo history steps:
 *
 * - flat document offsets (styled markers excluded, chips count 1),
 * - collapsed cursor offsets (markers literal, chips count 1 — the coordinate
 *   the draft store and trigger detection use),
 * - markdown offsets (markers literal, chips expand to their source).
 *
 * DOM-free on purpose: unit tests build a real ProseMirror document from the
 * JSON this produces and assert the round trip without a browser.
 */

export type RichTextMark = "bold" | "italic" | "strike" | "code";

interface RichTextSpan {
  text: string;
  marks: RichTextMark[];
}

const RICH_TEXT_DELIMITERS: Record<RichTextMark, string> = {
  bold: "**",
  italic: "*",
  strike: "~~",
  code: "`",
};

/** Outermost mark first, so closers mirror openers when nested. */
const MARK_NESTING_ORDER: RichTextMark[] = ["strike", "bold", "italic", "code"];

function isRichTextMark(name: string): name is RichTextMark {
  return name in RICH_TEXT_DELIMITERS;
}

function pushSpan(spans: RichTextSpan[], text: string, marks: RichTextMark[]): void {
  if (!text) return;
  const last = spans[spans.length - 1];
  if (
    last &&
    last.marks.length === marks.length &&
    last.marks.every((mark, index) => mark === marks[index])
  ) {
    last.text += text;
  } else {
    spans.push({ text, marks });
  }
}

/** Parse the supported inline styles, leaving unmatched and escaped markers literal. */
export function parseInlineMarkdown(text: string): RichTextSpan[] {
  const root: RichTextSpan[] = [];
  const stack: { delimiter: string; mark: RichTextMark; spans: RichTextSpan[] }[] = [];
  const current = () => stack.at(-1)?.spans ?? root;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\") {
      pushSpan(current(), text.slice(index, index + 2), []);
      index += 2;
      continue;
    }
    if (char === "`") {
      // Multi-backtick code stays literal; a single-backtick span owns its contents.
      const run = text.slice(index).match(/^`+/)![0];
      const close = text.indexOf(run, index + run.length);
      if (
        run.length === 1 &&
        close > index + 1 &&
        !text.slice(index, close).includes("\n") &&
        text[close + 1] !== "`"
      ) {
        pushSpan(current(), text.slice(index + 1, close), ["code"]);
        index = close + 1;
      } else {
        pushSpan(current(), run, []);
        index += run.length;
      }
      continue;
    }
    if (char !== "*" && char !== "_" && char !== "~") {
      pushSpan(current(), char, []);
      index += 1;
      continue;
    }
    let end = index;
    while (text[end] === char) end += 1;
    const before = text[index - 1] ?? "";
    const after = text[end] ?? "";
    const canClose = before !== "" && !/\s/.test(before) && (char !== "_" || !/\w/.test(after));
    const canOpen = after !== "" && !/\s/.test(after) && (char !== "_" || !/\w/.test(before));
    while (index < end) {
      const top = stack.at(-1);
      // Inside italic, a double marker opens bold before closing the single
      // marker. Once bold is active, closing runs unwind both styles.
      const opensNestedBold =
        top?.mark === "italic" &&
        end - index === 2 &&
        canOpen &&
        (char === "*" || char === "_") &&
        !stack.some((frame) => frame.mark === "bold");
      if (
        !opensNestedBold &&
        canClose &&
        top &&
        text.startsWith(top.delimiter, index) &&
        index + top.delimiter.length <= end
      ) {
        stack.pop();
        for (const span of top.spans) pushSpan(current(), span.text, [top.mark, ...span.marks]);
        index += top.delimiter.length;
      } else if (canOpen && (char !== "~" || end - index >= 2)) {
        const length = char === "~" || end - index >= 2 ? 2 : 1;
        const mark = char === "~" ? "strike" : length === 2 ? "bold" : "italic";
        // A mark cannot nest inside itself, including alternate delimiters.
        // This bounds the stack to the supported styles for arbitrary input.
        if (stack.some((frame) => frame.mark === mark)) {
          pushSpan(current(), text.slice(index, end), []);
          index = end;
          continue;
        }
        stack.push({
          delimiter: char.repeat(length),
          mark,
          spans: [],
        });
        index += length;
      } else {
        pushSpan(current(), text.slice(index, end), []);
        index = end;
      }
    }
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    pushSpan(current(), frame.delimiter, []);
    for (const span of frame.spans) pushSpan(current(), span.text, span.marks);
  }
  return root;
}

/**
 * Tiptap's code mark excludes every other mark, which rejects the `bold+code`
 * spans markdown like `**\`x\`**` parses into and drops the whole insert.
 * Code nests inside emphasis here, so it only excludes itself like the rest.
 */
export const ComposerCodeExtension = Code.extend({
  excludes: "code",
  // ArrowRight leaves code through the caret stops at styled edges, so the
  // stock exit (inserting a space at the end of a line) is not needed.
  exitable: false,
});

/**
 * Task list items keep their exact source indent in an attribute so nesting
 * round-trips byte-identically. Checkbox case (`[X]`) normalizes to `[x]` —
 * the same fixed-point deal as `__bold__` becoming `**bold**`.
 */
export const ComposerTaskItemExtension = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      indent: { default: "" },
      markerSpace: { default: " " },
      contentSpace: { default: null },
    };
  },
  addInputRules() {
    return [
      wrappingInputRule({
        find: /^- \[([ xX])\] $/,
        type: this.type,
        getAttributes: (match) => ({ checked: match[1]?.toLowerCase() === "x" }),
      }),
    ];
  },
}).configure({ nested: true });

interface TaskLinePrefix {
  indent: string;
  checked: boolean;
  markerSpace: string;
  contentSpace: string;
}

function parseTaskPrefix(head: string): { prefix: TaskLinePrefix; markerLength: number } | null {
  const match = head.match(/^([ \t]*)-([ \t]+)\[([ xX])\]([ \t]*)/);
  if (!match) return null;
  const after = head.slice(match[0].length);
  if (after.length > 0 && !match[4]) return null;
  return {
    prefix: {
      indent: match[1] ?? "",
      checked: (match[3] ?? " ").toLowerCase() === "x",
      markerSpace: match[2]!,
      contentSpace: match[4]!,
    },
    markerLength: match[0].length,
  };
}

type InlineJson = Record<string, unknown>;

interface DocLine {
  task: TaskLinePrefix | null;
  inline: InlineJson[];
}

function atomJsonForSegment(
  segment: Exclude<ReturnType<typeof parseInlineTokens>[number], { type: "text" }>,
): InlineJson {
  return {
    type: "composer-context-reference",
    attrs: {
      contextId: segment.contextId,
      label: segment.label,
      source: segment.source,
    },
  };
}

interface PendingTaskItem extends TaskLinePrefix {
  content: InlineJson[];
  children: PendingTaskItem[];
}

function taskListJson(items: PendingTaskItem[]): InlineJson {
  return {
    type: "taskList",
    content: items.map((item) => ({
      type: "taskItem",
      attrs: {
        checked: item.checked,
        indent: item.indent,
        markerSpace: item.markerSpace,
        contentSpace: item.contentSpace,
      },
      content: [
        { type: "paragraph", content: item.content },
        ...(item.children.length > 0 ? [taskListJson(item.children)] : []),
      ],
    })),
  };
}

function textJsonForSpan(text: string, marks: RichTextMark[]): Record<string, unknown> {
  const json: Record<string, unknown> = { type: "text", text };
  if (marks.length > 0) {
    json.marks = [...marks]
      .sort((a, b) => MARK_NESTING_ORDER.indexOf(a) - MARK_NESTING_ORDER.indexOf(b))
      .map((type) => ({ type }));
  }
  return json;
}

export function buildTiptapContent(value: string): Record<string, unknown>[] {
  // Hide token source from the markdown parser, then restore the atoms with
  // the marks of their surrounding text. Choose a sentinel absent from input.
  let sentinel = "\uFFFC";
  for (let codePoint = 0xe000; value.includes(sentinel); codePoint += 1) {
    sentinel = String.fromCodePoint(codePoint);
  }
  const atoms: InlineJson[] = [];
  const text = parseInlineTokens(value)
    .map((segment) => {
      if (segment.type === "text") return segment.text;
      atoms.push(atomJsonForSegment(segment));
      return sentinel;
    })
    .join("");
  let atomIndex = 0;
  const lines: DocLine[] = text.split("\n").map((line) => {
    const parsed = parseTaskPrefix(line);
    const content = parsed ? line.slice(parsed.markerLength) : line;
    const spans = parseInlineMarkdown(content);
    const inline: InlineJson[] = [];
    for (const span of spans) {
      span.text.split(sentinel).forEach((piece, index) => {
        if (index > 0) {
          const atom = atoms[atomIndex++]!;
          inline.push({ ...atom, marks: textJsonForSpan("", span.marks).marks });
        }
        if (piece) inline.push(textJsonForSpan(piece, span.marks));
      });
    }
    return { task: parsed?.prefix ?? null, inline };
  });

  // Pass 2: consecutive task lines group into (possibly nested) task lists
  // by indent prefix; everything else stays a paragraph.
  const blocks: Record<string, unknown>[] = [];
  let stack: { indent: string; items: PendingTaskItem[] }[] = [];
  const flushTasks = () => {
    if (stack.length > 0) {
      blocks.push(taskListJson(stack[0]!.items));
      stack = [];
    }
  };
  for (const line of lines) {
    if (!line.task) {
      flushTasks();
      blocks.push({ type: "paragraph", content: line.inline });
      continue;
    }
    const item: PendingTaskItem = {
      ...line.task,
      content: line.inline,
      children: [],
    };
    for (;;) {
      const top = stack[stack.length - 1];
      if (!top) {
        // A leading indented item with no parent flattens but keeps indent.
        stack.push({ indent: item.indent, items: [] });
        continue;
      }
      if (top.indent === item.indent) {
        top.items.push(item);
        break;
      }
      if (top.indent !== "" && !item.indent.startsWith(top.indent)) {
        if (stack.length > 1) {
          stack.pop();
          continue;
        }
        top.indent = item.indent;
        top.items.push(item);
        break;
      }
      const parent = top.items[top.items.length - 1];
      if (!parent) {
        top.items.push(item);
        break;
      }
      parent.children.push(item);
      stack.push({ indent: item.indent, items: parent.children });
      break;
    }
  }
  flushTasks();
  return blocks;
}

export function buildDocJson(value: string) {
  return { type: "doc", content: buildTiptapContent(value) };
}

export interface RichRun {
  kind: "text" | "token" | "break" | "prefix";
  /** Flat document offset (atoms count 1, markers excluded). */
  flatStart: number;
  docLen: number;
  /** Collapsed cursor length (markers literal, tokens count 1). */
  collapsedLen: number;
  /** Markdown length (tokens expand to their source). */
  mdLen: number;
  /** Marker layout inside text runs. */
  openLen: number;
  closeLen: number;
  /** ProseMirror position of the run start. */
  pmPos: number;
  mdStart: number;
  collapsedStart: number;
}

export interface RichDocMap {
  value: string;
  runs: RichRun[];
  docLength: number;
  contextIds: string[];
}

interface RichAccumulator {
  runs: RichRun[];
  value: string;
  flat: number;
  collapsed: number;
  md: number;
}

function pushBreakRun(acc: RichAccumulator, position?: number): void {
  const previous = acc.runs[acc.runs.length - 1];
  const pmPos = position ?? (previous ? previous.pmPos + previous.docLen : 1);
  // Block boundary: one newline in every coordinate space.
  acc.runs.push({
    kind: "break",
    flatStart: acc.flat,
    docLen: 1,
    collapsedLen: 1,
    mdLen: 1,
    openLen: 0,
    closeLen: 0,
    pmPos,
    mdStart: acc.md,
    collapsedStart: acc.collapsed,
  });
  acc.value += "\n";
  acc.flat += 1;
  acc.collapsed += 1;
  acc.md += 1;
}

function appendInlineRuns(
  container: ProseMirrorNode,
  contentStart: number,
  acc: RichAccumulator,
): void {
  const children: ProseMirrorNode[] = [];
  container.forEach((child) => {
    if (!child.isText || child.marks.some((mark) => mark.type.name === "code")) {
      children.push(child);
      return;
    }
    // Separate boundary whitespace so delimiters can move past it without
    // changing the document offsets or marks on the visible text.
    const text = child.text!;
    const start = text.length - text.trimStart().length;
    const end = Math.max(start, text.trimEnd().length);
    let offset = 0;
    for (const boundary of [start, end, text.length]) {
      if (boundary > offset) children.push(child.cut(offset, boundary));
      offset = boundary;
    }
  });
  // Emphasis cannot open or close next to whitespace. Retain a whitespace
  // mark only when its range has visible content on both sides.
  for (const mark of MARK_NESTING_ORDER) {
    if (mark === "code") continue;
    for (const direction of [1, -1]) {
      let hasContent = false;
      for (
        let index = direction === 1 ? 0 : children.length - 1;
        index >= 0 && index < children.length;
        index += direction
      ) {
        const child = children[index]!;
        if (
          child.type.name === "hardBreak" ||
          !child.marks.some((item) => item.type.name === mark)
        ) {
          hasContent = false;
        } else if (
          child.isText &&
          !child.marks.some((item) => item.type.name === "code") &&
          /^\s+$/.test(child.text!)
        ) {
          if (!hasContent)
            children[index] = child.mark(child.marks.filter((item) => item.type.name !== mark));
        } else {
          hasContent = true;
        }
      }
    }
  }
  // Longer shared marks surround shorter ones. This keeps both nested
  // formatting and formatting across chips inside a single delimiter pair.
  const markEnds = new Map<RichTextMark, number>();
  const orderedMarks: RichTextMark[][] = [];
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]!;
    const marks =
      child.type.name === "hardBreak"
        ? []
        : child.marks.map((mark) => mark.type.name).filter(isRichTextMark);
    for (const mark of MARK_NESTING_ORDER) {
      if (!marks.includes(mark)) markEnds.delete(mark);
      else if (!markEnds.has(mark)) markEnds.set(mark, index);
    }
    orderedMarks[index] = marks.sort(
      (a, b) =>
        markEnds.get(b)! - markEnds.get(a)! ||
        MARK_NESTING_ORDER.indexOf(a) - MARK_NESTING_ORDER.indexOf(b),
    );
  }
  for (let index = 1; index < orderedMarks.length; index += 1) {
    const marks = orderedMarks[index]!;
    const retained: RichTextMark[] = [];
    for (const mark of orderedMarks[index - 1]!) {
      if (!marks.includes(mark)) break;
      retained.push(mark);
    }
    orderedMarks[index] = [...retained, ...marks.filter((mark) => !retained.includes(mark))];
  }
  const commonLength = (left: RichTextMark[], right: RichTextMark[]) => {
    let index = 0;
    while (index < left.length && left[index] === right[index]) index += 1;
    return index;
  };
  let inlineOffset = 0;
  children.forEach((child, index) => {
    const pmPos = contentStart + inlineOffset;
    inlineOffset += child.nodeSize;
    if (child.type.name === "hardBreak") {
      pushBreakRun(acc, pmPos);
      return;
    }
    const marks = orderedMarks[index]!;
    const open = marks
      .slice(commonLength(marks, orderedMarks[index - 1] ?? []))
      .map((mark) => RICH_TEXT_DELIMITERS[mark])
      .join("");
    const close = marks
      .slice(commonLength(marks, orderedMarks[index + 1] ?? []))
      .toReversed()
      .map((mark) => RICH_TEXT_DELIMITERS[mark])
      .join("");
    const atomSource: unknown = child.attrs.source;
    const source = child.isText ? child.text! : typeof atomSource === "string" ? atomSource : "";
    const docLen = child.isText ? source.length : 1;
    const mdText = open + source + close;
    const collapsedLen = open.length + docLen + close.length;
    acc.runs.push({
      kind: child.isText ? "text" : "token",
      flatStart: acc.flat,
      docLen,
      collapsedLen,
      mdLen: mdText.length,
      openLen: open.length,
      closeLen: close.length,
      pmPos,
      mdStart: acc.md,
      collapsedStart: acc.collapsed,
    });
    acc.value += mdText;
    acc.flat += docLen;
    acc.collapsed += collapsedLen;
    acc.md += mdText.length;
  });
  // Empty paragraphs have an editable position even though they emit no text.
  if (children.length === 0) {
    acc.runs.push({
      kind: "text",
      flatStart: acc.flat,
      docLen: 0,
      collapsedLen: 0,
      mdLen: 0,
      openLen: 0,
      closeLen: 0,
      pmPos: contentStart,
      mdStart: acc.md,
      collapsedStart: acc.collapsed,
    });
  }
}

function walkTaskList(list: ProseMirrorNode, listStart: number, acc: RichAccumulator): void {
  let itemPos = listStart + 1;
  let firstItem = true;
  list.content.forEach((item) => {
    // Sibling items are separated by one newline in every coordinate space.
    if (!firstItem) pushBreakRun(acc);
    firstItem = false;
    const itemContentStart = itemPos + 1;
    const first = item.firstChild;
    const empty = first?.type.name === "paragraph" && first.content.childCount === 0;
    const attrs = item.attrs as Record<string, unknown>;
    const indent = typeof attrs.indent === "string" ? attrs.indent : "";
    const markerSpace = typeof attrs.markerSpace === "string" ? attrs.markerSpace : " ";
    const contentSpace =
      (typeof attrs.contentSpace === "string" && attrs.contentSpace) || (empty ? "" : " ");
    const prefix = `${indent}-${markerSpace}[${attrs.checked === true ? "x" : " "}]${contentSpace}`;
    // The checkbox owns no document characters; every prefix offset clamps
    // to the start of the item text, exactly like style markers.
    acc.runs.push({
      kind: "prefix",
      flatStart: acc.flat,
      docLen: 0,
      collapsedLen: prefix.length,
      mdLen: prefix.length,
      openLen: 0,
      closeLen: 0,
      pmPos: itemContentStart + 1,
      mdStart: acc.md,
      collapsedStart: acc.collapsed,
    });
    acc.value += prefix;
    acc.collapsed += prefix.length;
    acc.md += prefix.length;
    let childPos = itemContentStart;
    let firstBlock = true;
    item.content.forEach((child) => {
      if (!firstBlock) pushBreakRun(acc);
      firstBlock = false;
      if (child.type.name === "taskList") {
        walkTaskList(child, childPos, acc);
      } else if (child.type.name === "paragraph") {
        appendInlineRuns(child, childPos + 1, acc);
      }
      childPos += child.nodeSize;
    });
    itemPos += item.nodeSize;
  });
}

export function serializeEditorDoc(doc: ProseMirrorNode): RichDocMap {
  const acc: RichAccumulator = { runs: [], value: "", flat: 0, collapsed: 0, md: 0 };
  let pmBlockStart = 0;
  doc.content.forEach((block, _, blockIndex) => {
    if (blockIndex > 0) pushBreakRun(acc);
    if (block.type.name === "taskList") {
      walkTaskList(block, pmBlockStart, acc);
    } else if (block.type.name === "paragraph") {
      appendInlineRuns(block, pmBlockStart + 1, acc);
    }
    pmBlockStart += block.nodeSize;
  });

  return {
    value: acc.value,
    runs: acc.runs,
    docLength: acc.flat,
    contextIds: collectInlineContextIds(acc.value),
  };
}

export function flatTo(map: RichDocMap, flatOffset: number, space: "collapsed" | "md"): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  const start = (run: RichRun) => (space === "collapsed" ? run.collapsedStart : run.mdStart);
  const run = map.runs.find((candidate) => bounded < candidate.flatStart + candidate.docLen);
  if (run) return start(run) + run.openLen + (bounded - run.flatStart);
  const last = map.runs.at(-1);
  return last ? start(last) + (space === "collapsed" ? last.collapsedLen : last.mdLen) : 0;
}

export function collapsedToFlat(map: RichDocMap, collapsedOffset: number): number {
  const run = map.runs.find(
    (candidate) => collapsedOffset < candidate.collapsedStart + candidate.collapsedLen,
  );
  if (!run) return map.docLength;
  // Checkbox prefixes and style markers are shown, never edited: every
  // offset inside them clamps to the adjacent document position.
  const within = collapsedOffset - run.collapsedStart - run.openLen;
  return run.flatStart + Math.max(0, Math.min(run.docLen, within));
}

export function flatToPm(map: RichDocMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs) {
    if (bounded < run.flatStart + run.docLen) {
      return run.pmPos + (bounded - run.flatStart);
    }
  }
  const last = map.runs[map.runs.length - 1];
  if (!last) return 1;
  return last.pmPos + last.docLen;
}

export function pmToFlat(map: RichDocMap, pmPos: number): number {
  for (const run of map.runs) {
    if (pmPos >= run.pmPos && pmPos <= run.pmPos + run.docLen) {
      // A position on a chip's trailing edge belongs after the chip.
      if (run.kind === "token" && pmPos === run.pmPos + run.docLen) {
        return run.flatStart + run.docLen;
      }
      return run.flatStart + Math.min(pmPos - run.pmPos, run.docLen);
    }
  }
  // A paragraph boundary position belongs to the newline between paragraphs.
  let best = 0;
  for (const run of map.runs) {
    if (run.pmPos <= pmPos) best = run.flatStart + run.docLen;
  }
  return Math.max(0, Math.min(best, map.docLength));
}

// ── Caret stops at styled edges ────────────────────────────────────────────
//
// Markers are decorations, not text, so the position where styled text meets
// unstyled text (or a paragraph edge) is a single document position. The
// caret gets two stops there: one that types with the marks before the edge
// and one that types with the marks after it. Stored marks pick the stop, and
// the revealed markers render on the matching side of the caret, so a pasted
// `**bold**` at the start of a line can still be typed in front of.

function styledEdge(state: EditorState) {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if (!$from.parent.inlineContent) return null;
  const before = $from.nodeBefore?.marks ?? Mark.none;
  const after = $from.nodeAfter?.marks ?? Mark.none;
  if (Mark.sameSet(before, after)) return null;
  return { before, after, current: state.storedMarks ?? $from.marks() };
}

/** True when the caret sits on a styled edge and types with the marks before it. */
export function caretTakesMarksBefore(state: EditorState): boolean {
  const edge = styledEdge(state);
  return edge !== null && Mark.sameSet(edge.current, edge.before);
}

/**
 * Moves the caret to the other stop of the styled edge it sits on, toward
 * `direction`. Returns null when there is no stop to take, so the arrow key
 * moves the caret as usual.
 */
export function stepCaretAcrossStyledEdge(
  state: EditorState,
  direction: -1 | 1,
): Transaction | null {
  const edge = styledEdge(state);
  if (!edge) return null;
  // Marks the user toggled by hand (neither stop) are theirs: move as usual.
  if (!Mark.sameSet(edge.current, edge.before) && !Mark.sameSet(edge.current, edge.after)) {
    return null;
  }
  const target = direction === -1 ? edge.before : edge.after;
  if (Mark.sameSet(edge.current, target)) return null;
  return state.tr.setStoredMarks(target);
}

// ── Undo grouping ──────────────────────────────────────────────────────────
//
// ProseMirror's history only starts a new undo step after a pause or when an
// edit is not next to the last one, so typing, backspacing and typing again
// without pausing is one step, and a store rewrite of the whole document
// (autocomplete inserting a chip, list continuation) makes every later edit
// "adjacent" and joins it. Start a new step whenever the kind of change
// switches, and after one second without changes.

export const COMPOSER_UNDO_GROUP_DELAY = 1000;

export type ComposerChangeKind = "insert" | "delete" | "other";

/**
 * Tags a transaction as a paste or cut, so it becomes its own undo step.
 * ProseMirror tags these itself only on its built-in clipboard paths; the
 * composer's `handlePaste` and cut handler replace those paths, so each of
 * their dispatches must call this, or the change merges with the typing or
 * deleting around it.
 */
export function markAsClipboardEdit(tr: Transaction, event: "paste" | "cut"): Transaction {
  return tr.setMeta("uiEvent", event);
}

function changeKindOf(tr: Transaction): ComposerChangeKind | null {
  if (!tr.docChanged) return null;
  const uiEvent = tr.getMeta("uiEvent");
  if (uiEvent === "paste" || uiEvent === "drop" || uiEvent === "cut") return "other";
  // IME input replaces its own range on each keystroke; it is still typing.
  if (tr.getMeta("composition") != null) return "insert";
  let kind: ComposerChangeKind | null = null;
  for (const step of tr.steps) {
    if (!(step instanceof ReplaceStep)) return "other";
    const inserts = step.slice.size > 0;
    const deletes = step.to > step.from;
    const stepKind = inserts && !deletes ? "insert" : deletes && !inserts ? "delete" : "other";
    if (kind !== null && kind !== stepKind) return "other";
    kind = stepKind;
  }
  return kind;
}

/**
 * Closes the current undo step before `tr` when its kind of change differs
 * from the last one, or when it is a one-off change such as a paste or a
 * store rewrite, and returns the kind to remember for the next transaction.
 * Undo and redo themselves count as one-off, so typing after them starts a
 * fresh step. Must run before the transaction is applied.
 */
export function groupUndoByChangeKind(
  tr: Transaction,
  previous: ComposerChangeKind | null,
): ComposerChangeKind | null {
  if (isHistoryTransaction(tr)) return "other";
  const kind = changeKindOf(tr);
  if (kind === null) return previous;
  if (previous !== null && (kind !== previous || kind === "other")) closeHistory(tr);
  return kind;
}
