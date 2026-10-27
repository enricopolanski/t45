import { createFileRoute } from "@tanstack/react-router";

import { StepPage } from "../components/work/StepPage";

function StepRouteView() {
  const { stepId } = Route.useParams();
  return <StepPage key={stepId} stepId={stepId} />;
}

export const Route = createFileRoute("/my-work/$stepId")({
  component: StepRouteView,
});
