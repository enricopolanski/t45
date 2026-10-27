import type { ChatId } from "@t45/contracts/models/Chat";
import { type RefObject, useEffect } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import type { ChatComposerHandle } from "./ChatComposer";

const TYPE_TO_FOCUS_EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");
const TYPE_TO_FOCUS_INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
].join(",");
// Popups (tooltips aside) match while open or closing, so one in its exit animation still counts.
const TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR = [
  '[role="dialog"][aria-modal="true"]',
  '[data-slot$="-popup"]:not([data-slot="tooltip-popup"]):is([data-open],[data-ending-style])',
  '[data-slot="sidebar"][data-mobile="true"]:is([data-open],[data-ending-style])',
].join(",");

function eventPathContainsSelector(event: Event, selector: string): boolean {
  return event
    .composedPath()
    .some((target) => target instanceof Element && target.closest(selector));
}

/**
 * Whether input that landed outside any editable or interactive element
 * should be redirected into the composer. Shared by type-to-focus and
 * paste-to-focus so both honour the same surfaces.
 */
function shouldRedirectInputToComposer(event: Event): boolean {
  if (event.defaultPrevented) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_INTERACTIVE_SELECTOR)) return false;
  if (document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)) return false;
  return true;
}

function shouldTypeToFocusComposer(event: KeyboardEvent): boolean {
  if (event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key.length !== 1) return false;
  return shouldRedirectInputToComposer(event);
}

/**
 * Plain text pasted with nothing editable focused, such as after the resting
 * composer blurred. Files are left to the composer's own paste handler.
 */
function pasteTextToFocusComposer(event: ClipboardEvent): string | null {
  if (!event.clipboardData || event.clipboardData.files.length > 0) return null;
  if (!shouldRedirectInputToComposer(event)) return null;
  const text = event.clipboardData.getData("text/plain");
  return text.length > 0 ? text : null;
}

/**
 * Returning to the window lands the caret in the composer, except where focus is deliberate:
 * another text field, an iframe, or an open dialog or popup.
 */
function shouldRefocusComposerOnWindowFocus(active: Element | null): boolean {
  if (active === null || active.tagName === "BODY") return true;
  return (
    active.tagName !== "IFRAME" &&
    active.closest(
      `${TYPE_TO_FOCUS_EDITABLE_SELECTOR},[role="dialog"],[role="alertdialog"],[data-slot$="-popup"]`,
    ) === null
  );
}

export function useComposerFocus(
  composerRef: RefObject<ChatComposerHandle | null>,
  chatId: ChatId,
) {
  const isMobileViewport = useMediaQuery("max-sm");
  // Opening another chat puts the caret in its composer.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => composerRef.current?.focusAtEnd());
    return () => window.cancelAnimationFrame(frame);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the chat id is the trigger
  }, [composerRef, chatId]);
  // Tabbing back into the app puts the caret in the composer unless something that takes
  // typing holds focus. Mobile is left alone so returning to the app does not raise the keyboard.
  useEffect(() => {
    if (isMobileViewport) return;
    let frame: number | null = null;
    const onWindowFocus = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      // The composer ignores the frame focus is restored in, so wait one more.
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          if (shouldRefocusComposerOnWindowFocus(document.activeElement)) {
            composerRef.current?.focusAtEnd();
          }
        });
      });
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [composerRef, isMobileViewport]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldTypeToFocusComposer(event)) return;
      if (composerRef.current?.insertTextAtEnd(event.key)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    // The resting composer blurs on a click into the timeline, so a paste that follows has no
    // editable target; it goes to the composer like a typed key.
    const onPaste = (event: ClipboardEvent) => {
      const text = pasteTextToFocusComposer(event);
      if (text === null) return;
      if (composerRef.current?.pasteTextAtEnd(text) || composerRef.current?.insertTextAtEnd(text)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("paste", onPaste, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("paste", onPaste, true);
    };
  }, [composerRef]);
}
