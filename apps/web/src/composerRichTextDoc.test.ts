import { getSchemaByResolvedExtensions, Node, resolveExtensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TaskList } from "@tiptap/extension-task-list";
import { history, undo } from "@tiptap/pm/history";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDocJson,
  caretTakesMarksBefore,
  collapsedToFlat,
  COMPOSER_UNDO_GROUP_DELAY,
  type ComposerChangeKind,
  ComposerCodeExtension,
  ComposerTaskItemExtension,
  flatTo,
  flatToPm,
  groupUndoByChangeKind,
  markAsClipboardEdit,
  parseInlineMarkdown,
  pmToFlat,
  serializeEditorDoc,
  stepCaretAcrossStyledEdge,
} from "./composerRichTextDoc";

const CHIP = "[a.ts](t45-context:file/file_1)";

function stubAtom(name: string, attrs: Record<string, { default: unknown }>) {
  return Node.create({
    name,
    group: "inline",
    inline: true,
    atom: true,
    addAttributes: () => attrs,
  });
}

const schema = getSchemaByResolvedExtensions(
  resolveExtensions([
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      orderedList: false,
      dropcursor: false,
      gapcursor: false,
      trailingNode: false,
      code: false,
    }),
    ComposerCodeExtension,
    stubAtom("composer-context-reference", {
      contextId: { default: "" },
      label: { default: "" },
      source: { default: "" },
    }),
    TaskList,
    ComposerTaskItemExtension,
  ]),
);

function roundTrip(value: string) {
  const json = buildDocJson(value);
  const doc = ProseMirrorNode.fromJSON(schema, json);
  // `insertContent` validates every node against the schema; `fromJSON` does not.
  doc.check();
  return serializeEditorDoc(doc);
}

describe("composer rich text markdown", () => {
  it("parses bold markers into styled spans", () => {
    expect(parseInlineMarkdown("hello **bold** world")).toEqual([
      { text: "hello ", marks: [] },
      { text: "bold", marks: ["bold"] },
      { text: " world", marks: [] },
    ]);
  });

  it("preserves unmatched markers, escaped markers, and identifiers", () => {
    for (const text of [
      "plain text",
      "snake_case",
      "unmatched **",
      "** spaced **",
      "\\*literal\\*",
    ]) {
      expect(parseInlineMarkdown(text)).toEqual([{ text, marks: [] }]);
    }
  });

  it("renders triple markers and nested styles", () => {
    expect(parseInlineMarkdown("***both***")).toEqual([
      { text: "both", marks: ["bold", "italic"] },
    ]);
    expect(parseInlineMarkdown("*a **b** c*")).toEqual([
      { text: "a ", marks: ["italic"] },
      { text: "b", marks: ["italic", "bold"] },
      { text: " c", marks: ["italic"] },
    ]);
    expect(parseInlineMarkdown("**a `code` c**")).toEqual([
      { text: "a ", marks: ["bold"] },
      { text: "code", marks: ["bold", "code"] },
      { text: " c", marks: ["bold"] },
    ]);
  });

  it("preserves crossing italic and bold spans", () => {
    expect(parseInlineMarkdown("*a**b*****c**")).toEqual([
      { text: "a", marks: ["italic"] },
      { text: "b", marks: ["italic", "bold"] },
      { text: "c", marks: ["bold"] },
    ]);
  });

  it("keeps repeated and alternate delimiters literal inside an active mark", () => {
    const repeated = "*".repeat(10_000);
    expect(parseInlineMarkdown(repeated + "text" + repeated)).toEqual([
      { text: repeated.slice(2) + "text", marks: ["bold"] },
      { text: repeated.slice(2), marks: [] },
    ]);
    const alternate = "__".repeat(5_000);
    expect(parseInlineMarkdown("**~~" + alternate + "text" + alternate + "~~**")).toEqual([
      { text: alternate + "text" + alternate, marks: ["bold", "strike"] },
    ]);
  });

  it("keeps code span contents literal", () => {
    expect(parseInlineMarkdown("`**not bold**`")).toEqual([
      { text: "**not bold**", marks: ["code"] },
    ]);
  });
});

