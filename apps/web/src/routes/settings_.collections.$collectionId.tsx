import { createFileRoute } from "@tanstack/react-router";

import { CollectionPage } from "../components/collections/CollectionPage";

function CollectionRouteView() {
  const { collectionId } = Route.useParams();
  return <CollectionPage key={collectionId} collectionId={collectionId} />;
}

export const Route = createFileRoute("/settings_/collections/$collectionId")({
  component: CollectionRouteView,
});
