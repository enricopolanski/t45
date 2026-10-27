import { Authorization, CurrentUser } from "@t45/contracts/Authorization";
import { Assignments } from "@t45/contracts/resources/Assignments";
import * as Effect from "effect/Effect";

import { WorkflowService } from "./WorkflowService.ts";

export const layer = Assignments.middleware(Authorization).toLayer(
  Effect.gen(function* () {
    const workflows = yield* WorkflowService;
    return Assignments.of({
      "assignments.listAssignments": () =>
        Effect.flatMap(CurrentUser, ({ userId }) => workflows.listAssignments(userId)),
    });
  }),
);
