import { MESSAGE_MAX_INPUT_CHARS } from "@t45/contracts/models/Chat";

import { parseInlineTokens } from "./inlineTokens";
import { removeContextReferences } from "./lib/composerContextReferences";
import { isMacPlatform } from "./lib/utils";

export type ComposerSlashCommand = "new" | "compact";

export interface ComposerTrigger {
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

export interface ComposerCommandItem {
  command: ComposerSlashCommand;
  description: string;
}

// ── Keybindings & shortcuts ────────────────────────────────────────────────

export interface ComposerKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  repeat?: boolean;
}

/** `mod` is Command on macOS and Ctrl elsewhere; the other of the two must stay up. */
function hasModKey(event: ComposerKeyEvent, platform: string): boolean {
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/** Enter and Mod+Enter send, Shift+Enter is a newline, and Alt+Enter sends only with Mod. */
export function composerSubmitsOnKey(input: {
  event: ComposerKeyEvent;
  platform: string;
  isMobileViewport: boolean;
}): boolean {
  const { event } = input;
  if (input.isMobileViewport || event.isComposing || event.keyCode === 229 || event.repeat)
    return false;
  if (event.key !== "Enter" || event.shiftKey) return false;
  return !event.altKey || hasModKey(event, input.platform);
}

// ── Cursor & inline token offsets ──────────────────────────────────────────

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

export function expandCollapsedComposerCursor(text: string, cursorInput: number): number {
  const collapsedCursor = clampCursor(text, cursorInput);
  const segments = parseInlineTokens(text);
  if (segments.length === 0) {
    return collapsedCursor;
  }

  let remaining = collapsedCursor;
  let expandedCursor = 0;

  for (const segment of segments) {
    if (segment.type !== "text") {
      const expandedLength = segment.source.length;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return expandedCursor + remaining;
    }
    remaining -= segmentLength;
    expandedCursor += segmentLength;
  }

  return expandedCursor;
}

export function clampCollapsedComposerCursor(text: string, cursorInput: number): number {
  const collapsedLength = parseInlineTokens(text).reduce(
    (total, segment) => total + (segment.type === "text" ? segment.text.length : 1),
    0,
  );
  if (!Number.isFinite(cursorInput)) {
    return collapsedLength;
  }
  return Math.max(0, Math.min(collapsedLength, Math.floor(cursorInput)));
}

export function collapseExpandedComposerCursor(text: string, cursorInput: number): number {
  const expandedCursor = clampCursor(text, cursorInput);
  const segments = parseInlineTokens(text);
  if (segments.length === 0) {
    return expandedCursor;
  }

  let remaining = expandedCursor;
  let collapsedCursor = 0;

  for (const segment of segments) {
    if (segment.type !== "text") {
      const expandedLength = segment.source.length;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return collapsedCursor + remaining;
    }
    remaining -= segmentLength;
    collapsedCursor += segmentLength;
  }

  return collapsedCursor;
}

// ── Slash commands, triggers & command menu ────────────────────────────────

export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      return {
        query: commandMatch[1] ?? "",
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  return null;
}

/** Caret and trigger after replacing composer text and continuing at the end. */
export function composerStateAtPromptEnd(text: string) {
  return {
    cursor: collapseExpandedComposerCursor(text, text.length),
    trigger: detectComposerTrigger(text, text.length),
  };
}

/** A message that is nothing but a slash command, which runs instead of being sent. */
export function parseStandaloneComposerSlashCommand(text: string): ComposerSlashCommand | null {
  const command = /^\/(new|compact)\s*$/i.exec(text.trim())?.[1]?.toLowerCase();
  return command === "new" || command === "compact" ? command : null;
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}

/** Commands whose name contains `query`, then those whose description does. */
export function searchSlashCommandItems(
  items: ReadonlyArray<ComposerCommandItem>,
  query: string,
): ComposerCommandItem[] {
  const byName = items.filter((item) => item.command.includes(query));
  return [
    ...byName,
    ...items.filter(
      (item) => !byName.includes(item) && item.description.toLowerCase().includes(query),
    ),
  ];
}

// ── List continuation & indentation ────────────────────────────────────────

export interface PromptTextEdit {
  /** Expanded (plain string) offsets into the prompt. */
  start: number;
  end: number;
  replacement: string;
}

function parseListMarker(line: string): { markerEnd: number; nextMarker: string } | null {
  const indent = line.match(/^[ \t]*/)?.[0] ?? "";
  const rest = line.slice(indent.length);
  const ordered = rest.match(/^(\d+)([.)])(?:[ \t]+|\s*$)/);
  if (ordered?.[1] && ordered[2]) {
    const number = Number.parseInt(ordered[1], 10);
    const next = Number.isSafeInteger(number)
      ? String(number + 1).padStart(ordered[1].length, "0")
      : ordered[1];
    return {
      markerEnd: indent.length + ordered[0].length,
      nextMarker: `${indent}${next}${ordered[2]} `,
    };
  }
  const bullet = rest.match(/^([-*+])(?:[ \t]+|\s*$)/);
  if (bullet?.[1]) {
    return {
      markerEnd: indent.length + bullet[0].length,
      nextMarker: `${indent}${bullet[1]} `,
    };
  }
  return null;
}

/** True when splitting at the caret would cut an inline chip in two. */
function isInsideInlineToken(lineText: string, lineCursor: number): boolean {
  let offset = 0;
  for (const segment of parseInlineTokens(lineText)) {
    const length = segment.type === "text" ? segment.text.length : segment.source.length;
    const end = offset + length;
    if (segment.type !== "text" && lineCursor > offset && lineCursor < end) return true;
    offset = end;
  }
  return false;
}

