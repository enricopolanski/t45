import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { AutomationId } from "./Automation.ts";
import {
  type Step,
  type StepDefinition,
  type Ticket,
  type Project,
  type WorkflowEdit,
  type WorkflowVersion,
  applyWorkflowEdits,
  canAttachAgent,
  canSeeStep,
  completeTicketStep,
  currentStep,
  fieldValueProblem,
  hasValidInputs,
  occupiedStep,
  putTicketStep,
  resolveFieldPath,
  StepField,
  stepEntryRefusal,
  stepIds,
  stepsAssignedUnder,
  ticketAccess,
  ticketStartRefusal,
} from "./Workflow.ts";

const at = DateTime.makeUnsafe("2026-10-26T12:00:00.000Z");
const project: Project = {
  id: "project01",
  workflowId: "workflow01",
  workflowVersionId: "version01",
  name: "Review",
  adminUserIds: ["admin01", "admin02"],
  defaultAssignees: {},
  slug: null,
  isArchived: false,
};
const definition = (
  id: string,
  subSteps: ReadonlyArray<StepDefinition> = [],
  extra: Partial<StepDefinition> = {},
): StepDefinition => ({
  id,
  name: id,
  instructions: "",
  fields: [],
  subSteps,
  inputs: [],
  automationIds: [],
  ...extra,
});
const versionOf = (steps: ReadonlyArray<StepDefinition>): WorkflowVersion => ({
  id: "version01",
  workflowId: project.workflowId,
  number: 1,
  revision: 0,
  isFrozen: true,
  steps,
});

const root = definition("root001");
const step: Step = {
  id: "step001",
  stepDefinitionId: root.id,
  parentStepId: null,
  status: { type: "working", at },
  assignee: "worker01",
  values: {},
};
const ticket: Ticket = {
  id: "ticket01",
  projectId: project.id,
  workflowVersionId: "version01",
  title: "Review",
  description: "",
  status: { type: "open" },
  steps: [step],
  createdAt: at,
};

describe("starting a ticket", () => {
  it("is for the members of the adopted version's first step, whatever else they manage", () => {
    const adopted = versionOf([root, definition("next001")]);
    assert.equal(ticketStartRefusal(new Set([root.id]), project, adopted), null);
    assert.equal(ticketStartRefusal(new Set(["next001"]), project, adopted), "cannot_start_ticket");
    assert.equal(ticketStartRefusal(new Set([root.id]), project, null), "not_adopted");
    assert.equal(
      ticketStartRefusal(new Set([root.id]), { ...project, isArchived: true }, adopted),
      "project_archived",
    );
  });
});

describe("seeing a ticket", () => {
  const second = definition("second01", [definition("child01")]);
  const version = versionOf([root, second]);
  const done: Step = { ...step, status: { type: "completed", at } };
  const inSecond: Step = { ...step, id: "step002", stepDefinitionId: second.id };
  const child: Step = {
    ...step,
    id: "step003",
    stepDefinitionId: "child01",
    parentStepId: "step002",
  };
  const open: Ticket = { ...ticket, steps: [done, inSecond, child] };
  const sees = (memberOf: ReadonlyArray<string>, shown: Ticket) => {
    const access = ticketAccess(new Set(memberOf), version, shown);
    return shown.steps.filter((each) => canSeeStep(access, shown, each)).map((each) => each.id);
  };

  it("shows an open ticket to the members of the step it is in, with its sub-steps", () => {
    assert.deepEqual(sees([second.id], open), ["step002", "step003"]);
    // The step it left is out of its members' sight, and so is one it hasn't reached.
    assert.deepEqual(sees([root.id], open), []);
    assert.deepEqual(sees([root.id], ticket), ["step001"]);
    assert.deepEqual(sees([second.id], ticket), []);
    assert.deepEqual(sees([root.id, second.id], open), ["step002", "step003"]);
  });

  it("shows a closed ticket whole to a member of every step, else its last step to that step's", () => {
    const finished: Ticket = {
      ...open,
      status: { type: "done" },
      steps: [done, { ...inSecond, status: { type: "completed", at } }, child],
    };
    assert.deepEqual(sees([root.id, second.id], finished), ["step001", "step002", "step003"]);
    assert.deepEqual(sees([second.id], finished), ["step002", "step003"]);
    assert.deepEqual(sees([root.id], finished), []);
  });

  it("takes a cancelled ticket's last step to be where it stopped", () => {
    const cancelled: Ticket = { ...ticket, status: { type: "cancelled", reason: "Withdrawn" } };
    assert.equal(occupiedStep(cancelled)?.id, "step001");
    assert.deepEqual(sees([root.id], cancelled), ["step001"]);
    // The step it never reached shows nothing to its members.
    assert.deepEqual(sees([second.id], cancelled), []);
  });

  it("finds the steps that keep someone a member: theirs under the step, completed ones too", () => {
    const assigned = (userId: string) =>
      stepsAssignedUnder(open, second.id, userId).map((each) => each.id);
    assert.deepEqual(assigned("worker01"), ["step002", "step003"]);
    assert.deepEqual(assigned("other001"), []);
    assert.deepEqual(
      stepsAssignedUnder(open, root.id, "worker01").map((each) => each.id),
      ["step001"],
    );
  });
});