describe("composer rich text document model", () => {
  it.each([
    "",
    "\n\n",
    "plain text",
    "hello **bold** world",
    "a *italic* word and `code` here",
    "struck ~~out~~ now",
    "**`x`**",
    "*`x`*",
    "~~`x`~~",
    "**a `code` c**",
    "***bold italic*** keeps nesting",
    "line one\nline two",
    "trailing newline\n",
    "1. foo\n2. asdf\n",
    "- [ ] buy milk",
    "-   [ ]  buy milk",
    "\t-\t[x]\t\titem",
    "- [ ]  ",
    "- [ ]\n  - [ ] child",
    "  - [ ] first\n - [ ] second\n  - [ ] child",
    `**before ${CHIP} after**`,
    "*a **b** c*",
    "*a**b***",
    "**a*b***",
    "**a *b* c**",
    `literal \uFFFC **before ${CHIP} after**`,
    "- [x] done\n- [ ] next",
    "- [ ] parent\n  - [ ] child\n  - [ ] sibling\n- [ ] uncle",
    "- [ ] empty task follows\n- [ ]",
    `- [ ] **bold** task with ${CHIP}`,
    "para\n- [ ] task\npara",
    "- [ ]No space stays literal",
    "-[ ] also literal",
    `${CHIP} explain this`,
    `${CHIP} and ${CHIP} please`,
    "snake_case stays literal",
    "unmatched ** stays literal",
    `**bold** then ${CHIP} then *italic*`,
  ])("round-trips %s through a real ProseMirror document", (value) => {
    expect(roundTrip(value).value).toBe(value);
  });

  it.each([
    "",
    "\n",
    "text\n\n",
    "- [ ]\n- [ ] next\n",
    "- [ ] parent\n  - [ ] child\n- [ ]",
    "para\n- [ ] task\npara",
    `**before ${CHIP} after**`,
  ])("maps editable positions in %s", (value) => {
    const doc = ProseMirrorNode.fromJSON(schema, buildDocJson(value));
    const map = serializeEditorDoc(doc);
    for (let flat = 0; flat <= map.docLength; flat += 1) {
      const position = flatToPm(map, flat);
      expect(doc.resolve(position).parent.isTextblock).toBe(true);
      expect(pmToFlat(map, position)).toBe(flat);
      expect(collapsedToFlat(map, flatTo(map, flat, "collapsed"))).toBe(flat);
    }
  });

  it("keeps the caret after a trailing hard break inside the same paragraph", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("a"), schema.node("hardBreak")]),
    ]);
    const map = serializeEditorDoc(doc);
    expect(flatToPm(map, map.docLength)).toBe(3);
    expect(doc.resolve(flatToPm(map, map.docLength)).parent.isTextblock).toBe(true);
  });

  it("renders a leading task dedent as siblings and nests under the new indent", () => {
    const doc = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson("  - [ ] first\n - [ ] second\n  - [ ] child"),
    );
    const list = doc.firstChild!;
    expect(list.childCount).toBe(2);
    expect(list.child(0).childCount).toBe(1);
    expect(list.child(1).child(1).firstChild!.textContent).toBe("child");
  });

  it("applies a shared mark to text on both sides of a chip", () => {
    const doc = ProseMirrorNode.fromJSON(schema, buildDocJson(`**before ${CHIP} after**`));
    expect(doc.firstChild!.childCount).toBe(3);
    doc.firstChild!.forEach((child) =>
      expect(child.marks.map((mark) => mark.type.name)).toContain("bold"),
    );
    expect(serializeEditorDoc(doc).value).toBe(`**before ${CHIP} after**`);
  });

  it.each([
    [["bold"], ["bold", "italic"], ["italic"]],
    [["italic"], ["bold", "italic"], ["bold"]],
    [["bold"], ["bold", "strike"], ["strike"]],
    [["strike"], ["bold", "strike"], ["bold"]],
  ])("preserves crossing mark ranges %j through controlled rebuilds", (...marks) => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        null,
        marks.map((names, index) =>
          schema.text(
            String.fromCharCode(97 + index),
            names.map((name) => schema.mark(name)),
          ),
        ),
      ),
    ]);
    const serialized = serializeEditorDoc(doc).value;
    const rebuilt = ProseMirrorNode.fromJSON(schema, buildDocJson(serialized));
    expect(rebuilt.eq(doc)).toBe(true);
    expect(serializeEditorDoc(rebuilt).value).toBe(serialized);
  });

  it.each([
    { parts: [{ text: "hello ", marks: ["bold"] }], expected: "**hello** " },
    { parts: [{ text: "  ", marks: ["bold"] }], expected: "  " },
    { parts: [{ text: " left ", marks: ["bold", "italic"] }], expected: " ***left*** " },
    {
      parts: [
        { text: "one ", marks: ["bold"] },
        { text: " two ", marks: ["bold", "italic"] },
        { text: " three", marks: ["bold"] },
      ],
      expected: "**one  *two*  three**",
    },
    {
      parts: [
        { text: "hello ", marks: ["bold"] },
        { text: "world ", marks: ["bold", "italic"] },
      ],
      expected: "**hello *world*** ",
    },
    { parts: [{ text: " hello ", marks: ["code"] }], expected: "` hello `" },
    { parts: [{ text: " hello ", marks: ["bold", "code"] }], expected: "**` hello `**" },
    { parts: [{ text: " ", marks: ["bold", "code"] }], expected: "**` `**" },
  ])("keeps boundary whitespace outside emphasis in $expected", ({ parts, expected }) => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        null,
        parts.map(({ text, marks }) =>
          schema.text(
            text,
            marks.map((name) => schema.mark(name)),
          ),
        ),
      ),
    ]);
    const map = serializeEditorDoc(doc);
    expect(map.value).toBe(expected);
    const rebuilt = ProseMirrorNode.fromJSON(schema, buildDocJson(map.value));
    expect(rebuilt.textContent).toBe(doc.textContent);
    expect(serializeEditorDoc(rebuilt).value).toBe(map.value);
    for (let flat = 0; flat <= map.docLength; flat += 1) {
      expect(pmToFlat(map, flatToPm(map, flat))).toBe(flat);
      expect(collapsedToFlat(map, flatTo(map, flat, "collapsed"))).toBe(flat);
      if (flat < map.docLength && !/\s/.test(doc.textContent[flat]!)) {
        expect(rebuilt.resolve(flat + 1).nodeAfter!.marks.map((mark) => mark.type.name)).toEqual(
          doc.resolve(flat + 1).nodeAfter!.marks.map((mark) => mark.type.name),
        );
      }
    }
  });

  it("keeps chip sources canonical through the document", () => {
    const map = roundTrip(`explain ${CHIP} with **care**\nsecond line *here*`);
    expect(map.value).toBe(`explain ${CHIP} with **care**\nsecond line *here*`);
    expect(map.runs.some((run) => run.kind === "token")).toBe(true);
  });

  it("normalizes uppercase checkboxes to lowercase", () => {
    expect(roundTrip("- [X] done").value).toBe("- [x] done");
  });

  it("maps every document offset through collapsed coordinates and back", () => {
    const value = `hi **bold** ${CHIP} bye`;
    const map = roundTrip(value);
    expect(map.value).toBe(value);
    for (let flat = 0; flat <= map.docLength; flat += 1) {
      expect(collapsedToFlat(map, flatTo(map, flat, "collapsed"))).toBe(flat);
    }
  });

  it("maps markdown offsets at styled edges onto document text", () => {
    const value = "a **bold** c";
    const map = roundTrip(value);
    expect(map.value).toBe(value);
    // document text is "a bold c" (flat), markdown has the markers.
    expect(flatTo(map, 2, "md")).toBe(4);
    expect(flatTo(map, 6, "md")).toBe(10);
    expect(collapsedToFlat(map, 3)).toBe(2);
    expect(collapsedToFlat(map, 9)).toBe(6);
  });
});

