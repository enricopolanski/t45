import type { Report } from "@t45/contracts/models/Chat";
import * as DateTime from "effect/DateTime";

import { useNowMinute } from "../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../timestampFormat";

export function ProgressReport({ report }: { readonly report: Report | null }) {
  const now = useNowMinute();
  if (report === null) return null;
  return (
    <div role="status" className="flex min-w-0 flex-col gap-0.5 text-xs">
      <p className="wrap-break-word text-foreground">{report.message}</p>
      <time dateTime={DateTime.formatIso(report.at)} className="text-muted-foreground">
        Updated {formatRelativeTimeLabel(report.at, now)}
      </time>
    </div>
  );
}
