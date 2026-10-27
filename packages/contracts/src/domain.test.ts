import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  Step,
  Ticket,
  Workflow,
  WorkflowDefinition,
  lastAdminRefusal,
  stepApprovalRefusal,
  stepCompletionRefusal,
} from "./models/Workflow.ts";

const at = "2026-10-26T12:00:00.000Z";

const rawStep = {
  id: "step001",
  stepDefinitionId: "def001",
  parentStepId: null,
  status: { type: "working", at },
  assignee: "person01",
  responsible: "person02",
  values: {},
  automations: [],
};
const rawTicket = {
  id: "ticket01",
  workflowId: "workflow01",
  title: "Review",
  description: "",
  dueDate: null,
  status: { type: "open", at },
  steps: [rawStep],
  currentStepId: rawStep.id,
  createdAt: at,
  updatedAt: at,
};
const decodeTicket = Schema.decodeUnknownSync(Schema.toCodecJson(Ticket));
const decodeStep = Schema.decodeUnknownSync(Schema.toCodecJson(Step));
const decodeWorkflow = Schema.decodeUnknownSync(Schema.toCodecJson(Workflow));
const decodeSteps = Schema.decodeUnknownSync(WorkflowDefinition.fields.steps);
const workflow = decodeWorkflow({
  id: "workflow01",
  definitionId: "definition01",
  name: "Review",
  responsible: "person02",
  adminUserIds: ["person02"],
  defaultAssignments: {},
  slug: null,
  isDefault: false,
  isPublic: false,
  archivedAt: null,
  createdAt: at,
  updatedAt: at,
});
const definition = {
  id: "def001",
  name: "Review",
  instructions: "",
  fields: [{ id: "field01", label: "Accepted", type: "boolean" }],
  subSteps: [],
};

describe("workflow rules", () => {
  it("does not approve another person's step or a closed ticket", () => {
    const ticket = decodeTicket(rawTicket);
    const step = decodeStep({ ...rawStep, status: { type: "waiting_approval", at } });
    assert.equal(stepApprovalRefusal("person02", workflow, ticket, step), null);
    assert.equal(stepApprovalRefusal("person01", workflow, ticket, step), "not_step_responsible");
    assert.equal(
      stepApprovalRefusal(
        "person02",
        workflow,
        decodeTicket({ ...rawTicket, status: { type: "done", at }, currentStepId: null }),
        step,
      ),
      "ticket_not_open",
    );
  });

  it("requires filled fields and completed children, while false is a filled value", () => {
    const [stepDefinition] = decodeSteps([definition]);
    assert.ok(stepDefinition);
    const ticket = decodeTicket(rawTicket);
    const step = ticket.steps[0]!;
    assert.equal(stepCompletionRefusal(stepDefinition, ticket, step), "step_incomplete");
    const filled = { ...step, values: { field01: false } };
    assert.equal(stepCompletionRefusal(stepDefinition, ticket, filled), null);
    const withChild = decodeTicket({
      ...rawTicket,
      steps: [rawStep, { ...rawStep, id: "child01", parentStepId: rawStep.id }],
    });
    assert.equal(stepCompletionRefusal(stepDefinition, withChild, filled), "step_incomplete");
  });

  it("requires an active workflow admin", () => {
    assert.equal(lastAdminRefusal([]), "last_admin");
    assert.equal(lastAdminRefusal(["person02"]), null);
  });
});