function getLineAtCursor(
  value: string,
  cursor: number,
): { start: number; end: number; text: string } {
  const start = value.lastIndexOf("\n", cursor - 1) + 1;
  const endIndex = value.indexOf("\n", cursor);
  const end = endIndex === -1 ? value.length : endIndex;
  return { start, end, text: value.slice(start, end) };
}

/**
 * Enter on a list item line: continue the list, or exit it when the item is
 * empty. Returns null for non-list lines, carets inside the marker, and
 * carets inside an inline chip — all fall through to a plain newline.
 */
export function continueListOnEnter(value: string, cursor: number): PromptTextEdit | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > value.length) return null;
  const line = getLineAtCursor(value, cursor);
  const parsed = parseListMarker(line.text);
  if (!parsed) return null;
  const markerEnd = line.start + parsed.markerEnd;
  if (cursor < markerEnd) return null;
  if (isInsideInlineToken(line.text, cursor - line.start)) return null;
  if (value.slice(markerEnd, line.end).trim() === "") {
    // Empty item: Enter exits the list by removing the marker.
    return { start: line.start, end: Math.max(cursor, markerEnd), replacement: "" };
  }
  return {
    start: cursor,
    end: cursor,
    replacement: `\n${parsed.nextMarker}`,
  };
}

/** Tab on a list item line: indent by two spaces. Non-list lines and carets inside an inline chip fall through. */
export function indentListOnTab(value: string, cursor: number): PromptTextEdit | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > value.length) return null;
  const line = getLineAtCursor(value, cursor);
  if (!parseListMarker(line.text)) return null;
  if (isInsideInlineToken(line.text, cursor - line.start)) return null;
  return { start: line.start, end: line.start, replacement: "  " };
}

// ── Prompt history ─────────────────────────────────────────────────────────

/** A member's message the composer recalls. */
export interface ComposerPromptHistoryMessage {
  readonly id: string;
  readonly text: string;
}

export interface ComposerPromptHistoryEntry {
  readonly id: string;
  readonly prompt: string;
}

/**
 * Active recall. `entryId` is resolved against the current entries on every
 * step, so an older page loading cannot move the position. `recalled` is the text put in the
 * composer; once the composer no longer matches it, the user has edited or
 * sent and browsing is over.
 */
export interface ComposerPromptHistoryPosition {
  readonly entryId: string;
  readonly recalled: string;
}

export interface ComposerPromptHistoryStep {
  readonly position: ComposerPromptHistoryPosition | null;
  readonly prompt: string;
}

function findActiveHistoryIndex(
  entries: ReadonlyArray<ComposerPromptHistoryEntry>,
  position: ComposerPromptHistoryPosition,
): number {
  const byId = entries.findIndex((entry) => entry.id === position.entryId);
  if (byId >= 0) return byId;
  return entries.findLastIndex((entry) => entry.prompt === position.recalled);
}

/** Reduce a sent message to the text the user typed. */
export function recallableComposerPrompt(messageText: string): string {
  // Recall is text-only: never create dangling chips without their backing records.
  return removeContextReferences(messageText.trim()).trim();
}

/**
 * Oldest first. Consecutive identical prompts collapse into the newest one,
 * matching shell `HISTCONTROL=ignoredups`. Image-only sends have no text and
 * are skipped.
 */
export function buildComposerPromptHistoryEntries(
  messages: ReadonlyArray<ComposerPromptHistoryMessage>,
): ComposerPromptHistoryEntry[] {
  const entries: ComposerPromptHistoryEntry[] = [];
  for (const message of messages) {
    const prompt = recallableComposerPrompt(message.text);
    if (prompt.length === 0) continue;
    const previous = entries[entries.length - 1];
    if (previous && previous.prompt === prompt) {
      entries[entries.length - 1] = { id: message.id, prompt };
      continue;
    }
    entries.push({ id: message.id, prompt });
  }
  return entries;
}

/**
 * Returns null when the key should fall through to normal caret movement.
 * Backward starts only from an empty composer and stops at the oldest entry.
 * Forward past the newest entry empties the composer and ends browsing. An
 * edited or sent recall no longer matches `recalled`, so browsing restarts
 * from scratch on the next backward step.
 */
export function stepComposerPromptHistory(input: {
  readonly direction: "backward" | "forward";
  readonly entries: ReadonlyArray<ComposerPromptHistoryEntry>;
  readonly position: ComposerPromptHistoryPosition | null;
  readonly currentPrompt: string;
}): ComposerPromptHistoryStep | null {
  const { entries, position, currentPrompt } = input;
  const activeIndex =
    position && position.recalled === currentPrompt
      ? findActiveHistoryIndex(entries, position)
      : -1;

  if (input.direction === "backward") {
    if (activeIndex < 0 && currentPrompt.length > 0) return null;
    const entry = entries[activeIndex < 0 ? entries.length - 1 : activeIndex - 1];
    if (!entry) return null;
    return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
  }

  if (activeIndex < 0) return null;
  const entry = entries[activeIndex + 1];
  if (!entry) return { position: null, prompt: "" };
  return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
}

// ── Submission validation ──────────────────────────────────────────────────

export function getComposerPromptLengthValidationMessage(prompt: string): string | null {
  const normalizedPrompt = prompt.trim();
  const excessCharacters = normalizedPrompt.length - MESSAGE_MAX_INPUT_CHARS;
  if (excessCharacters <= 0) return null;

  const characterLabel = excessCharacters === 1 ? "character" : "characters";
  return `Prompt is ${excessCharacters.toLocaleString("en-US")} ${characterLabel} over the ${MESSAGE_MAX_INPUT_CHARS.toLocaleString("en-US")}-character limit. Shorten or split it before sending.`;
}
