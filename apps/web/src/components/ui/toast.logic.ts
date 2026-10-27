type LayoutToast = {
  height?: number | undefined;
  transitionStatus?: "starting" | "ending" | undefined;
};

/**
 * Stack slots for Base UI's toasts, front first. A dismissed toast keeps the slot it had, so its
 * exit starts where it was seen, while the toasts behind it move up during that exit instead of
 * after it. The stack's collapsed height follows the front toast that stays.
 */
export function buildToastLayout<T extends LayoutToast>(toasts: readonly T[]) {
  let index = 0;
  let offsetY = 0;
  let liveIndex = 0;
  let liveOffsetY = 0;

  const items = toasts.map((toast) => {
    const height = toast.height ?? 0;
    const ending = toast.transitionStatus === "ending";
    const item = ending
      ? { toast, index, offsetY }
      : { toast, index: liveIndex, offsetY: liveOffsetY };
    index += 1;
    offsetY += height;
    if (!ending) {
      liveIndex += 1;
      liveOffsetY += height;
    }
    return item;
  });

  const front = toasts.find((toast) => toast.transitionStatus !== "ending");
  return { frontmostHeight: front?.height ?? 0, items };
}
