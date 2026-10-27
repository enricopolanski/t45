const animations = new Map<Element, HTMLElement | SVGElement>();
let observer: IntersectionObserver | null = null;

function setRunning(element: HTMLElement | SVGElement, running: boolean) {
  element.style.setProperty("--visible-animation-state", running ? "running" : "paused");
  element.style.setProperty("--visible-animation-will-change", running ? "transform" : "auto");
}

/** Attach to a stable animation container. All refs share one observer. */
export function observeVisibleAnimation(element: HTMLElement | SVGElement | null) {
  if (element === null) return;
  setRunning(element, false);
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const animation = animations.get(entry.target);
      if (animation) setRunning(animation, entry.isIntersecting);
    }
  });
  animations.set(element, element);
  observer.observe(element);
  return () => {
    animations.delete(element);
    observer?.unobserve(element);
    setRunning(element, false);
  };
}
