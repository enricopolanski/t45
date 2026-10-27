export const PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES = 32 * 1024;

const textEncoder = new TextEncoder();

export function isPasteAsTextShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  macPlatform: boolean,
): boolean {
  return (
    event.key.toLowerCase() === "v" &&
    event.shiftKey &&
    !event.altKey &&
    (macPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  );
}

/**
 * Large clipboard text becomes a file so an agent can inspect it selectively.
 * The threshold is byte-based: character counts substantially understate the
 * context cost of some Unicode-heavy clipboard contents.
 */
export function shouldAttachPastedText(input: {
  readonly text: string;
  readonly bypassAutoAttachment: boolean;
  readonly wouldExceedInputLimit: boolean;
}): boolean {
  if (input.bypassAutoAttachment || input.text.length === 0) return false;
  return (
    input.wouldExceedInputLimit ||
    textEncoder.encode(input.text).byteLength >= PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES
  );
}

/** Stable, human-readable names when a draft contains several folded pastes. */
export function nextPastedTextFileName(existingNames: ReadonlyArray<string>): string {
  const names = new Set(existingNames.map((name) => name.toLowerCase()));
  if (!names.has("pasted-text.txt")) {
    return "pasted-text.txt";
  }
  for (let sequence = 2; ; sequence += 1) {
    const candidate = `pasted-text-${sequence}.txt`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }
}

export function wouldTextPasteExceedLimit(input: {
  readonly valueLength: number;
  readonly selection: { readonly start: number; readonly end: number };
  readonly textLength: number;
  readonly maxLength: number;
}): boolean {
  const start = Math.max(0, Math.min(input.valueLength, input.selection.start));
  const end = Math.max(start, Math.min(input.valueLength, input.selection.end));
  return input.valueLength - (end - start) + input.textLength > input.maxLength;
}
