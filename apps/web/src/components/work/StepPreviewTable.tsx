import { PREVIEW_ROW_LABEL } from "@t45/contracts/models/StepPreview";
import type { StepPreview } from "@t45/contracts/resources/Workflows";
import { useLocale, useTranslation } from "~/i18n/locale";

import { ImageIcon } from "lucide-react";
import { useState } from "react";
import { attachmentUrl } from "../../lib/attachmentUrl";
import { StepResultHistory, formatStepResultValue } from "./StepResultHistory";

type Preview = Extract<StepPreview, { type: "table" }>;

function ResultThumbnail({
  file,
}: {
  readonly file: Preview["rows"][number]["thumbnail"] | undefined;
}) {
  const [failed, setFailed] = useState<string>();
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-white sm:size-11"
      aria-hidden="true"
    >
      {file && file.id !== failed ? (
        <img
          loading="lazy"
          className="size-full object-contain"
          src={attachmentUrl(file)}
          alt=""
          onError={() => setFailed(file.id)}
        />
      ) : (
        <ImageIcon className="size-4 text-muted-foreground" />
      )}
    </span>
  );
}

export function StepPreviewTable({ preview }: { readonly preview: Preview }) {
  const t = useTranslation();
  const locale = useLocale();
  if (preview.rows.length === 0)
    return <p className="text-sm text-muted-foreground">{t("No result")}</p>;
  return (
    <div className="card overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{preview.stepName}</caption>
        <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
          <tr>
            {preview.columns.map(({ id, label, hint }) => (
              <th key={id} scope="col" className="px-3 py-3 font-medium sm:px-5">
                {label || (id === PREVIEW_ROW_LABEL ? t("Name") : id)}
                {hint && <span className="block font-normal">{hint}</span>}
              </th>
            ))}
            <th scope="col" className="w-10">
              <span className="sr-only">{t("Result history")}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {preview.rows.map((row) => (
            <tr key={row.key}>
              {preview.columns.map(({ id }) => {
                if (id === PREVIEW_ROW_LABEL)
                  return (
                    <th
                      key={id}
                      scope="row"
                      className="w-2/5 px-3 py-4 text-start font-medium sm:px-5"
                    >
                      <div className="flex items-center gap-2.5">
                        <ResultThumbnail file={row.thumbnail} />
                        <span className="min-w-0 break-words">{row.label}</span>
                      </div>
                    </th>
                  );
                const cell = Object.hasOwn(row.cells, id) ? row.cells[id] : undefined;
                return (
                  <td key={id} className="px-3 py-4 tabular-nums sm:px-5">
                    {cell && (cell.values.length > 0 || cell.note) ? (
                      <>
                        <span className="inline-flex flex-wrap items-baseline gap-x-2">
                          {cell.values.map((value, index) => (
                            <span
                              key={value.id}
                              className={index === 0 ? "font-medium" : "text-muted-foreground"}
                            >
                              {formatStepResultValue(value, locale, preview.labels)}
                            </span>
                          ))}
                        </span>
                        {cell.note && (
                          <span className="block text-xs text-muted-foreground">{cell.note}</span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                );
              })}
              <td className="px-2 py-3 text-end">
                <StepResultHistory
                  ticketId={preview.ticketId}
                  stepDefinitionId={preview.stepDefinitionId}
                  resultKey={row.key}
                  labels={preview.labels}
                  label={row.label}
                  latestId={row.historyId}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
