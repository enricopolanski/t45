import {
  Outlet,
  redirect,
  createRootRoute,
  type ErrorComponentProps,
  useLocation,
  useRouter,
} from "@tanstack/react-router";
import { Check, Copy } from "lucide";
import { useMemo } from "react";

import { BUILD_SHA } from "../lib/buildSha";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { MorphIcon } from "../components/MorphIcon";

import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { Button } from "../components/ui/button";
import { StandalonePage, StandalonePageHeader } from "../components/StandalonePage";
import { ToastProvider } from "../components/ui/toast";
import { cn } from "../lib/utils";
import { checkSignedOut, resolveInitialServerAuthGateState } from "../http/auth";
import { onAccessDenied } from "../rpc/api";
import { errorMessage } from "../lib/failures";

/** The one page each sign-in state short of admission may show. */
const GATE_PAGES = {
  "requires-auth": "/login",
  "awaiting-approval": "/awaiting-approval",
  onboarding: "/onboarding",
} as const;
const GATE_PATHS: ReadonlySet<string> = new Set(Object.values(GATE_PAGES));

onAccessDenied(() => void checkSignedOut());

export const Route = createRootRoute({
  // Every route's gate: anyone not yet admitted stays on their state's page, and an admitted
  // member leaving one goes through the root's landing.
  beforeLoad: async ({ location }) => {
    const authGateState = await resolveInitialServerAuthGateState();
    if (authGateState.status !== "authenticated") {
      const page = GATE_PAGES[authGateState.status];
      if (location.pathname !== page) throw redirect({ to: page, replace: true });
    } else if (GATE_PATHS.has(location.pathname)) {
      throw redirect({ to: "/", replace: true });
    }
    return { authGateState };
  },
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
});

function RootRouteView() {
  const { authGateState } = Route.useRouteContext();
  if (authGateState.status !== "authenticated") return <Outlet />;

  return (
    <ToastProvider>
      <AppSidebarLayout>
        <Outlet />
      </AppSidebarLayout>
    </ToastProvider>
  );
}

function RootRouteErrorView({ error }: ErrorComponentProps) {
  const router = useRouter();
  const message = errorMessage(error, "An unexpected router error occurred.");
  const pathname = useLocation({ select: (location) => location.pathname });
  const report = useMemo(() => errorReport(error, pathname), [error, pathname]);

  return (
    <StandalonePage>
      <StandalonePageHeader title="Something went wrong." description={message} />

      <div className="mt-5 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void router.invalidate()}>
          Try again
        </Button>
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          Reload app
        </Button>
        <CopyErrorButton report={report} />
      </div>

      <div className="mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
        <p className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Error report</p>
        <pre className="max-h-64 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs whitespace-pre-wrap text-foreground/85">
          {report}
        </pre>
      </div>
    </StandalonePage>
  );
}

/** Copies the full error report and swaps to a check mark for a moment as confirmation. */
function CopyErrorButton({ report }: { report: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  return (
    <Button size="sm" variant="outline" onClick={() => copyToClipboard(report)}>
      <MorphIcon className={cn(isCopied && "text-success")} icon={isCopied ? Check : Copy} />
      {isCopied ? "Copied" : "Copy error"}
    </Button>
  );
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

const MAX_ERROR_CAUSE_DEPTH = 5;

/**
 * Full error text for bug reports: app build, page path, time, then the stack
 * and any cause chain. Takes the pathname only so tokens in the query never
 * land on the clipboard.
 */
function errorReport(error: unknown, pathname: string): string {
  const lines = [
    `T45 ${BUILD_SHA}`,
    `Path: ${pathname}`,
    `Time: ${new Date().toISOString()}`,
    "",
    errorDetails(error),
  ];
  let cause = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    lines.push("", "Caused by:", errorDetails(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return lines.join("\n");
}