describe("step inputs", () => {
  const total = { id: "total01", label: "Total", type: "number" } as const;
  const input = { stepId: "first01", fieldId: total.id };
  const first = definition("first01", [], { fields: [total] });
  const reader = definition("child01", [], { inputs: [input] });

  it("reads fields of steps under an earlier step only", () => {
    assert.isTrue(hasValidInputs([first, definition("second01", [reader])]));
    // Not a sibling's, not its own step's, not a later step's, and not a field that isn't there.
    assert.isFalse(hasValidInputs([definition("second01", [first, reader])]));
    assert.isFalse(hasValidInputs([definition("second01", [reader]), first]));
    assert.isFalse(
      hasValidInputs([
        first,
        definition("second01", [], { inputs: [{ ...input, fieldId: "gone01" }] }),
      ]),
    );
  });

  it("lets a step start only when its inputs, and its sub-steps', have a value", () => {
    const second = definition("second01", [reader]);
    const steps = [first, second];
    const filled = (value: number | null): Ticket => ({
      ...ticket,
      steps: [
        {
          ...step,
          stepDefinitionId: first.id,
          values: value === null ? {} : { [total.id]: value },
        },
      ],
    });
    assert.equal(stepEntryRefusal(steps, filled(0), second), null);
    assert.equal(stepEntryRefusal(steps, filled(null), second), "inputs_missing");
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

describe("editing a version's steps", () => {
  const child = definition("child01");
  const steps = [definition("first01", [child]), definition("second01")];
  const apply = (edits: ReadonlyArray<WorkflowEdit>, used = stepIds(steps)) =>
    applyWorkflowEdits(steps, edits, used);

  it("renames and moves a step under the id it had", () => {
    const edited = apply([
      { type: "rename_step", stepId: "first01", name: "Intake" },
      { type: "move_step", stepId: "first01", index: 1 },
    ]);
    assert.deepEqual(
      edited?.map((step) => [step.id, step.name]),
      [
        ["second01", "second01"],
        ["first01", "Intake"],
      ],
    );
    assert.deepEqual(
      edited?.[1]?.subSteps.map((step) => step.id),
      [child.id],
    );
  });

  it("adds a step only under an id the workflow never had", () => {
    const add = (stepId: string): WorkflowEdit => ({
      type: "add_step",
      stepId,
      parentStepId: "second01",
      index: 0,
      name: "Check",
    });
    assert.deepEqual(
      apply([add("added01")])?.[1]?.subSteps.map((step) => step.id),
      ["added01"],
    );
    // A removed step doesn't come back under another parent.
    assert.equal(apply([{ type: "remove_step", stepId: "child01" }, add("child01")]), null);
    assert.equal(apply([add("gone001")], [...stepIds(steps), "gone001"]), null);
    assert.equal(apply([add("added01"), add("added01")]), null);
  });

  it("changes a step's fields by their ids, and refuses what doesn't fit", () => {
    const field = { id: "field01", label: "Total", type: "number" } as const;
    const added = apply([{ type: "add_field", stepId: "child01", index: 0, field }]);
    assert.deepEqual(added?.[0]?.subSteps[0]?.fields, [field]);
    assert.equal(
      apply([
        { type: "add_field", stepId: "child01", index: 0, field },
        { type: "add_field", stepId: "child01", index: 0, field },
      ]),
      null,
    );
    assert.equal(apply([{ type: "remove_field", stepId: "child01", fieldId: "field01" }]), null);
    assert.equal(apply([{ type: "move_step", stepId: "first01", index: 2 }]), null);
    assert.equal(apply([{ type: "rename_step", stepId: "missing1", name: "Lost" }]), null);
  });

  it("binds an input to a step once, and unbinds only what is bound", () => {
    const input = { stepId: "first01", fieldId: "field01" };
    const bind = { type: "bind_input", stepId: "second01", input } as const;
    const unbind = { ...bind, type: "unbind_input" } as const;
    assert.deepEqual(apply([bind])?.[1]?.inputs, [input]);
    assert.equal(apply([bind, bind]), null);
    assert.equal(apply([unbind]), null);
    assert.deepEqual(apply([bind, unbind])?.[1]?.inputs, []);
  });

  it("attaches an automation to a step once, and detaches only what is attached", () => {
    const automationId = AutomationId.make("automation01");
    const attach = { type: "attach_automation", stepId: "second01", automationId } as const;
    const detach = { ...attach, type: "detach_automation" } as const;
    assert.deepEqual(apply([attach])?.[1]?.automationIds, [automationId]);
    assert.equal(apply([attach, attach]), null);
    assert.equal(apply([detach]), null);
    assert.deepEqual(apply([attach, detach])?.[1]?.automationIds, []);
  });
});

describe("attaching an agent's automation to a workflow", () => {
  const workflow = {
    id: "workflow01",
    name: "Review",
    creatorUserId: "creator01",
    editorUserIds: ["editor01"],
    isArchived: false,
  };
  const agent = {
    status: "active",
    creatorUserId: "creator01",
    isPublished: false,
  } as const;
  const capabilities = [{ requiredContext: ["stepId"] }];

  it("keeps a private agent to its creator's own workflows", () => {
    assert.isTrue(canAttachAgent(agent, workflow, "creator01", capabilities));
    // Another editor can't use it, and its creator can't bring it to someone else's workflow.
    assert.isFalse(canAttachAgent(agent, workflow, "editor01", capabilities));
    assert.isFalse(
      canAttachAgent({ ...agent, creatorUserId: "editor01" }, workflow, "editor01", capabilities),
    );
    assert.isTrue(
      canAttachAgent({ ...agent, isPublished: true }, workflow, "editor01", capabilities),
    );
  });

  it("refuses an agent that can't work on steps", () => {
    assert.isFalse(canAttachAgent(agent, workflow, "creator01", []));
    assert.isFalse(
      canAttachAgent({ ...agent, status: "archived" }, workflow, "creator01", capabilities),
    );
  });
});

const decodeFields = Schema.decodeSync(Schema.Array(StepField));

describe("explaining a field that doesn't fit", () => {
  const fields = decodeFields([
    { id: "f_discount", label: "Discount", type: "number" },
    { id: "f_duedate", label: "Due", type: "date" },
    {
      id: "f_variants",
      label: "Variants",
      type: "group",
      repeatable: true,
      fields: [
        { id: "f_size", label: "Size", type: "text" },
        { id: "f_cost", label: "Cost", type: "number" },
      ],
    },
  ]);

  it("names a repeatable group's row fields when a row field's key is wrong", () => {
    const problem = resolveFieldPath(fields, "f_variants.r1.size");
    assert.isString(problem);
    assert.include(problem, "f_variants.r1.f_size: text");
    assert.include(problem, "f_variants.r1.f_cost: a number");
  });

  it("says what a field takes and what it got", () => {
    assert.strictEqual(
      fieldValueProblem(fields[0]!, "f_discount", "0.03"),
      'f_discount takes a number, like 0.5; got the text "0.03".',
    );
    assert.isNull(fieldValueProblem(fields[0]!, "f_discount", 0.03));
    assert.include(
      fieldValueProblem(fields[2]!, "f_variants", '["r1"]') ?? "",
      "the list of its row ids",
    );
  });

  it("takes a date only as YYYY-MM-DD", () => {
    assert.isNull(fieldValueProblem(fields[1]!, "f_duedate", "2026-12-01"));
    assert.isNotNull(fieldValueProblem(fields[1]!, "f_duedate", '"2026-12-01"'));
    assert.isNotNull(fieldValueProblem(fields[1]!, "f_duedate", "1/12/2026"));
  });
});