describe("caret stops at styled edges", () => {
  function stateAt(value: string, pmPos: number) {
    const doc = ProseMirrorNode.fromJSON(schema, buildDocJson(value));
    return EditorState.create({ doc, selection: TextSelection.create(doc, pmPos) });
  }

  function typed(state: EditorState, text: string) {
    return serializeEditorDoc(state.apply(state.tr.insertText(text)).doc).value;
  }

  it("lets the caret step out in front of bold that starts the line", () => {
    const inside = stateAt("**bold** tail", 1);
    expect(caretTakesMarksBefore(inside)).toBe(false);
    expect(typed(inside, "x")).toBe("**xbold** tail");

    const step = stepCaretAcrossStyledEdge(inside, -1);
    expect(step).not.toBeNull();
    const outside = inside.apply(step!);
    expect(caretTakesMarksBefore(outside)).toBe(true);
    expect(typed(outside, "x")).toBe("x**bold** tail");
    // Already outside: the next ArrowLeft moves the caret as usual.
    expect(stepCaretAcrossStyledEdge(outside, -1)).toBeNull();

    const back = outside.apply(stepCaretAcrossStyledEdge(outside, 1)!);
    expect(typed(back, "x")).toBe("**xbold** tail");
  });

  it("lets the caret step out after bold that ends the line", () => {
    const inside = stateAt("head **bold**", 10);
    expect(caretTakesMarksBefore(inside)).toBe(true);
    expect(typed(inside, "x")).toBe("head **boldx**");
    expect(stepCaretAcrossStyledEdge(inside, -1)).toBeNull();

    const outside = inside.apply(stepCaretAcrossStyledEdge(inside, 1)!);
    expect(caretTakesMarksBefore(outside)).toBe(false);
    expect(typed(outside, "x")).toBe("head **bold**x");
  });

  it("offers both stops where styled text meets plain text mid-line", () => {
    // Caret after "a ": types plain until ArrowRight steps into the bold.
    const plain = stateAt("a **b** c", 3);
    expect(caretTakesMarksBefore(plain)).toBe(true);
    expect(typed(plain, "x")).toBe("a x**b** c");
    const bold = plain.apply(stepCaretAcrossStyledEdge(plain, 1)!);
    expect(typed(bold, "x")).toBe("a **xb** c");
  });

  it("offers the plain stop between bold text and a chip right after it", () => {
    // Markdown needs a space before a chip, but deleting it leaves them adjacent.
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("bold", [schema.marks.bold!.create()]),
        schema.nodes["composer-context-reference"]!.create({
          contextId: "file_1",
          label: "a.ts",
          source: CHIP,
        }),
      ]),
    ]);
    const inside = EditorState.create({ doc, selection: TextSelection.create(doc, 5) });
    expect(caretTakesMarksBefore(inside)).toBe(true);
    const outside = inside.apply(stepCaretAcrossStyledEdge(inside, 1)!);
    expect(caretTakesMarksBefore(outside)).toBe(false);
    const withText = outside.apply(outside.tr.insertText("x")).doc;
    expect(withText.child(0).child(1).text).toBe("x");
    expect(withText.child(0).child(1).marks).toEqual([]);
  });

  it("steps out of inline code at the end of a line without inserting a space", () => {
    expect(ComposerCodeExtension.config.exitable).toBe(false);
    const inside = stateAt("`code`", 5);
    const outside = inside.apply(stepCaretAcrossStyledEdge(inside, 1)!);
    expect(typed(outside, "x")).toBe("`code`x");
    expect(stepCaretAcrossStyledEdge(outside, 1)).toBeNull();
  });

  it("keeps marks the user toggled at an edge and lets the arrow move", () => {
    const inside = stateAt("a **b** c", 3);
    const toggled = inside.apply(
      inside.tr.setStoredMarks([schema.marks.bold!.create(), schema.marks.italic!.create()]),
    );
    expect(stepCaretAcrossStyledEdge(toggled, 1)).toBeNull();
    expect(stepCaretAcrossStyledEdge(toggled, -1)).toBeNull();
  });

  it("leaves arrow keys alone away from styled edges", () => {
    expect(stepCaretAcrossStyledEdge(stateAt("**bold** tail", 3), -1)).toBeNull();
    expect(stepCaretAcrossStyledEdge(stateAt("plain text", 1), -1)).toBeNull();
    expect(caretTakesMarksBefore(stateAt("plain text", 1))).toBe(false);
  });
});

