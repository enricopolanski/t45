import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  type Step,
  type StepDefinition,
  type Ticket,
  type Project,
  childSteps,
  completeTicketStep,
  currentStep,
  workflowChangeRefusal,
  putTicketStep,
  stepAfterDefinitionChange,
  subStepsToEnter,
  ticketStartRefusal,
} from "./Workflow.ts";

const at = DateTime.makeUnsafe("2026-10-26T12:00:00.000Z");
const project: Project = {
  id: "project01",
  workflowId: "workflow01",
  name: "Review",
  responsible: "owner01",
  adminUserIds: ["admin01", "admin02"],
  defaultAssignments: {},
  slug: null,
  isPublic: false,
  isArchived: false,
};
const definition = (id: string, subSteps: ReadonlyArray<StepDefinition> = []): StepDefinition => ({
  id,
  name: id,
  instructions: "",
  fields: [],
  subSteps,
});

const root = definition("root001");
const step: Step = {
  id: "step001",
  stepDefinitionId: root.id,
  parentStepId: null,
  status: { type: "working", at },
  assignee: "worker01",
  values: {},
  automationIds: [],
};
const ticket: Ticket = {
  id: "ticket01",
  projectId: project.id,
  title: "Review",
  description: "",
  dueDate: null,
  status: { type: "open" },
  steps: [step],
  createdAt: at,
};

describe("starting a ticket", () => {
  it("lets an organization admin start an unassigned first step while retaining authorization", () => {
    const workflow = {
      id: project.workflowId,
      name: "Review",
      steps: [root],
      isArchived: false,
    };
    assert.equal(ticketStartRefusal({ id: "admin01", isOrgAdmin: true }, project, workflow), null);
    const configured = {
      ...project,
      defaultAssignments: {
        [root.id]: { automationIds: [], assignee: "worker01" },
      },
    };
    assert.equal(
      ticketStartRefusal({ id: "worker01", isOrgAdmin: false }, configured, workflow),
      null,
    );
    assert.equal(
      ticketStartRefusal({ id: "outsider01", isOrgAdmin: false }, configured, workflow),
      "cannot_start_ticket",
    );
  });
});

describe("ticket progression", () => {
  it("completing a child leaves its parent active; the last root finishes the ticket", () => {
    const childDefinition = definition("child01");
    const child = {
      ...step,
      id: "childstep01",
      stepDefinitionId: childDefinition.id,
      parentStepId: step.id,
    };
    const withChild = putTicketStep(ticket, child);
    const completedChild = completeTicketStep(withChild, [root], child, at);
    assert.equal(currentStep(completedChild.ticket)?.id, step.id);
    assert.equal(completedChild.ticket.status.type, "open");
    assert.equal(completedChild.next, null);
    const completedRoot = completeTicketStep(completedChild.ticket, [root], step, at);
    assert.equal(completedRoot.ticket.status.type, "done");
    assert.equal(currentStep(completedRoot.ticket), null);
  });

  it("completing a root leaves the ticket open for the next root", () => {
    const next = definition("next001");
    const result = completeTicketStep(ticket, [root, next], step, at);
    assert.equal(result.ticket.status.type, "open");
    assert.equal(result.ticket.steps[0]?.status.type, "completed");
    assert.equal(result.next?.id, next.id);
    const entered = { ...step, id: "nextstep01", stepDefinitionId: next.id };
    assert.equal(currentStep(putTicketStep(result.ticket, entered)), entered);
  });
});

describe("changing a shared workflow", () => {
  it("refuses removing or reparenting active work, while retaining completed history", () => {
    assert.equal(workflowChangeRefusal(ticket, []), "tickets_cannot_move");
    assert.equal(
      workflowChangeRefusal(ticket, [definition("parent01", [root])]),
      "tickets_cannot_move",
    );
    const completed = completeTicketStep(ticket, [root], step, at).ticket;
    assert.equal(workflowChangeRefusal(completed, []), null);
    assert.equal(completed.steps[0]?.id, step.id);
  });

  it("enters sub-steps added to the current step as its children", () => {
    const childDefinition = definition("child01");
    const changedRoot = definition(root.id, [childDefinition]);
    const additions = subStepsToEnter(ticket, step, changedRoot);
    assert.deepEqual(
      additions.map((entry) => entry.definition.id),
      [childDefinition.id],
    );
    const child = {
      ...step,
      id: "childstep01",
      stepDefinitionId: childDefinition.id,
      parentStepId: step.id,
    };
    const changedTicket = putTicketStep(ticket, child);
    assert.deepEqual(
      childSteps(changedTicket, [changedRoot], step).map((entry) => entry.id),
      [child.id],
    );
  });

  it("removes values only for fields removed from the definition", () => {
    const withValues = { ...step, values: { kept001: "retained", removed01: "obsolete" } };
    const changed: StepDefinition = {
      ...root,
      fields: [{ id: "kept001", label: "Kept", type: "text" }],
    };
    assert.deepEqual(stepAfterDefinitionChange(withValues, changed).values, {
      kept001: "retained",
    });
  });
});
