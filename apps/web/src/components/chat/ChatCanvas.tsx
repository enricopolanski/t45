import {
  createContext,
  use,
  useLayoutEffect,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";

const RegisterTimeline = createContext<(element: HTMLElement | null) => void>(() => {});

/** Hands the canvas the timeline's scroll element. */
export const useRegisterTimeline = () => use(RegisterTimeline);

/**
 * The conversation's space. The timeline registers its scroll element so the canvas can keep
 * the chat centered when a classic scrollbar takes width from one side.
 */
export function ChatCanvas({
  children,
  ...props
}: Omit<ComponentProps<"div">, "className" | "style" | "ref">) {
  const [timelineElement, registerTimeline] = useState<HTMLElement | null>(null);
  const [timelineGutter, setTimelineGutter] = useState(0);
  useLayoutEffect(() => {
    if (!timelineElement) return;
    const measure = () =>
      setTimelineGutter((timelineElement.offsetWidth - timelineElement.clientWidth) / 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(timelineElement);
    return () => observer.disconnect();
  }, [timelineElement]);
  return (
    <RegisterTimeline value={registerTimeline}>
      <div
        {...props}
        data-chat-canvas
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        style={
          { "--chat-timeline-gutter": `${timelineElement ? timelineGutter : 0}px` } as CSSProperties
        }
      >
        {children}
      </div>
    </RegisterTimeline>
  );
}
