import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { Ticket, Workflow, lastAdminRefusal, stepCompletionRefusal } from "./models/Workflow.ts";

const at = "2026-10-26T12:00:00.000Z";

const rawStep = {
  id: "step001",
  stepDefinitionId: "def001",
  parentStepId: null,
  status: { type: "working", at },
  assignee: "person01",
  values: {},
  automationIds: [],
};
const rawTicket = {
  id: "ticket01",
  projectId: "project01",
  title: "Review",
  description: "",
  dueDate: null,
  status: { type: "open" },
  steps: [rawStep],
  createdAt: at,
};
const decodeTicket = Schema.decodeUnknownSync(Schema.toCodecJson(Ticket));
const decodeSteps = Schema.decodeUnknownSync(Workflow.fields.steps);
const definition = {
  id: "def001",
  name: "Review",
  instructions: "",
  fields: [{ id: "field01", label: "Accepted", type: "boolean" }],
  subSteps: [],
};

describe("workflow rules", () => {
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

    const grouped = {
      ...stepDefinition,
      fields: [
        {
          id: "group01",
          label: "Checks",
          type: "group" as const,
          repeatable: true,
          fields: stepDefinition.fields,
        },
      ],
    };
    const values = { group01: ["row0001", "row0002"], "group01.row0001.field01": false };
    assert.equal(stepCompletionRefusal(grouped, ticket, { ...step, values }), "step_incomplete");
    assert.equal(
      stepCompletionRefusal(grouped, ticket, { ...step, values: { ...values, group01: [] } }),
      "step_incomplete",
    );
    assert.equal(
      stepCompletionRefusal(grouped, ticket, {
        ...step,
        values: { ...values, group01: ["row0001"] },
      }),
      null,
    );
  });

  it("requires an active project admin", () => {
    assert.equal(lastAdminRefusal([]), "last_admin");
    assert.equal(lastAdminRefusal(["person02"]), null);
  });
});
