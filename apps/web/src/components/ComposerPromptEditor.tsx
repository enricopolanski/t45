import { type Editor, Extension, Node, type JSONContent } from "@tiptap/core";
import { TaskList } from "@tiptap/extension-task-list";
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { splitBlockKeepMarks } from "@tiptap/pm/commands";
import { type EditorState, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { use, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  expandCollapsedComposerCursor,
} from "~/composerPrompt";
import {
  buildDocJson,
  buildTiptapContent,
  collapsedToFlat,
  caretTakesMarksBefore,
  COMPOSER_UNDO_GROUP_DELAY,
  type ComposerChangeKind,
  ComposerCodeExtension,
  ComposerTaskItemExtension,
  flatTo,
  flatToPm,
  groupUndoByChangeKind,
  markAsClipboardEdit,
  pmToFlat,
  serializeEditorDoc,
  stepCaretAcrossStyledEdge,
} from "~/composerRichTextDoc";
import {
  collectInlineContextIds,
  inlineContextReferencesToLabels,
} from "~/lib/composerContextReferences";
import { cn, isMacPlatform } from "~/lib/utils";
import { getTimelinePageScrollKey } from "./chat/pageScroll";
import { ComposerChipsContext, ComposerContextReferenceChip } from "./ComposerContextChip";

export type ComposerPromptSnapshot = ReturnType<typeof snapshotAt>;

export interface ComposerPromptEditorHandle {
  focusAt: (cursor: number) => void;
  focusAtEnd: () => void;
  readSelectionRange: () => { start: number; end: number };
  readSnapshot: () => ComposerPromptSnapshot;
  /**
   * True when a collapsed caret sits on the first ("start") or last ("end")
   * visual line, counting soft wraps. Prompt history only claims ArrowUp and
   * ArrowDown at these edges so arrows still move the caret inside multiline
   * text.
   */
  isCaretOnVisualEdge: (edge: "start" | "end") => boolean;
}

interface ComposerPromptEditorProps {
  value: string;
  cursor: number;
  disabled: boolean;
  placeholder: string;
  ariaLabel: string;
  /** Identifies an editor with suggestions, even while its list is closed. */
  suggestionListId: string;
  /** References the highlighted option only while its list is rendered. */
  activeSuggestionId: string | undefined;
  containerClassName: string;
  className: string;
  placeholderClassName: string;
  onChange: (snapshot: ComposerPromptSnapshot, cursorAdjacentToChip: boolean) => void;
  onVisibleSelectionChange: () => void;
  onCommandKeyDown: (event: KeyboardEvent, isTaskItem?: boolean) => boolean;
  onPageScrollKeyDown: (key: "PageUp" | "PageDown", repeat: boolean) => void;
  onPaste: React.ClipboardEventHandler<HTMLElement>;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
}

const SURROUND_CLOSE: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  "'": "'",
  '"': '"',
  "“": "”",
  "`": "`",
  "<": ">",
  "«": "»",
  "*": "*",
  _: "_",
};

// ── Inline atom nodes (chips) ─────────────────────────────────────────────

const ComposerContextReferenceExtension = Node.create({
  name: "composer-context-reference",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return {
      contextId: { default: "" },
      label: { default: "" },
      source: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-context-reference]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-context-reference": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerContextReferenceNodeView);
  },
});

function ComposerContextReferenceNodeView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper
      as="span"
      className="relative inline-flex select-none items-center align-middle leading-none"
    >
      <ComposerContextReferenceChip
        contextId={node.attrs.contextId as string}
        label={node.attrs.label as string}
      />
    </NodeViewWrapper>
  );
}

// ── Marker reveal (show ** when the cursor is on styled text) ──────────────

type StyledRange = {
  from: number;
  to: number;
  markers: { at: number; side: number; text: string }[];
};

