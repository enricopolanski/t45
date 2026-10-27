import { createFileRoute } from "@tanstack/react-router";

import { PeopleList } from "../components/people/PeopleList";
import { WorkFrame } from "../components/work/WorkFrame";

function PeopleView() {
  return (
    <WorkFrame title="People">
      <PeopleList />
    </WorkFrame>
  );
}

export const Route = createFileRoute("/people")({
  component: PeopleView,
});
