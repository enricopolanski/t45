import { createFileRoute, Navigate } from "@tanstack/react-router";

import { StepPreviewTable } from "../components/work/StepPreviewTable";
import { StepResultHistory } from "../components/work/StepResultHistory";
import { ReadOnlyStepFieldCard } from "../components/work/StepInputs";
import { BackLink, WorkFrame } from "../components/work/WorkFrame";
import { ErrorText } from "../components/ui/error-text";
import { useTranslation } from "../i18n/locale";
import { apiWatch, useApiQuery } from "../state/rpc";

const previews = apiWatch("workflows.watchStepPreview", { idleTtlMs: 0 });

function StepPreviewPage() {
  const t = useTranslation();
  const { ticketId, stepDefinitionId } = Route.useParams();
  const { data, error } = useApiQuery(previews({ ticketId, stepDefinitionId }));
  if (!error && data?.type === "entered") {
    return <Navigate to="/my-work/$stepId" params={{ stepId: data.stepId }} replace />;
  }
  const preview = data && data.type !== "entered" ? data : null;
  return (
    <WorkFrame
      title={t("Preliminary results")}
      tabTitle={preview?.ticketTitle ?? t("Preliminary results")}
      width="full"
      contentClassName="p-6"
    >
      {error ? (
        <ErrorText text={error} />
      ) : preview ? (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
          {preview.sourceStepId ? (
            <BackLink to="/my-work/$stepId" params={{ stepId: preview.sourceStepId }}>
              {t("Back to current step")}
            </BackLink>
          ) : (
            <BackLink to="/boards">{t("Boards")}</BackLink>
          )}
          <div>
            <p className="text-sm text-muted-foreground">{preview.ticketTitle}</p>
            <h1 className="text-2xl font-semibold">{preview.stepName}</h1>
          </div>
          {preview.type === "fields" && preview.history && (
            <div className="self-end">
              <StepResultHistory
                ticketId={preview.ticketId}
                stepDefinitionId={preview.stepDefinitionId}
                resultKey={preview.history.key}
                label={preview.stepName}
                labels={preview.history.labels}
                latestId={preview.history.latestId}
                showLabel
              />
            </div>
          )}
          {preview.type === "fields" ? (
            preview.fields.length > 0 ? (
              <ReadOnlyStepFieldCard
                title={t("Fields")}
                fields={preview.fields}
                reviews={[]}
                defaultOpen
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t("No fields.")}</p>
            )
          ) : (
            <StepPreviewTable preview={preview} />
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
      )}
    </WorkFrame>
  );
}
export const Route = createFileRoute("/my-work/preview/$ticketId/$stepDefinitionId")({
  component: StepPreviewPage,
});
