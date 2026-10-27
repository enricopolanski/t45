import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { PanelLeft, PanelLeftClose } from "lucide";
import * as React from "react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useIsMobile } from "~/hooks/useMediaQuery";

type SidebarContextProps = {
  isMobile: boolean;
  openMobile: boolean;
  setOpenMobile: React.Dispatch<React.SetStateAction<boolean>>;
};

const SidebarContext = React.createContext<SidebarContextProps | null>(null);

function useSidebar() {
  const context = React.use(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }

  return context;
}

function SidebarProvider({ children }: { children: React.ReactNode }) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);
  const contextValue = React.useMemo(
    () => ({ isMobile, openMobile, setOpenMobile }),
    [isMobile, openMobile],
  );

  return (
    <SidebarContext value={contextValue}>
      <div className="flex h-dvh min-h-0 w-full" data-slot="sidebar-wrapper">
        {children}
      </div>
    </SidebarContext>
  );
}

/**
 * Desktop widths keep the sidebar open; phone widths dock it to the left edge as a sheet. The
 * sheet's layer (--z-sheet) sits under dialogs that open from inside it.
 */
function Sidebar({ children, ...props }: React.ComponentProps<"div">) {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();

  if (isMobile) {
    return (
      <SheetPrimitive.Root onOpenChange={setOpenMobile} open={openMobile}>
        <SheetPrimitive.Portal>
          <SheetPrimitive.Backdrop className="fixed inset-0 z-(--z-sheet) bg-background/60 backdrop-blur-xs transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
          <SheetPrimitive.Viewport className="fixed inset-0 z-(--z-sheet) flex justify-start">
            <SheetPrimitive.Popup
              aria-label="Sidebar"
              className="relative flex max-h-full min-h-0 w-[calc(100vw-(--spacing(3)))] min-w-0 flex-col border-e bg-sidebar surface-grain bg-clip-padding text-sidebar-foreground shadow-lg/5 transition-[opacity,translate] duration-200 ease-in-out will-change-transform data-ending-style:-translate-x-8 data-starting-style:-translate-x-8 data-ending-style:opacity-0 data-starting-style:opacity-0"
              data-mobile="true"
              data-slot="sidebar"
            >
              <div className="flex h-full w-full flex-col pb-safe pt-safe pl-safe" {...props}>
                {children}
              </div>
            </SheetPrimitive.Popup>
          </SheetPrimitive.Viewport>
        </SheetPrimitive.Portal>
      </SheetPrimitive.Root>
    );
  }

  return (
    <div className="text-sidebar-foreground" data-slot="sidebar">
      {/* Holds the fixed sidebar's width in the page layout. */}
      <div className="w-(--sidebar-width)" data-slot="sidebar-gap" />
      <div
        className="fixed inset-y-0 left-0 z-10 flex h-svh w-(--sidebar-width) border-r"
        data-slot="sidebar-container"
        {...props}
      >
        <div
          className="flex h-full w-full flex-col bg-sidebar surface-grain"
          data-slot="sidebar-inner"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const { openMobile, setOpenMobile } = useSidebar();

  return (
    <Button
      className={cn("size-[var(--sidebar-toggle-size)]!", className)}
      data-slot="sidebar-trigger"
      aria-pressed={openMobile}
      onClick={(event) => {
        onClick?.(event);
        setOpenMobile((open) => !open);
      }}
      size="icon"
      variant="ghost"
      {...props}
    >
      <MorphIcon className="size-4" icon={openMobile ? PanelLeftClose : PanelLeft} />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      className={cn(
        "relative flex min-w-0 w-full flex-1 flex-col bg-background surface-grain",
        className,
      )}
      data-slot="sidebar-inset"
      {...props}
    />
  );
}

function SidebarFooter(props: React.ComponentProps<"div">) {
  return (
    <div
      className="flex flex-col gap-2 px-[var(--sidebar-content-inset)] py-1"
      data-slot="sidebar-footer"
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    // Rows take focus on click. Scroll padding would make the browser nudge the list whenever a
    // focused row sits under the fade.
    <ScrollArea
      hideScrollbars
      scrollFade
      scrollFadePadding={false}
      // Rows provide keyboard access to this scroll region. Keeping Base UI's viewport out of the
      // tab order lets its presentational role flatten in WebKit instead of becoming a VoiceOver
      // interaction group.
      viewportTabIndex={-1}
      className="h-auto min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]]:[--fade-size:0.75rem]"
    >
      <div
        className={cn(
          // Reordered rows must not pull the viewport to their new position.
          "flex w-full min-w-0 flex-col [overflow-anchor:none]",
          className,
        )}
        data-slot="sidebar-content"
        {...props}
      />
    </ScrollArea>
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative flex w-full min-w-0 flex-col p-[var(--sidebar-content-inset)]",
        className,
      )}
      data-slot="sidebar-group"
      {...props}
    />
  );
}

function SidebarMenu(props: React.ComponentProps<"ul">) {
  return <ul className="flex w-full min-w-0 flex-col gap-1" data-slot="sidebar-menu" {...props} />;
}

function SidebarMenuItem(props: React.ComponentProps<"li">) {
  return <li className="relative" data-slot="sidebar-menu-item" {...props} />;
}

function SidebarMenuButton({ render, ...props }: useRender.ComponentProps<"button">) {
  const defaultProps = {
    className:
      "flex h-8 w-full cursor-pointer items-center gap-[var(--sidebar-control-gap)] overflow-hidden rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] py-1.5 text-left font-medium text-sm text-sidebar-muted-foreground/80 outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 active:bg-sidebar-row-active active:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-64 aria-disabled:pointer-events-none aria-disabled:opacity-64 aria-[current=page]:bg-sidebar-row-selected aria-[current=page]:text-sidebar-foreground [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-[var(--sidebar-icon-color)] hover:[&>svg]:text-sidebar-foreground active:[&>svg]:text-sidebar-foreground aria-[current=page]:[&>svg]:text-sidebar-foreground",
    "data-slot": "sidebar-menu-button",
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

function SidebarMenuSub(props: React.ComponentProps<"ul">) {
  return (
    <ul
      className="mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-sidebar-border border-l px-2.5 py-0.5"
      data-slot="sidebar-menu-sub"
      {...props}
    />
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
};
