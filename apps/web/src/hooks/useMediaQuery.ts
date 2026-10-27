import { useCallback, useMemo, useSyncExternalStore } from "react";

/** Tailwind's `max-*` variants: narrower than its sm (640px) and md (768px) breakpoints. */
const MAX_WIDTH_QUERIES = {
  "max-sm": "(max-width: 639px)",
  "max-md": "(max-width: 767px)",
} as const;

export function useMediaQuery(query: keyof typeof MAX_WIDTH_QUERIES): boolean {
  const mediaQueryList = useMemo(() => window.matchMedia(MAX_WIDTH_QUERIES[query]), [query]);

  const subscribe = useCallback(
    (onChange: () => void) => {
      mediaQueryList.addEventListener("change", onChange);
      return () => mediaQueryList.removeEventListener("change", onChange);
    },
    [mediaQueryList],
  );

  return useSyncExternalStore(subscribe, () => mediaQueryList.matches);
}

export function useIsMobile(): boolean {
  return useMediaQuery("max-md");
}
