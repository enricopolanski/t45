"use client";

import { Toast } from "@base-ui/react/toast";
import type { CSSProperties, ReactNode } from "react";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { ErrorDetailCopyButton, ErrorDetailText } from "./error-detail-text";
import { buildToastLayout } from "./toast.logic";

type ToastData = {
  /** Error toasts offer to copy their description unless it is guidance rather than a failure. */
  hideCopyButton?: boolean;
};

const toastManager = Toast.createToastManager<ToastData>();

const TOAST_ICONS = {
  error: CircleAlertIcon,
  info: InfoIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
} as const;

function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider toastManager={toastManager}>
      {children}
      <Toasts />
    </Toast.Provider>
  );
}

/** The stack in the top-right corner: newest in front, the rest peeking behind until hovered. */
function Toasts() {
  const { toasts } = Toast.useToastManager<ToastData>();
  const layout = buildToastLayout(toasts);

  return (
    <Toast.Portal>
      <Toast.Viewport
        className="fixed top-[calc(var(--toast-inset)+var(--page-header-height))] right-(--toast-inset) z-100 flex w-[calc(100%-var(--toast-inset)*2)] max-w-md [--toast-inset:--spacing(4)] sm:max-w-lg sm:[--toast-inset:--spacing(8)] md:max-w-xl"
        style={{ "--toast-frontmost-height": `${layout.frontmostHeight}px` } as CSSProperties}
      >
        {layout.items.map(({ toast, index, offsetY }) => {
          const isError = toast.type === "error";
          // Errors stay full size and legible wherever they sit in the stack.
          const behind = index > 0 && !isError;
          const Icon = toast.type ? TOAST_ICONS[toast.type as keyof typeof TOAST_ICONS] : null;
          const errorText =
            isError && typeof toast.description === "string" && toast.description.trim()
              ? toast.description
              : null;
          const copyText = toast.data?.hideCopyButton ? null : errorText;
          const hasAction = toast.actionProps !== undefined;

          return (
            <Toast.Root
              className={cn(
                "dropdown-glass absolute top-0 right-0 z-[calc(9999-var(--toast-index))] w-full origin-top overflow-visible select-none rounded-lg text-popover-foreground shadow-xl shadow-black/25",
                isError && "min-w-[min(100%,20rem)] text-destructive-foreground",
                // A collapsed toast behind the front one is cut to the front one's height.
                behind && "not-data-expanded:h-(--toast-frontmost-height)",
              )}
              data-slot="toast"
              key={toast.id}
              style={
                { "--toast-index": index, "--toast-offset-y": `${offsetY}px` } as CSSProperties
              }
              swipeDirection={["right", "up"]}
              toast={toast}
            >
              <Toast.Close
                aria-label="Dismiss notification"
                className="absolute -top-1.5 -right-1.5 z-20 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-popover/92 text-muted-foreground shadow-sm outline-none backdrop-blur-sm transition-[color,background-color,box-shadow] hover:bg-popover hover:text-foreground focus-ring"
              >
                <XIcon className="size-3" strokeWidth={2.25} />
              </Toast.Close>
              <Toast.Content
                className={cn(
                  "pointer-events-auto min-h-0 pl-3.5 text-sm transition-opacity duration-250 data-expanded:opacity-100",
                  // A toast with an action puts it on its own row under the text.
                  hasAction
                    ? "flex flex-col gap-2 py-2.5 pr-3.5"
                    : cn(
                        "flex items-center justify-between gap-1.5 py-3",
                        copyText === null ? "pr-10" : "pr-6",
                      ),
                  behind && "not-data-expanded:pointer-events-none not-data-expanded:opacity-0",
                )}
              >
                <div
                  className={cn(
                    "flex min-h-0 min-w-0 flex-col gap-0.5",
                    hasAction ? "pr-5" : "flex-1",
                  )}
                >
                  <div className="flex min-w-0 gap-2">
                    {Icon ? (
                      <div className="[&>svg]:h-lh [&>svg]:w-4 [&_svg]:pointer-events-none [&_svg]:shrink-0">
                        <Icon className="in-data-[type=error]:text-destructive in-data-[type=info]:text-info in-data-[type=success]:text-success in-data-[type=warning]:text-warning" />
                      </div>
                    ) : null}
                    <Toast.Title
                      className={cn(
                        "min-w-0 wrap-break-word font-medium leading-snug",
                        isError && "text-foreground",
                      )}
                    />
                  </div>
                  {errorText === null ? (
                    <Toast.Description className="min-w-0 select-text wrap-break-word text-muted-foreground" />
                  ) : (
                    <ErrorDetailText
                      showCopy={false}
                      text={errorText}
                      textClassName="text-muted-foreground"
                    />
                  )}
                </div>
                {copyText !== null || hasAction ? (
                  <div
                    className={cn(
                      "flex items-center gap-1.5",
                      hasAction ? "w-full justify-end" : "shrink-0",
                    )}
                  >
                    {copyText !== null ? <ErrorDetailCopyButton text={copyText} /> : null}
                    <Toast.Action render={<Button size="xs" className="shrink-0" />} />
                  </div>
                ) : null}
              </Toast.Content>
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export { ToastProvider, toastManager };
