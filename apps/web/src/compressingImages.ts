import { create } from "zustand";

/**
 * Pasted or dropped images still being compressed, per composer draft key. They hold the draft's
 * send and reserve attachment slots so concurrent pastes can't overshoot the limit. Forgetting a
 * key drops its images when they finish.
 */
export const useCompressingImages = create<{ counts: Record<string, number> }>(() => ({
  counts: {},
}));

export const compressingImageCount = (key: string) =>
  useCompressingImages.getState().counts[key] ?? 0;

export function changeCompressingImages(key: string, delta: number): void {
  useCompressingImages.setState(({ counts }) => {
    const { [key]: count = 0, ...rest } = counts;
    return { counts: count + delta > 0 ? { ...rest, [key]: count + delta } : rest };
  });
}

export function forgetCompressingImages(key: string): void {
  useCompressingImages.setState(({ counts }) => {
    const { [key]: _forgotten, ...rest } = counts;
    return { counts: rest };
  });
}