function collectStyledRanges(doc: ProseMirrorNode): StyledRange[] {
  const ranges: StyledRange[] = [];
  const map = serializeEditorDoc(doc);
  let range: StyledRange | null = null;
  let openLength = 0;
  for (const run of map.runs) {
    if (run.openLen > 0) {
      range ??= { from: run.pmPos, to: run.pmPos, markers: [] };
      range.markers.push({
        at: run.pmPos,
        side: -1,
        text: map.value.slice(run.mdStart, run.mdStart + run.openLen),
      });
    }
    if (range === null) continue;
    range.to = run.pmPos + run.docLen;
    if (run.closeLen > 0) {
      const end = run.mdStart + run.mdLen;
      range.markers.push({
        at: range.to,
        side: -2,
        text: map.value.slice(end - run.closeLen, end),
      });
    }
    openLength += run.openLen - run.closeLen;
    if (openLength === 0) {
      ranges.push(range);
      range = null;
    }
  }
  return ranges;
}

const MarkerPluginKey = new PluginKey("composer-rich-markers");

const ComposerMarkerPlugin = new Plugin({
  key: MarkerPluginKey,
  state: {
    init: (_, state) => decorationsForSelection(state),
    apply: (tr, old, _, state) =>
      tr.docChanged || tr.selectionSet || tr.storedMarksSet ? decorationsForSelection(state) : old,
  },
  props: {
    decorations(state) {
      return MarkerPluginKey.getState(state);
    },
  },
});

function decorationsForSelection(state: EditorState): DecorationSet {
  const { doc, selection } = state;
  // Markers at the caret render after it while it types with the marks before
  // the edge. Shifting keeps closers ahead of openers at a shared position.
  const caretSide = caretTakesMarksBefore(state) ? 3 : 0;
  const decorations: Decoration[] = [];
  if (!selection.empty) {
    doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (node.type.name.startsWith("composer-")) {
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, { class: "composer-chip-range-selected" }),
        );
        return false;
      }
      return true;
    });
  }
  for (const range of collectStyledRanges(doc)) {
    const active = selection.empty
      ? selection.from >= range.from && selection.from <= range.to
      : selection.from < range.to && selection.to > range.from;
    if (!active) continue;
    for (const { at, side: baseSide, text } of range.markers) {
      const side = selection.empty && at === selection.from ? baseSide + caretSide : baseSide;
      const marker = document.createElement("span");
      marker.className = "composer-rich-marker";
      marker.textContent = text;
      marker.setAttribute("aria-hidden", "true");
      decorations.push(
        Decoration.widget(at, marker, { side, key: `marker-${at}-${side}-${marker.textContent}` }),
      );
    }
  }
  return DecorationSet.create(doc, decorations);
}

const ComposerMarkersExtension = Extension.create({
  name: "composer-rich-markers",
  addProseMirrorPlugins() {
    return [ComposerMarkerPlugin];
  },
});

// ── Editor component ───────────────────────────────────────────────────────

/**
 * Starts a new undo step when the kind of change switches (typing, deleting,
 * a paste or a store rewrite). Runs as dispatch middleware because the
 * grouping has to be decided before the history plugin applies the transaction.
 */
const ComposerUndoGroupingExtension = Extension.create<
  Record<string, never>,
  { previous: ComposerChangeKind | null }
>({
  name: "composer-undo-grouping",
  addStorage() {
    return { previous: null };
  },
  dispatchTransaction({ transaction, next }) {
    this.storage.previous = groupUndoByChangeKind(transaction, this.storage.previous);
    next(transaction);
  },
});

const COMPOSER_EXTENSIONS = [
  StarterKit.configure({
    blockquote: false,
    bulletList: false,
    codeBlock: false,
    heading: false,
    horizontalRule: false,
    listItem: false,
    link: false,
    orderedList: false,
    underline: false,
    dropcursor: false,
    gapcursor: false,
    trailingNode: false,
    code: false,
    undoRedo: { newGroupDelay: COMPOSER_UNDO_GROUP_DELAY },
  }),
  ComposerUndoGroupingExtension,
  ComposerContextReferenceExtension,
  ComposerMarkersExtension,
  ComposerCodeExtension,
  TaskList,
  ComposerTaskItemExtension,
];

