import { createFileRoute } from "@tanstack/react-router";
import { WorkflowSteps } from "../components/workflows/WorkflowSteps";
function StepsRouteView() {
  const { definitionId } = Route.useParams();
  const { step } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <WorkflowSteps
      key={definitionId}
      definitionId={definitionId}
      openStepKey={step ?? null}
      onOpenStep={(key) => void navigate({ search: key === null ? {} : { step: key } })}
    />
  );
}
export const Route = createFileRoute("/settings_/workflow-blueprints/$definitionId/steps")({
  validateSearch: (search: Record<string, unknown>): { step?: string } =>
    typeof search.step === "string" ? { step: search.step } : {},
  component: StepsRouteView,
});
