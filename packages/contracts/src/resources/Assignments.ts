import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../models/primitives.ts";
import { StepSummaryView, TicketSummaryView, WorkflowErrors } from "./Workflows.ts";

/**
 * The sections of my assignments: approvals waiting for me, my steps, and steps I approve that
 * someone or an agent is still working on. Sub-steps are steps.
 */
export const AssignmentSection = Schema.Literals(["to_approve", "to_do", "waiting"]);
export type AssignmentSection = typeof AssignmentSection.Type;

/** One step of a ticket, with the names it is shown by. */
export const AssignmentView = Schema.Struct({
  ticket: TicketSummaryView,
  step: StepSummaryView,
  workflowName: TrimmedNonEmptyString,
  stepName: TrimmedNonEmptyString,
  /** The names of the steps a sub-step sits in, outermost first; empty for a step. */
  parentNames: Schema.Array(Schema.String),
});
export type AssignmentView = typeof AssignmentView.Type;

/**
 * The sections in the order above, empty ones left out; assignments by their ticket's due date,
 * undated last.
 */
export const Assignments = RpcGroup.make(
  Rpc.make("listAssignments", {
    success: Schema.Struct({
      sections: Schema.Array(
        Schema.Struct({ section: AssignmentSection, assignments: Schema.Array(AssignmentView) }),
      ),
    }),
    error: WorkflowErrors,
  }),
).prefix("assignments.");
