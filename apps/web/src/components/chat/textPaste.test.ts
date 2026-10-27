import { describe, expect, it } from "vite-plus/test";

import {
  nextPastedTextFileName,
  PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES,
  isPasteAsTextShortcut,
  shouldAttachPastedText,
  wouldTextPasteExceedLimit,
} from "./textPaste";

describe("shouldAttachPastedText", () => {
  const paste = { bypassAutoAttachment: false, wouldExceedInputLimit: false };

  it("keeps ordinary text inline and attaches at the 32 KiB boundary", () => {
    expect(
      shouldAttachPastedText({
        ...paste,
        text: "x".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES - 1),
      }),
    ).toBe(false);
    expect(
      shouldAttachPastedText({
        ...paste,
        text: "x".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES),
      }),
    ).toBe(true);
  });

  it("measures UTF-8 bytes instead of UTF-16 characters", () => {
    const text = "🙂".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES / 4);
    expect(text.length).toBeLessThan(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES);
    expect(shouldAttachPastedText({ ...paste, text })).toBe(true);
  });

  it("keeps text inline for the paste-as-text shortcut", () => {
    const text = "x".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES);
    expect(shouldAttachPastedText({ ...paste, text, bypassAutoAttachment: true })).toBe(false);
  });

  it("attaches a smaller paste when the resulting prompt would exceed the input limit", () => {
    expect(
      shouldAttachPastedText({ ...paste, text: "small paste", wouldExceedInputLimit: true }),
    ).toBe(true);
  });
});

describe("pasted text attachment names", () => {
  it("uses the first available readable sequence", () => {
    expect(nextPastedTextFileName([])).toBe("pasted-text.txt");
    expect(nextPastedTextFileName(["PASTED-TEXT.TXT", "pasted-text-2.txt"])).toBe(
      "pasted-text-3.txt",
    );
  });
});

describe("paste-as-text shortcut", () => {
  it.each([
    { metaKey: true, ctrlKey: false, macPlatform: true },
    { metaKey: false, ctrlKey: true, macPlatform: false },
  ])("accepts the platform modifier with Shift", ({ metaKey, ctrlKey, macPlatform }) => {
    expect(
      isPasteAsTextShortcut(
        {
          key: "V",
          metaKey,
          ctrlKey,
          shiftKey: true,
          altKey: false,
        },
        macPlatform,
      ),
    ).toBe(true);
  });

  it("does not claim ordinary or alternate paste chords", () => {
    expect(
      isPasteAsTextShortcut(
        {
          key: "v",
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
        },
        true,
      ),
    ).toBe(false);
    expect(
      isPasteAsTextShortcut(
        {
          key: "v",
          metaKey: true,
          ctrlKey: false,
          shiftKey: true,
          altKey: true,
        },
        true,
      ),
    ).toBe(false);
  });

  it("rejects the other platform's modifier", () => {
    const event = {
      key: "v",
      metaKey: false,
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
    };
    expect(isPasteAsTextShortcut(event, true)).toBe(false);
    expect(isPasteAsTextShortcut({ ...event, metaKey: true, ctrlKey: false }, false)).toBe(false);
  });
});

describe("wouldTextPasteExceedLimit", () => {
  it("measures the replacement value after removing the selected range", () => {
    expect(
      wouldTextPasteExceedLimit({
        valueLength: 100,
        selection: { start: 40, end: 80 },
        textLength: 30,
        maxLength: 100,
      }),
    ).toBe(false);
    expect(
      wouldTextPasteExceedLimit({
        valueLength: 100,
        selection: { start: 40, end: 80 },
        textLength: 41,
        maxLength: 100,
      }),
    ).toBe(true);
  });
});
