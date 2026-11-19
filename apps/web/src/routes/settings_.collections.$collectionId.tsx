import { createFileRoute } from "@tanstack/react-router";

import { CollectionPage } from "../components/collections/CollectionPage";

function CollectionRouteView() {
  const { collectionId } = Route.useParams();
  const { page } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <CollectionPage
      key={collectionId}
      collectionId={collectionId}
      page={page ?? 1}
      onPage={(next) => void navigate({ search: next === 1 ? {} : { page: next } })}
    />
  );
}

export const Route = createFileRoute("/settings_/collections/$collectionId")({
  validateSearch: (search: Record<string, unknown>): { page?: number } =>
    Number.isSafeInteger(search.page) && (search.page as number) > 1
      ? { page: search.page as number }
      : {},
  component: CollectionRouteView,
});
