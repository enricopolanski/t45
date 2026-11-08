import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../models/primitives.ts";
import { StepSummaryView, TicketSummaryView, WorkflowErrors } from "./Workflows.ts";

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

/** The steps and sub-steps I have to do, by their ticket's due date, undated last. */
export const Assignments = RpcGroup.make(
  Rpc.make("listAssignments", { success: Schema.Array(AssignmentView), error: WorkflowErrors }),
).prefix("assignments.");