describe("composer undo grouping", () => {
  function composer(text = "") {
    let clock = 0;
    let previous: ComposerChangeKind | null = null;
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("paragraph", null, text ? [schema.text(text)] : []),
      ]),
      plugins: [history({ newGroupDelay: COMPOSER_UNDO_GROUP_DELAY })],
    });
    const dispatch = (tr: Transaction) => {
      tr.setTime(clock);
      previous = groupUndoByChangeKind(tr, previous);
      state = state.apply(tr);
    };
    dispatch(state.tr.setSelection(TextSelection.atEnd(state.doc)));
    const api = {
      text: () => state.doc.textContent,
      wait: (ms: number) => ((clock += ms), api),
      type: (s: string, gap = 80) => {
        for (const ch of s) {
          clock += gap;
          dispatch(state.tr.insertText(ch));
        }
        return api;
      },
      backspace: (n: number) => {
        for (let i = 0; i < n; i += 1) {
          clock += 80;
          const at = state.selection.from;
          dispatch(state.tr.delete(at - 1, at));
        }
        return api;
      },
      paste: (s: string) => {
        clock += 80;
        dispatch(markAsClipboardEdit(state.tr.insertText(s), "paste"));
        return api;
      },
      cut: (n: number) => {
        clock += 80;
        const at = state.selection.from;
        dispatch(markAsClipboardEdit(state.tr.delete(at - n, at), "cut"));
        return api;
      },
      rewrite: (next: string) => {
        clock += 80;
        dispatch(
          state.tr.replaceWith(
            0,
            state.doc.content.size,
            schema.node("paragraph", null, [schema.text(next)]),
          ),
        );
        dispatch(state.tr.setSelection(TextSelection.atEnd(state.doc)));
        return api;
      },
      compose: (s: string) => {
        const start = state.selection.from;
        for (let i = 1; i <= s.length; i += 1) {
          clock += 80;
          dispatch(
            state.tr.insertText(s.slice(0, i), start, start + i - 1).setMeta("composition", 1),
          );
        }
        return api;
      },
      undo: () => (undo(state, dispatch), api),
    };
    return api;
  }

  it("keeps a continuous run of typing as one step", () => {
    expect(composer().type("hello world").undo().text()).toBe("");
  });

  it("starts a new step when typing turns into deleting, and back", () => {
    const editor = composer().type("hello world").backspace(5).type("there");
    expect(editor.text()).toBe("hello there");
    expect(editor.undo().text()).toBe("hello ");
    expect(editor.undo().text()).toBe("hello world");
    expect(editor.undo().text()).toBe("");
  });

  it("gives a store rewrite its own step, and typing after it another", () => {
    const editor = composer("draft ").type("one").rewrite("draft one @chip ").type("then");
    expect(editor.undo().text()).toBe("draft one @chip ");
    expect(editor.undo().text()).toBe("draft one");
    expect(editor.undo().text()).toBe("draft ");
  });

  it("gives a paste its own step", () => {
    const editor = composer().type("see ").paste("pasted text").type(" ok");
    expect(editor.undo().text()).toBe("see pasted text");
    expect(editor.undo().text()).toBe("see ");
  });

  it("gives a cut its own step between deletions", () => {
    const editor = composer().type("hello world").backspace(1).cut(3).backspace(1);
    expect(editor.text()).toBe("hello ");
    expect(editor.undo().text()).toBe("hello w");
    expect(editor.undo().text()).toBe("hello worl");
    expect(editor.undo().text()).toBe("hello world");
  });

  it("keeps IME composition as one run of typing", () => {
    expect(composer().type("go ").compose("にほん").undo().text()).toBe("");
  });

  it("merges typing across a short pause and splits it across a long one", () => {
    expect(composer().type("hello").wait(700).type(" world").undo().text()).toBe("");
    expect(composer().type("hello").wait(1100).type(" world").undo().text()).toBe("hello");
  });
});
