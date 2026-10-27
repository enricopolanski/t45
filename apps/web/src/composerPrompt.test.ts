import { MESSAGE_MAX_INPUT_CHARS, ChatContextId } from "@t45/contracts/models/Chat";
import { formatComposerContextReference } from "@t45/core/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import {
  buildComposerPromptHistoryEntries,
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  type ComposerCommandItem,
  type ComposerPromptHistoryPosition,
  composerStateAtPromptEnd,
  composerSubmitsOnKey,
  continueListOnEnter,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  getComposerPromptLengthValidationMessage,
  indentListOnTab,
  parseStandaloneComposerSlashCommand,
  recallableComposerPrompt,
  searchSlashCommandItems,
  stepComposerPromptHistory,
} from "./composerPrompt";
import { carryDisplacedCustomAnswerIntoPrompt } from "./components/chat/chatQuestions";

const fileReference = formatComposerContextReference({
  kind: "file",
  contextId: ChatContextId.make("file_ctx-1"),
  label: "notes.txt",
});

describe("composerSubmitsOnKey", () => {
  const input = { platform: "Linux", isMobileViewport: false };
  const enter = { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

  it("sends on Enter and leaves Shift+Enter to insert a newline", () => {
    expect(composerSubmitsOnKey({ ...input, event: enter })).toBe(true);
    expect(composerSubmitsOnKey({ ...input, event: { ...enter, shiftKey: true } })).toBe(false);
    expect(composerSubmitsOnKey({ ...input, event: { ...enter, altKey: true } })).toBe(false);
  });

  it.each(["MacIntel", "Win32", "Linux"])(
    "sends on Mod+Enter and Mod+Alt+Enter on %s",
    (platform) => {
      const modEnter = {
        ...enter,
        metaKey: platform === "MacIntel",
        ctrlKey: platform !== "MacIntel",
      };
      expect(composerSubmitsOnKey({ ...input, platform, event: modEnter })).toBe(true);
      expect(
        composerSubmitsOnKey({ ...input, platform, event: { ...modEnter, altKey: true } }),
      ).toBe(true);
      expect(
        composerSubmitsOnKey({
          ...input,
          platform,
          event: {
            ...modEnter,
            metaKey: !modEnter.metaKey,
            ctrlKey: !modEnter.ctrlKey,
            altKey: true,
          },
        }),
      ).toBe(false);
    },
  );

  it.each([
    { isMobileViewport: true },
    { event: { ...enter, isComposing: true } },
    { event: { ...enter, keyCode: 229 } },
    { event: { ...enter, repeat: true } },
  ])("does not submit with %j", (override) => {
    expect(composerSubmitsOnKey({ ...input, event: enter, ...override })).toBe(false);
  });
});

describe("detectComposerTrigger", () => {
  it("detects a slash command token while typing its name", () => {
    const text = "/comp";
    expect(detectComposerTrigger(text, text.length)).toEqual({
      query: "comp",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("closes the trigger once the command has arguments", () => {
    expect(detectComposerTrigger("/new spark", "/new spark".length)).toBeNull();
  });
});

describe("expandCollapsedComposerCursor", () => {
  it("keeps cursor unchanged when no chip is present", () => {
    expect(expandCollapsedComposerCursor("plain text", 5)).toBe(5);
  });

  it("maps a collapsed cursor after a chip to the expanded text cursor", () => {
    const text = `run ${fileReference} then`;
    expect(expandCollapsedComposerCursor(text, "run ".length + 2)).toBe(
      `run ${fileReference} `.length,
    );
  });
});

describe("composerStateAtPromptEnd", () => {
  it("puts the caret at the end of a restored parked draft", () => {
    const prompt = carryDisplacedCustomAnswerIntoPrompt("first half\n", "second half");
    expect(composerStateAtPromptEnd(prompt)).toEqual({
      cursor: prompt.length,
      trigger: null,
    });
  });

  it("collapses chips so the next keystroke lands after the draft", () => {
    const prompt = carryDisplacedCustomAnswerIntoPrompt("", `see ${fileReference} please`);
    expect(composerStateAtPromptEnd(prompt).cursor).toBe("see ".length + 1 + " please".length);
    expect(composerStateAtPromptEnd(prompt).cursor).not.toBe(0);
    expect(composerStateAtPromptEnd(prompt).cursor).not.toBe(prompt.length);
  });
});

describe("collapseExpandedComposerCursor", () => {
  it("keeps cursor unchanged when no chip is present", () => {
    expect(collapseExpandedComposerCursor("plain text", 5)).toBe(5);
  });

  it("maps an expanded cursor after a chip back to the collapsed cursor", () => {
    const text = `run ${fileReference} then`;
    expect(collapseExpandedComposerCursor(text, `run ${fileReference} `.length)).toBe(
      "run ".length + 2,
    );
  });

  it("preserves the caret before trailing text after consecutive chips", () => {
    const text = `${fileReference} a ${fileReference} tail`;
    const expanded = `${fileReference} a ${fileReference} `.length;
    expect(collapseExpandedComposerCursor(text, expanded)).toBe(6);
    expect(expandCollapsedComposerCursor(text, 6)).toBe(expanded);
  });
});

describe("clampCollapsedComposerCursor", () => {
  it("clamps to collapsed prompt length when chips are present", () => {
    const text = `open ${fileReference} then `;
    expect(clampCollapsedComposerCursor(text, text.length)).toBe(
      "open ".length + 1 + " then ".length,
    );
    expect(clampCollapsedComposerCursor(text, Number.POSITIVE_INFINITY)).toBe(
      "open ".length + 1 + " then ".length,
    );
  });
});

describe("parseStandaloneComposerSlashCommand", () => {
  it("parses standalone /new command", () => {
    expect(parseStandaloneComposerSlashCommand(" /NEW ")).toBe("new");
  });

  it("parses standalone /compact command", () => {
    expect(parseStandaloneComposerSlashCommand("/compact\n")).toBe("compact");
  });

  it("ignores slash commands with extra message text", () => {
    expect(parseStandaloneComposerSlashCommand("/new explain this")).toBeNull();
    expect(parseStandaloneComposerSlashCommand("/compact the notes")).toBeNull();
  });
});

describe("searchSlashCommandItems", () => {
  const items = [
    { command: "new", description: "Start a new chat" },
    { command: "compact", description: "Summarize the conversation to free up context" },
  ] satisfies ComposerCommandItem[];

  it("lists every command for an empty query", () => {
    expect(searchSlashCommandItems(items, "").map((item) => item.command)).toEqual([
      "new",
      "compact",
    ]);
  });

  it("puts a command-name match ahead of a description match", () => {
    expect(searchSlashCommandItems(items, "c").map((item) => item.command)).toEqual([
      "compact",
      "new",
    ]);
  });

  it("matches a description after every name match", () => {
    expect(searchSlashCommandItems(items, "free").map((item) => item.command)).toEqual(["compact"]);
    expect(searchSlashCommandItems(items, "t").map((item) => item.command)).toEqual([
      "compact",
      "new",
    ]);
    expect(searchSlashCommandItems(items, "cmp")).toEqual([]);
  });
});

describe("composer list editing", () => {
  function applyEdit(value: string, edit: { start: number; end: number; replacement: string }) {
    return value.slice(0, edit.start) + edit.replacement + value.slice(edit.end);
  }

  it("continues ordered lists with the next number", () => {
    const value = "1. foo";
    const edit = continueListOnEnter(value, value.length);
    expect(edit).not.toBeNull();
    expect(applyEdit(value, edit!)).toBe("1. foo\n2. ");
  });

  it("increments multi-digit and paren markers", () => {
    expect(applyEdit("12. foo", continueListOnEnter("12. foo", 7)!)).toBe("12. foo\n13. ");
    expect(applyEdit("3) foo", continueListOnEnter("3) foo", 6)!)).toBe("3) foo\n4) ");
  });

  it("continues bullets and keeps indentation", () => {
    expect(applyEdit("- foo", continueListOnEnter("- foo", 5)!)).toBe("- foo\n- ");
    expect(applyEdit("  * foo", continueListOnEnter("  * foo", 7)!)).toBe("  * foo\n  * ");
  });

  it("splits mid-line items", () => {
    expect(applyEdit("1. foobar", continueListOnEnter("1. foobar", 5)!)).toBe("1. fo\n2. obar");
  });

  it("exits the list on an empty item", () => {
    expect(applyEdit("1. foo\n2. ", continueListOnEnter("1. foo\n2. ", 10)!)).toBe("1. foo\n");
    expect(applyEdit("- ", continueListOnEnter("- ", 2)!)).toBe("");
  });

  it("ignores non-list lines and carets inside the marker", () => {
    expect(continueListOnEnter("plain text", 5)).toBeNull();
    expect(continueListOnEnter("1.foo no space", 3)).toBeNull();
    expect(continueListOnEnter("-foo", 2)).toBeNull();
    expect(continueListOnEnter("1. foo", 1)).toBeNull();
  });

  it("refuses to split an inline chip", () => {
    const value = "1. [notes.txt](t45-context:file/ctx_1) go";
    const cursor = value.indexOf("notes") + 2;
    expect(continueListOnEnter(value, cursor)).toBeNull();
  });

  it("indents list items on Tab", () => {
    expect(applyEdit("- foo", indentListOnTab("- foo", 2)!)).toBe("  - foo");
    expect(applyEdit("- [x] done", indentListOnTab("- [x] done", 6)!)).toBe("  - [x] done");
    expect(indentListOnTab("plain", 2)).toBeNull();
  });
});

describe("composer prompt history", () => {
  const entries = buildComposerPromptHistoryEntries([
    { id: "m1", text: "first" },
    { id: "m2", text: "second" },
    { id: "m3", text: "third" },
  ]);

  function backward(position: ComposerPromptHistoryPosition | null, currentPrompt: string) {
    return stepComposerPromptHistory({ direction: "backward", entries, position, currentPrompt });
  }

  function forward(position: ComposerPromptHistoryPosition | null, currentPrompt: string) {
    return stepComposerPromptHistory({ direction: "forward", entries, position, currentPrompt });
  }

  it("removes canonical references without restoring dangling chips", () => {
    const sent =
      "Look at [b.ts](t45-context:file/rc-1) please\n    indented  code\n![image](t45-context:image/img-1)";
    expect(recallableComposerPrompt(sent)).toBe("Look at please\n    indented  code");
    expect(recallableComposerPrompt("![image](t45-context:image/img-1)")).toBe("");
  });

  it("returns an empty string for attachment-only sends", () => {
    expect(recallableComposerPrompt("   ")).toBe("");
    expect(recallableComposerPrompt("")).toBe("");
  });

  it("keeps user messages with text, oldest first", () => {
    expect(entries.map((entry) => entry.prompt)).toEqual(["first", "second", "third"]);
  });

  it("collapses consecutive duplicates onto the newest message id", () => {
    const collapsed = buildComposerPromptHistoryEntries([
      { id: "m1", text: "same" },
      { id: "m2", text: "same" },
      { id: "m3", text: "other" },
      { id: "m4", text: "same" },
    ]);
    expect(collapsed).toEqual([
      { id: "m2", prompt: "same" },
      { id: "m3", prompt: "other" },
      { id: "m4", prompt: "same" },
    ]);
  });

  it("does not start browsing from a non-empty draft", () => {
    expect(backward(null, "typing")).toBeNull();
  });

  it("walks back from the newest entry", () => {
    const first = backward(null, "");
    expect(first).toEqual({ position: { entryId: "m3", recalled: "third" }, prompt: "third" });
    expect(backward(first!.position, "third")?.prompt).toBe("second");
  });

  it("is a no-op at the oldest entry so the caret keeps moving", () => {
    expect(backward({ entryId: "m1", recalled: "first" }, "first")).toBeNull();
  });

  it("walks forward and empties the composer past the newest entry", () => {
    const newer = forward({ entryId: "m2", recalled: "second" }, "second");
    expect(newer?.prompt).toBe("third");
    expect(forward(newer!.position, "third")).toEqual({ position: null, prompt: "" });
  });

  it("treats an edited recall as a fresh draft", () => {
    const position: ComposerPromptHistoryPosition = { entryId: "m3", recalled: "third" };
    expect(backward(position, "third edited")).toBeNull();
    expect(forward(position, "third edited")).toBeNull();
    expect(backward(position, "")?.position).toEqual({ entryId: "m3", recalled: "third" });
  });

  it("does nothing on forward when not browsing", () => {
    expect(forward(null, "")).toBeNull();
  });

  it("follows the entry by id when the list changes under it", () => {
    const grown = buildComposerPromptHistoryEntries([
      { id: "m0", text: "zeroth" },
      { id: "m1", text: "A" },
      { id: "m2", text: "B" },
      { id: "m3", text: "A" },
    ]);
    const older = stepComposerPromptHistory({
      direction: "backward",
      entries: grown,
      position: { entryId: "m1", recalled: "A" },
      currentPrompt: "A",
    });
    expect(older?.prompt).toBe("zeroth");
    const missing = stepComposerPromptHistory({
      direction: "forward",
      entries: grown,
      position: { entryId: "gone", recalled: "not sent" },
      currentPrompt: "not sent",
    });
    expect(missing).toBeNull();
  });

  it("falls back to matching text when a duplicate collapse retires the id", () => {
    const collapsed = buildComposerPromptHistoryEntries([
      { id: "m1", text: "first" },
      { id: "m3", text: "A" },
    ]);
    const step = stepComposerPromptHistory({
      direction: "backward",
      entries: collapsed,
      position: { entryId: "m2", recalled: "A" },
      currentPrompt: "A",
    });
    expect(step?.prompt).toBe("first");
  });
});

describe("getComposerPromptLengthValidationMessage", () => {
  const oneOver =
    "Prompt is 1 character over the 120,000-character limit. Shorten or split it before sending.";

  it("rejects a prompt over the shared limit and accepts one at it", () => {
    expect(getComposerPromptLengthValidationMessage("x".repeat(MESSAGE_MAX_INPUT_CHARS + 1))).toBe(
      oneOver,
    );
    expect(
      getComposerPromptLengthValidationMessage("x".repeat(MESSAGE_MAX_INPUT_CHARS)),
    ).toBeNull();
  });

  it("ignores surrounding whitespace, which sending trims", () => {
    expect(
      getComposerPromptLengthValidationMessage(` ${"x".repeat(MESSAGE_MAX_INPUT_CHARS)} `),
    ).toBeNull();
  });
});