export function ComposerPromptEditor(props: ComposerPromptEditorProps) {
  const {
    value,
    cursor,
    disabled,
    placeholder,
    ariaLabel,
    suggestionListId,
    activeSuggestionId,
    containerClassName,
    className,
    placeholderClassName,
    onPageScrollKeyDown,
    onPaste,
    editorRef,
  } = props;
  // The latest props, for editor callbacks created once with the editor.
  const latest = useRef(props);
  // The editor instance for callbacks created before it exists (paste).
  // Effects flush before any user interaction, so this is always set.
  const editorHolder = useRef<Editor | null>(null);

  useLayoutEffect(() => {
    latest.current = props;
  });

  const initial = snapshotAt(value, cursor);
  const snapshotRef = useRef(initial);
  const selectionRangeRef = useRef(caretRange(initial));
  const isApplyingControlledUpdateRef = useRef(false);
  const hasAppliedControlledSelectionRef = useRef(false);
  const [content] = useState(() => buildDocJson(value));
  const { records } = use(ComposerChipsContext);

  const handleEditorChange = (updated: Editor) => {
    const { snapshot: next, selectionRange: nextSelectionRange } = readEditorSnapshot(updated);
    const previousSelectionRange = selectionRangeRef.current;
    selectionRangeRef.current = nextSelectionRange;
    if (isApplyingControlledUpdateRef.current) return;
    const previousSnapshot = snapshotRef.current;
    const snapshotChanged = !(
      previousSnapshot.value === next.value &&
      previousSnapshot.cursor === next.cursor &&
      previousSnapshot.expandedCursor === next.expandedCursor &&
      previousSnapshot.contextIds.length === next.contextIds.length &&
      previousSnapshot.contextIds.every((id, index) => id === next.contextIds[index])
    );
    if (!snapshotChanged) {
      if (
        nextSelectionRange.start !== nextSelectionRange.end &&
        (nextSelectionRange.start !== previousSelectionRange.start ||
          nextSelectionRange.end !== previousSelectionRange.end)
      ) {
        latest.current.onVisibleSelectionChange();
      }
      return;
    }
    // A selection-only update while a newer prompt waits to be applied (a chip
    // was just inserted through the store) would report stale text and clobber
    // the prompt. Let the controlled rewrite land instead.
    if (previousSnapshot.value === next.value && next.value !== latest.current.value) {
      return;
    }
    snapshotRef.current = next;
    const { $from } = updated.state.selection;
    latest.current.onChange(
      next,
      [$from.nodeBefore, $from.nodeAfter].some((node) => node?.type.name.startsWith("composer-")),
    );
  };

  const editorAttributes = {
    class: cn("composer-tiptap", className),
    role: "textbox",
    "aria-multiline": "true",
    "aria-label": ariaLabel,
    ...(disabled
      ? { "aria-readonly": "true" }
      : {
          "aria-autocomplete": "list",
          "aria-haspopup": "listbox",
          ...(activeSuggestionId
            ? { "aria-controls": suggestionListId, "aria-activedescendant": activeSuggestionId }
            : {}),
        }),
    "aria-placeholder": placeholder,
  };

  const editor = useEditor(
    {
      extensions: COMPOSER_EXTENSIONS,
      content,
      editable: !disabled,
      editorProps: {
        attributes: editorAttributes,
        handleKeyDown: (view, event) => {
          if (
            isMacPlatform(navigator.platform) &&
            (event.key === "Home" || event.key === "End") &&
            !event.altKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.isComposing
          ) {
            const selection = window.getSelection();
            if (selection?.anchorNode && view.dom.contains(selection.anchorNode)) {
              event.preventDefault();
              event.stopPropagation();
              selection.modify(
                event.shiftKey ? "extend" : "move",
                event.key === "Home" ? "backward" : "forward",
                "lineboundary",
              );
              if (selection.anchorNode && selection.focusNode) {
                view.dispatch(
                  view.state.tr
                    .setSelection(
                      TextSelection.create(
                        view.state.doc,
                        view.posAtDOM(selection.anchorNode, selection.anchorOffset),
                        view.posAtDOM(selection.focusNode, selection.focusOffset),
                      ),
                    )
                    .scrollIntoView(),
                );
              }
              return true;
            }
          }
          if (
            (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
            !event.shiftKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.isComposing &&
            view.state.selection.empty
          ) {
            const { $from } = view.state.selection;
            const direction = event.key === "ArrowLeft" ? -1 : 1;
            // Take the other stop of a styled edge before skipping a chip, so
            // the plain stop between styled text and a chip stays reachable.
            const step = stepCaretAcrossStyledEdge(view.state, direction);
            if (step) {
              event.preventDefault();
              event.stopPropagation();
              view.dispatch(step);
              return true;
            }
            const adjacent = direction === -1 ? $from.nodeBefore : $from.nodeAfter;
            if (adjacent?.type.name.startsWith("composer-")) {
              event.preventDefault();
              event.stopPropagation();
              view.dispatch(
                view.state.tr
                  .setSelection(
                    TextSelection.create(view.state.doc, $from.pos + direction * adjacent.nodeSize),
                  )
                  .scrollIntoView(),
              );
              return true;
            }
          }
          if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) {
            event.stopPropagation();
            return true;
          }
          // Enter on a focused task checkbox must not send the prompt (or
          // split anything): Space toggles it, Enter does nothing.
          if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
            event.preventDefault();
            return true;
          }
          const handler = latest.current.onCommandKeyDown;
          if (event.key === "Enter") {
            const instance = editorHolder.current;
            const isTaskItem = instance?.isActive("taskItem") ?? false;
            const handled = handler(event, isTaskItem);
            if (handled) {
              event.preventDefault();
              event.stopPropagation();
              return true;
            }
            event.preventDefault();
            if (
              isTaskItem &&
              instance &&
              (instance.commands.splitListItem("taskItem", { checked: false }) ||
                (view.state.selection.$from.parent.content.size === 0 &&
                  instance.commands.liftListItem("taskItem")))
            ) {
              return true;
            }
            // Split the paragraph so a single newline visibly advances the caret.
            return splitBlockKeepMarks(view.state, (tr) => {
              // The split is programmatic, so the browser won't follow the
              // caret into view on its own.
              view.dispatch(tr.scrollIntoView());
            });
          }
          const handled = handler(event);
          if (handled) {
            event.preventDefault();
            event.stopPropagation();
          }
          return handled;
        },
        handleTextInput: (view, from, to, text) => {
          if (text.length !== 1) return false;
          const closer = SURROUND_CLOSE[text];
          if (!closer || from === to) return false;
          // Never wrap chips or other atoms, and never wrap styled text: the
          // default replace keeps marks intact, wrapping would drop them.
          let touchesSpecial = false;
          view.state.doc.nodesBetween(from, to, (node) => {
            if (
              (node.isAtom && node.isInline && !node.isText) ||
              (node.isText && node.marks.length > 0)
            ) {
              touchesSpecial = true;
              return false;
            }
            return true;
          });
          if (touchesSpecial) return false;
          const tr = view.state.tr.insertText(closer, to).insertText(text, from);
          tr.setSelection(TextSelection.create(tr.doc, from + text.length, to + text.length));
          view.dispatch(tr);
          return true;
        },
        handlePaste: (view, event) => {
          const clipboardData = event.clipboardData;
          if (!clipboardData || clipboardData.files.length > 0) return false;
          const pastedText = clipboardData.getData("text/plain");
          if (!pastedText) return false;
          event.preventDefault();
          // A link inserted as text would still serialize as a reference and reparse into a
          // chip with nothing behind it, so pasted links land as their labels. Styled spans come
          // back as marks; newlines split paragraphs, never trailing hard breaks, which render no
          // visible line.
          const blocks = buildTiptapContent(inlineContextReferencesToLabels(pastedText));
          // One paragraph pastes inline, joining the caret's line.
          const content = (
            blocks.length === 1 && blocks[0]?.type === "paragraph"
              ? (blocks[0].content ?? [])
              : blocks
          ) as JSONContent[];
          const editorInstance = editorHolder.current;
          if (editorInstance && content.length > 0) {
            editorInstance
              .chain()
              // Tagged on the same transaction insertContent builds, so the
              // paste is one undo step of its own.
              .command(({ tr }) => {
                markAsClipboardEdit(tr, "paste");
                return true;
              })
              .insertContent(content)
              .scrollIntoView()
              .run();
          }
          return true;
        },
      },
      onTransaction: ({ editor: updated }) => handleEditorChange(updated),
    },
    [],
  );

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    editorHolder.current = editor;
  }, [editor]);

  // Tiptap forwards option changes to the view from a passive effect, so a
  // class change here would reach the ProseMirror element one tick after
  // React commits. The chat composer measures its resting and expanded
  // geometry in layout effects that run first, and it clamps the prompt
  // through `className`, so the attributes are pushed to the view here for
  // those measurements to see the layout they are about to reserve for.
  useLayoutEffect(() => {
    if (!editor.isInitialized) return;
    editor.view.setProps({ attributes: editorAttributes });
  }, [editor, editorAttributes]);

  const readSnapshot = () => {
    const { snapshot, selectionRange } = readEditorSnapshot(editor);
    selectionRangeRef.current = selectionRange;
    snapshotRef.current = snapshot;
    return snapshot;
  };

  // Controlled value/cursor from the store (history recall, chip insertion…).
  useLayoutEffect(() => {
    const initialSelection = !hasAppliedControlledSelectionRef.current;
    hasAppliedControlledSelectionRef.current = true;
    const previousSnapshot = snapshotRef.current;
    if (
      !initialSelection &&
      previousSnapshot.value === value &&
      previousSnapshot.cursor === clampCollapsedComposerCursor(value, cursor)
    ) {
      return;
    }
    const next = snapshotAt(value, cursor);
    snapshotRef.current = next;
    selectionRangeRef.current = caretRange(next);
    const isFocused = document.activeElement === editor.view.dom;
    if (!initialSelection && previousSnapshot.value === value && !isFocused) return;

    isApplyingControlledUpdateRef.current = true;
    if (previousSnapshot.value !== value) {
      editor.commands.setContent(buildDocJson(value), {
        emitUpdate: false,
      });
    }
    placeCaret(editor, next.cursor, isFocused);
    queueMicrotask(() => {
      isApplyingControlledUpdateRef.current = false;
    });
  }, [cursor, editor, snapshotRef, value]);

  const focusAt = (nextCursor: number) => {
    editor.view.dom.focus({ preventScroll: true });
    // A newer prompt is waiting to be applied (a chip was just inserted
    // through the store). Reporting the editor's stale text now would
    // overwrite that prompt; the pending rewrite places the caret instead.
    if (snapshotRef.current.value !== latest.current.value) return;
    const next = snapshotAt(snapshotRef.current.value, nextCursor);
    placeCaret(editor, next.cursor, true);
    if (next.cursor === snapshotRef.current.cursor) return;
    snapshotRef.current = next;
    selectionRangeRef.current = caretRange(next);
    latest.current.onChange(next, false);
  };

  useImperativeHandle(editorRef, () => ({
    focusAt,
    focusAtEnd: () => {
      const { value: prompt } = snapshotRef.current;
      focusAt(collapseExpandedComposerCursor(prompt, prompt.length));
    },
    readSelectionRange: () => {
      readSnapshot();
      return selectionRangeRef.current;
    },
    readSnapshot,
    isCaretOnVisualEdge: (edge) => {
      const snapshot = readSnapshot();
      if (snapshot.value.length === 0) return true;
      const rest =
        edge === "start"
          ? snapshot.value.slice(0, snapshot.expandedCursor)
          : snapshot.value.slice(snapshot.expandedCursor);
      if (!editor.state.selection.empty || rest.includes("\n")) return false;
      return editor.view.endOfTextblock(edge === "start" ? "up" : "down");
    },
  }));

  const handleCopyCut = (event: React.ClipboardEvent, cut: boolean) => {
    if (cut && !editor.isEditable) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const { doc, schema } = editor.state;
    const slice = doc.slice(from, to);
    const first = slice.content.firstChild;
    const content = first?.isInline
      ? schema.nodes.paragraph!.create(null, slice.content)
      : first?.type.name === "taskItem"
        ? schema.nodes.taskList!.create(null, slice.content)
        : slice.content;
    // Context chips copy as their labels: context never travels through the clipboard.
    const text = inlineContextReferencesToLabels(
      serializeEditorDoc(doc.type.create(null, content)).value,
    );
    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
    if (cut) {
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          markAsClipboardEdit(tr, "cut");
          return true;
        })
        .deleteSelection()
        .run();
    }
  };

  return (
    <div
      className={cn(
        "relative flow-root font-sans text-(length:--font-size-prompt) max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)",
        containerClassName,
      )}
    >
      <EditorContent
        editor={editor}
        onKeyDown={(event) => {
          if (event.key !== "PageUp" && event.key !== "PageDown") return;
          const target = editor.view.dom;
          const pageScrollKey = getTimelinePageScrollKey({
            altKey: event.altKey,
            clientHeight: target.clientHeight,
            ctrlKey: event.ctrlKey,
            defaultPrevented: event.defaultPrevented,
            isComposing: event.nativeEvent.isComposing,
            key: event.key,
            keyCode: event.keyCode,
            metaKey: event.metaKey,
            scrollHeight: target.scrollHeight,
            scrollTop: target.scrollTop,
            shiftKey: event.shiftKey,
          });
          if (!pageScrollKey) return;
          event.preventDefault();
          onPageScrollKeyDown(pageScrollKey, event.repeat);
        }}
        onPasteCapture={onPaste}
        onCopyCapture={(event) => handleCopyCut(event, false)}
        onCutCapture={(event) => handleCopyCut(event, true)}
      />
      {value.length === 0 && records.size === 0 && placeholder ? (
        <div
          className={cn(
            "pointer-events-none absolute inset-0 leading-relaxed text-placeholder/75",
            placeholderClassName,
          )}
        >
          {placeholder}
        </div>
      ) : null}
    </div>
  );
}

