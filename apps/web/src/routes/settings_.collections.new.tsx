import { createFileRoute } from "@tanstack/react-router";

import { CollectionEditor } from "../components/collections/CollectionEditor";
import { requireAdmin } from "../http/auth";

export const Route = createFileRoute("/settings_/collections/new")({
  beforeLoad: requireAdmin,
  component: () => <CollectionEditor collectionId={null} />,
});
