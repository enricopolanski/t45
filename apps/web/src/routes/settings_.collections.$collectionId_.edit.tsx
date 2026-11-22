import { createFileRoute } from "@tanstack/react-router";

import { CollectionEditor } from "../components/collections/CollectionEditor";
import { requireAdmin } from "../http/auth";

function EditCollectionRouteView() {
  const { collectionId } = Route.useParams();
  const { subcollection } = Route.useSearch();
  return subcollection === undefined ? (
    <CollectionEditor key={collectionId} collectionId={collectionId} />
  ) : (
    <CollectionEditor
      key={`${collectionId}/${subcollection}`}
      collectionId={subcollection}
      parentCollectionId={collectionId}
    />
  );
}

export const Route = createFileRoute("/settings_/collections/$collectionId_/edit")({
  beforeLoad: requireAdmin,
  validateSearch: (search: Record<string, unknown>): { subcollection?: string } =>
    typeof search.subcollection === "string" ? { subcollection: search.subcollection } : {},
  component: EditCollectionRouteView,
});
