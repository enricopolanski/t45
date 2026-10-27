import { createFileRoute } from "@tanstack/react-router";

import { MyWorkPage } from "../components/work/MyWork";

export const Route = createFileRoute("/my-work/")({
  component: MyWorkPage,
});
