import { CatchBoundary, type ErrorComponentProps } from "@tanstack/react-router";
import { type ReactNode, Suspense } from "react";

import { LoadFailed } from "../state/query";
import { Button } from "./ui/button";
import { ErrorText } from "./ui/error-text";

export function LoadPending({ label = "Loading…" }: { readonly label?: string }) {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {label}
    </p>
  );
}

function LoadError({ error, reset }: ErrorComponentProps) {
  if (!(error instanceof LoadFailed)) throw error;
  return (
    <div className="flex flex-col items-start gap-3">
      <ErrorText text={error.message} />
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          error.retry();
          reset();
        }}
      >
        Try again
      </Button>
    </div>
  );
}

export const PaddedPending = () => (
  <div className="p-6">
    <LoadPending />
  </div>
);

export const PaddedError = (props: ErrorComponentProps) => (
  <div className="p-6">
    <LoadError {...props} />
  </div>
);

export function Loading({
  children,
  padded = false,
}: {
  readonly children: ReactNode;
  readonly padded?: boolean;
}) {
  return (
    <CatchBoundary getResetKey={() => "loading"} errorComponent={padded ? PaddedError : LoadError}>
      <Suspense fallback={padded ? <PaddedPending /> : <LoadPending />}>{children}</Suspense>
    </CatchBoundary>
  );
}
