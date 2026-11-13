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
    <div role="status" className="flex min-w-0 flex-col gap-0.5 text-xs">
      {isRunning ? (
        <>
          <p className="text-muted-foreground">
            <span className="font-medium">Latest reported activity</span> · {updated}
          </p>
          <p className="flex gap-1.5 text-foreground">
            <span
              aria-hidden
              className="mt-1 size-2 shrink-0 animate-breathe rounded-full bg-info"
            />
            <span className="min-w-0 wrap-break-word">{report.message}</span>
          </p>
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
