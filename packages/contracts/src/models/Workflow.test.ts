import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import type { Task } from "./Task.ts";

import {
  type Step,
  type StepDefinition,
  type Ticket,
  type Workflow,
  type StepAutomation,
  automationsSubmitted,
  childSteps,
  completeTicketStep,
  currentStep,
  definitionChangeRefusal,
  needsWorkAfterDefinitionChange,
  putTicketStep,
  resolveAssignee,
  resolveResponsible,
  stepAfterDefinitionChange,
  stepPeopleOnEntry,
  stepReadyForApproval,
  stepAutomationRefusal,
  subStepsToEnter,
  ticketStartRefusal,
} from "./Workflow.ts";

const at = DateTime.makeUnsafe("2026-10-26T12:00:00.000Z");
const workflow: Workflow = {
  id: "workflow01",
  definitionId: "definition01",
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

it("requires every automation to submit before review", () => {
  const entries: ReadonlyArray<StepAutomation> = [
    { id: "entry01", agentId: "agent01", instructions: "Draft" },
    { id: "entry02", agentId: "agent01", instructions: "Check" },
  ];
  const tasks = entries.map((entry): Pick<Task, "trigger" | "state"> => ({
    trigger: { type: "step", ticketId: ticket.id, stepId: step.id, automationId: entry.id },
    state: { type: "submitted" },
  }));
  assert.isFalse(automationsSubmitted(entries, tasks.slice(0, 1)));
  assert.isFalse(
    automationsSubmitted(
      entries,
      tasks.map((task) => ({ ...task, state: { type: "active" } })),
    ),
  );
  assert.isTrue(automationsSubmitted(entries, tasks));
});
const root = definition("root001");
const step: Step = {
  id: "step001",
  stepDefinitionId: root.id,
  parentStepId: null,
  status: { type: "working", at },
  assignee: "worker01",
  responsible: "owner01",
  values: {},
  automations: [],
};
const ticket: Ticket = {
  id: "ticket01",
  workflowId: workflow.id,
  title: "Review",
  description: "",
  dueDate: null,
  status: { type: "open" },
  steps: [step],
  createdAt: at,
};

it("keeps finished automations separate from shared step readiness", () => {
  const entries = [
    { id: "extract01", agentId: "agent01", instructions: "Extract the data" },
    { id: "review01", agentId: "agent02", instructions: "Review the data" },
  ];
  const definition: StepDefinition = {
    ...root,
    fields: [{ id: "result01", label: "Result", type: "text" }],
  };
  const shared = { ...step, values: {}, automations: entries };
  const submitted = entries.map((entry): Pick<Task, "trigger" | "state"> => ({
    trigger: { type: "step", ticketId: ticket.id, stepId: step.id, automationId: entry.id },
    state: { type: "submitted" },
  }));
  assert.isFalse(stepReadyForApproval(definition, ticket, shared, submitted));
  const filled = { ...shared, values: { result01: "Collected" } };
  assert.isFalse(stepReadyForApproval(definition, ticket, filled, submitted.slice(0, 1)));
  assert.isTrue(stepReadyForApproval(definition, ticket, filled, submitted));
  const withChild = {
    ...ticket,
    steps: [filled, { ...step, id: "child01", parentStepId: step.id }],
  };
  assert.isFalse(stepReadyForApproval(definition, withChild, filled, submitted));
});

it("allows another automation run while working or awaiting approval, but not after completion", () => {
  assert.equal(stepAutomationRefusal(ticket, step), null);
  assert.equal(
    stepAutomationRefusal(ticket, { ...step, status: { type: "waiting_approval", at } }),
    null,
  );
  assert.equal(
    stepAutomationRefusal(ticket, { ...step, status: { type: "completed", at } }),
    "step_not_actionable",
  );
  assert.equal(
    stepAutomationRefusal({ ...ticket, status: { type: "done" } }, step),
    "ticket_not_open",
  );
});

describe("step people", () => {
  it("uses a team's defaults before inherited people, without inventing an assignee", () => {
    const configured = {
      ...workflow,
      defaultAssignments: {
        [root.id]: { automations: [], assignee: "named01", responsible: "approver01" },
      },
    };
    assert.deepEqual(stepPeopleOnEntry(configured, root, "previous01"), {
      assignee: "named01",
      responsible: "approver01",
    });
    assert.deepEqual(stepPeopleOnEntry(workflow, root, "previous01"), {
      assignee: "previous01",
      responsible: null,
    });
    assert.equal(resolveAssignee(null, "owner01", false).assignee, null);
  });

  it("replaces departed people with the responsible or the oldest active admin and requests the right notices", () => {
    const resolved = resolveResponsible(workflow, "departed01", new Set(["admin02"]));
    assert.equal(resolved.responsible, "admin02");
    assert.deepEqual(resolved.notices, ["names_deactivated", "needs_responsible"]);
    assert.deepEqual(resolveAssignee("departed02", resolved.responsible!, false), {
      assignee: "admin02",
      namesDeactivated: true,
    });
    assert.equal(
      resolveResponsible(workflow, "approver01", new Set(["approver01", "admin02"])).responsible,
      "approver01",
    );
  });

  it("allows authorized people to start unassigned tickets", () => {
    const blueprint = {
      id: workflow.definitionId,
      name: "Review",
      steps: [root],
      isArchived: false,
    };
    for (const actor of [
      { id: "orgadmin01", isOrgAdmin: true },
      { id: "admin01", isOrgAdmin: false },
      { id: "owner01", isOrgAdmin: false },
    ]) {
      assert.equal(ticketStartRefusal(actor, workflow, blueprint), null);
    }
    assert.deepEqual(stepPeopleOnEntry(workflow, root, null), {
      assignee: null,
      responsible: null,
    });
    assert.equal(
      ticketStartRefusal({ id: "outsider01", isOrgAdmin: false }, workflow, blueprint),
      "cannot_start_ticket",
    );
  });

  it("lets the first step's assignee start tickets and preserves workflow restrictions", () => {
    const blueprint = {
      id: workflow.definitionId,
      name: "Review",
      steps: [root],
      isArchived: false,
    };
    const configured = {
      ...workflow,
      defaultAssignments: {
        [root.id]: { automations: [], assignee: "worker01", responsible: null },
      },
    };
    assert.equal(
      ticketStartRefusal({ id: "worker01", isOrgAdmin: false }, configured, blueprint),
      null,
    );
    assert.equal(
      ticketStartRefusal({ id: "outsider01", isOrgAdmin: false }, configured, blueprint),
      "cannot_start_ticket",
    );
    const admin = { id: "admin01", isOrgAdmin: false };
    assert.equal(
      ticketStartRefusal(admin, { ...workflow, isArchived: true }, blueprint),
      "workflow_archived",
    );
    assert.equal(ticketStartRefusal(admin, workflow, { ...blueprint, steps: [] }), "no_steps");
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

  it("the next root inherits the completed step's assignee unless its own default overrides it", () => {
    const next = definition("next001");
    const result = completeTicketStep(ticket, [root, next], step, at);
    assert.equal(result.ticket.status.type, "open");
    assert.equal(result.ticket.steps[0]?.status.type, "completed");
    assert.equal(result.next?.id, next.id);
    const entered = { ...step, id: "nextstep01", stepDefinitionId: next.id };
    assert.equal(currentStep(putTicketStep(result.ticket, entered)), entered);
    assert.equal(stepPeopleOnEntry(workflow, next, step.assignee).assignee, step.assignee);
  });
});

describe("changing a shared definition", () => {
  it("refuses removing or reparenting active work, while retaining completed history", () => {
    assert.equal(definitionChangeRefusal(ticket, []), "tickets_cannot_move");
    assert.equal(
      definitionChangeRefusal(ticket, [definition("parent01", [root])]),
      "tickets_cannot_move",
    );
    const completed = completeTicketStep(ticket, [root], step, at).ticket;
    assert.equal(definitionChangeRefusal(completed, []), null);
    assert.equal(completed.steps[0]?.id, step.id);
  });

  it("new sub-steps invalidate a pending approval until those children are complete", () => {
    const waiting: Step = { ...step, status: { type: "waiting_approval", at } };
    const childDefinition = definition("child01");
    const changedRoot = definition(root.id, [childDefinition]);
    const waitingTicket = putTicketStep(ticket, waiting);
    const additions = subStepsToEnter(waitingTicket, waiting, changedRoot);
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
    const changedTicket = putTicketStep(waitingTicket, child);
    assert.equal(needsWorkAfterDefinitionChange(changedTicket, waiting, changedRoot), true);
    const complete = completeTicketStep(changedTicket, [changedRoot], child, at).ticket;
    assert.equal(needsWorkAfterDefinitionChange(complete, waiting, changedRoot), false);
    assert.deepEqual(
      childSteps(complete, [changedRoot], waiting).map((entry) => entry.id),
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
