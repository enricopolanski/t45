import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Copy fallback for remote web pages served over plain HTTP. */
function writeTextWithExecCommand(value: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  // Below 16px, iOS zooms in on the focused field.
  textarea.style.fontSize = "16px";

  const previouslyFocused = document.activeElement as HTMLOrSVGElement | null;
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    previouslyFocused?.focus();
  }
}

async function writeText(value: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  if (!writeTextWithExecCommand(value)) throw new Error("The clipboard isn't available here.");
}

export function useCopyToClipboard(
  options: { timeout?: number; onCopy?: () => void; onError?: () => void } = {},
) {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest options, for a copy that settles after this render.
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });

  const copyToClipboard = useCallback((value: string) => {
    if (!value) return;
    void writeText(value).then(
      () => {
        if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
        setIsCopied(true);
        optionsRef.current.onCopy?.();
        timeoutIdRef.current = setTimeout(() => {
          setIsCopied(false);
          timeoutIdRef.current = null;
        }, optionsRef.current.timeout ?? 2000);
      },
      (error: unknown) => {
        console.error(error);
        optionsRef.current.onError?.();
      },
    );
  }, []);

  useEffect(
    () => () => {
      if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
    },
    [],
  );

  return { copyToClipboard, isCopied };
}
