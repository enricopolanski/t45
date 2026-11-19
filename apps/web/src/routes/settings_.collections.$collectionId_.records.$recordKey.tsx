import { createFileRoute } from "@tanstack/react-router";

import { RecordPage } from "../components/collections/RecordPage";

function RecordRouteView() {
  const { collectionId, recordKey } = Route.useParams();
  return (
    <RecordPage
      key={`${collectionId}/${recordKey}`}
      collectionId={collectionId}
      recordKey={recordKey}
    />
  );
}

export const Route = createFileRoute("/settings_/collections/$collectionId_/records/$recordKey")({
  component: RecordRouteView,
});
