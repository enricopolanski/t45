import { createFileRoute } from "@tanstack/react-router";

import { CollectionList } from "../components/collections/CollectionList";

export const Route = createFileRoute("/settings_/collections/")({
  component: CollectionList,
});