function snapshotAt(value: string, cursor: number) {
  const clamped = clampCollapsedComposerCursor(value, cursor);
  return {
    value,
    cursor: clamped,
    expandedCursor: expandCollapsedComposerCursor(value, clamped),
    contextIds: collectInlineContextIds(value),
  };
}

const caretRange = ({ expandedCursor }: ComposerPromptSnapshot) => ({
  start: expandedCursor,
  end: expandedCursor,
});

/**
 * Puts the caret at the collapsed `cursor`. Native scrolling only happens for real input, so a
 * caret placed by a controlled rewrite or a focus restore scrolls into view explicitly.
 */
function placeCaret(editor: Editor, cursor: number, scroll: boolean) {
  const map = serializeEditorDoc(editor.state.doc);
  const chain = editor.chain().setTextSelection(flatToPm(map, collapsedToFlat(map, cursor)));
  (scroll ? chain.scrollIntoView() : chain).run();
}

/** The editor's prompt, caret and expanded selection range, in the store's coordinates. */
function readEditorSnapshot(editor: Editor) {
  const map = serializeEditorDoc(editor.state.doc);
  const { from, to } = editor.state.selection;
  const fromFlat = pmToFlat(map, from);
  const expandedCursor = Math.max(0, Math.min(map.value.length, flatTo(map, fromFlat, "md")));
  const expandedEnd = flatTo(map, pmToFlat(map, to), "md");
  return {
    snapshot: {
      value: map.value,
      cursor: clampCollapsedComposerCursor(map.value, flatTo(map, fromFlat, "collapsed")),
      expandedCursor,
      contextIds: map.contextIds,
    },
    selectionRange: {
      start: Math.min(expandedCursor, expandedEnd),
      end: Math.max(expandedCursor, expandedEnd),
    },
  };
}
