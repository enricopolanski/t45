import { createFileRoute } from "@tanstack/react-router";

import { CollectionEditor } from "../components/collections/CollectionEditor";
import { requireAdmin } from "../http/auth";

function EditCollectionRouteView() {
  const { collectionId } = Route.useParams();
  return <CollectionEditor key={collectionId} collectionId={collectionId} />;
}

export const Route = createFileRoute("/settings_/collections/$collectionId_/edit")({
  beforeLoad: requireAdmin,
  component: EditCollectionRouteView,
});
