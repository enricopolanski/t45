import type { Report } from "@t45/contracts/models/Chat";
import * as DateTime from "effect/DateTime";

import { useNowSecond } from "../hooks/useNowSecond";
import { formatRelativeSecondsLabel, formatRelativeTimeLabel } from "../timestampFormat";

export function ProgressReport({
  report,
  isRunning = false,
}: {
  readonly report: Report | null;
  readonly isRunning?: boolean;
}) {
  const now = useNowSecond();
  if (report === null) return null;
  const updated = (
    <time dateTime={DateTime.formatIso(report.at)} className="text-muted-foreground">
      Updated{" "}
      {isRunning
        ? formatRelativeSecondsLabel(report.at, now)
        : formatRelativeTimeLabel(report.at, now)}
    </time>
  );
  return (
    <div role="status" className="flex min-w-0 flex-col gap-1 text-xs">
      {isRunning ? (
        <>
          <p className="flex gap-2 text-foreground">
            <span aria-hidden className="flex h-4 w-4 shrink-0 items-center justify-center">
              <span className="size-2 animate-breathe rounded-full bg-info" />
            </span>
            <span className="min-w-0 wrap-break-word">{report.message}</span>
          </p>
          <p className="pl-6">{updated}</p>
        </>
      ) : (
        <>
          <p className="wrap-break-word text-foreground">{report.message}</p>
          {updated}
        </>
      )}
    </div>
  );
}
