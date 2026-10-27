"use client";

import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";

const BACKDROP_CLASS =
  "fixed inset-0 z-50 transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0";
const VIEWPORT_CLASS = "fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4";
const POPUP_CLASS =
  "-translate-y-[calc(1.25rem*var(--nested-dialogs))] relative row-start-2 flex min-h-0 w-full min-w-0 scale-[calc(1-0.1*var(--nested-dialogs))] flex-col text-popover-foreground opacity-[calc(1-0.1*var(--nested-dialogs))] outline-none transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform data-nested:data-ending-style:translate-y-8 data-nested:data-starting-style:translate-y-8 data-nested-dialog-open:origin-top data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0";

// On phones the default popup docks to the bottom edge. Media opens from inside other overlays (a
// composer chip, a popover), so it sits above them.
const VARIANT_CLASSES = {
  default: {
    backdrop: cn("dialog-backdrop", BACKDROP_CLASS),
    viewport: cn(VIEWPORT_CLASS, "max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12"),
    popup: cn(
      "dialog-glass",
      POPUP_CLASS,
      "max-h-full max-w-lg rounded-2xl border max-sm:max-w-none max-sm:rounded-none max-sm:border-x-0 max-sm:border-t max-sm:border-b-0 max-sm:opacity-[calc(1-min(var(--nested-dialogs),1))] max-sm:data-ending-style:translate-y-4 max-sm:data-starting-style:translate-y-4",
    ),
  },
  media: {
    backdrop: cn(BACKDROP_CLASS, "z-[60] bg-black/75 backdrop-blur-none"),
    viewport: cn(VIEWPORT_CLASS, "z-[60] grid-rows-1 place-items-center px-4 py-6"),
    popup: cn(
      POPUP_CLASS,
      "row-start-1 max-h-[92vh] w-[92vw] items-center overflow-visible rounded-none border border-transparent bg-transparent p-0 shadow-none [--media-height:min(86vh,calc(100vh-160px))] [--media-width:92vw] sm:[--media-width:calc(92vw-96px)]",
    ),
  },
};

const Dialog = DialogPrimitive.Root;

const AlertDialog = AlertDialogPrimitive.Root;

function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/** `media` shows an image on a dark backdrop, without the card, close button or phone docking. */
function DialogPopup({
  className,
  children,
  variant = "default",
  closeButton = variant === "default",
  ...props
}: DialogPrimitive.Popup.Props & { variant?: "default" | "media"; closeButton?: boolean }) {
  const classes = VARIANT_CLASSES[variant];
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        forceRender
        className={classes.backdrop}
        data-slot="dialog-backdrop"
      />
      <DialogPrimitive.Viewport className={classes.viewport} data-slot="dialog-viewport">
        <DialogPrimitive.Popup
          className={cn(classes.popup, className)}
          data-slot="dialog-popup"
          {...props}
        >
          {children}
          {closeButton ? (
            <DialogPrimitive.Close
              aria-label="Close"
              className="absolute end-2 top-2"
              render={<Button size="icon" variant="ghost" />}
            >
              <XIcon />
            </DialogPrimitive.Close>
          ) : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-3 max-sm:pb-4",
        className,
      )}
      data-slot="dialog-header"
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 border-t bg-muted/72 px-6 py-4 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)]",
        className,
      )}
      data-slot="dialog-footer"
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn("wrap-anywhere font-semibold text-xl leading-none", className)}
      data-slot="dialog-title"
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="dialog-description"
      {...props}
    />
  );
}

function DialogPanel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <ScrollArea scrollFade>
      <div
        className={cn(
          "space-y-4 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-1",
          className,
        )}
        data-slot="dialog-panel"
        {...props}
      />
    </ScrollArea>
  );
}

export {
  AlertDialog,
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogPopup,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogPanel,
};
