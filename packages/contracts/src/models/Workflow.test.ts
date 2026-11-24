import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { AutomationId } from "./Automation.ts";
import {
  type Step,
  StepDefinition,
  type Ticket,
  type Project,
  type WorkflowEdit,
  type WorkflowVersion,
  applyWorkflowEdits,
  approvedValue,
  automationTriggerOf,
  canAttachAgent,
  canSeeStep,
  changedLayouts,
  isLayoutChangeOnly,
  setLayouts,
  completeTicketStep,
  currentStep,
  hasValidInputs,
  occupiedStep,
  openProposals,
  proposalFiltersRefusal,
  proposalRefusal,
  withReviewedProposals,
  retainRecordAssociations,
  withRecordAssociation,
  evaluateProposalFilterCascade,
  type ProposalFilter,
  confirmRecordEntry,
  recordReviewsOf,
  getComparisonSources,
  getComparisonRefusal,
  reviewEntryValues,
  withEditedStepValues,
  putTicketStep,
  stepCompletionRefusal,
  stepEntryRefusal,
  stepIds,
  stepsAssignedUnder,
  ticketAccess,
  ticketStartRefusal,
} from "./Workflow.ts";
import { defaultValues, Field, fieldValueProblem, type Layout, resolveFieldPath } from "./Field.ts";

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
  creatorUserId: null,
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

describe("starting a step's automations", () => {
  it("runs one on demand unless the project starts it on that step's entry", () => {
    const automationId = AutomationId.make("automation01");
    const starting = {
      ...project,
      automationTriggers: [{ stepId: root.id, automationId, trigger: "step_entry" as const }],
    };
    assert.equal(automationTriggerOf(project, root.id, automationId), "on_demand");
    assert.equal(automationTriggerOf(starting, root.id, automationId), "step_entry");
    assert.equal(automationTriggerOf(starting, "next001", automationId), "on_demand");
    assert.equal(
      automationTriggerOf(starting, root.id, AutomationId.make("automation02")),
      "on_demand",
    );
  });
});

describe("laying out a group", () => {
  const group = (layout?: Layout) =>
    ({
      id: "group01",
      label: "Lines",
      type: "group",
      repeatable: true,
      fields: [{ id: "name01", label: "Name", type: "text" }],
      ...(layout && { layout }),
    }) as Field;
  const stepsWith = (field: Field, extra: Partial<StepDefinition> = {}) =>
    Schema.decodeUnknownSync(Schema.Array(StepDefinition))([
      definition("first01", [definition("child01", [], { fields: [field], ...extra })]),
    ]);
  const layoutOf = (steps: ReadonlyArray<StepDefinition>) => {
    const field = steps[0]!.subSteps[0]!.fields[0]!;
    return field.type === "group" ? field.layout : null;
  };
  const sorted = { table: { sortBy: [{ field: "name01", direction: "asc" as const }] } };

  it("changes only how a group shows, and carries to every version holding the group", () => {
    const saved = stepsWith(group());
    const edited = stepsWith(group(sorted));
    assert.isTrue(isLayoutChangeOnly(saved, edited));
    assert.isFalse(isLayoutChangeOnly(saved, stepsWith(group(sorted), { name: "Renamed" })));
    const layouts = changedLayouts(saved, edited);
    assert.deepEqual([...layouts.keys()], ["child01/group01"]);
    const older = setLayouts(stepsWith(group(), { instructions: "Older" }), layouts);
    assert.deepEqual(layoutOf(older), sorted);
    assert.equal(older[0]!.subSteps[0]!.instructions, "Older");
    assert.isUndefined(layoutOf(setLayouts(edited, changedLayouts(edited, saved))));
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

const decodeFields = Schema.decodeSync(Schema.Array(Field));

const decodeStep = Schema.decodeUnknownOption(StepDefinition);

describe("default values", () => {
  const stepWith = (fields: ReadonlyArray<typeof Field.Encoded>) =>
    decodeStep({
      id: "step01",
      name: "Quote",
      instructions: "",
      fields,
      subSteps: [],
    });

  it("start a step's fields, a single group's too, and each new entry of a repeatable group", () => {
    const fields = decodeFields([
      { id: "f_discount", label: "Discount", type: "number", defaultValue: 3 },
      { id: "f_note", label: "Note", type: "text" },
      {
        id: "f_terms",
        label: "Terms",
        type: "group",
        repeatable: false,
        fields: [{ id: "f_paid", label: "Paid", type: "boolean", defaultValue: false }],
      },
      {
        id: "f_variants",
        label: "Variants",
        type: "group",
        repeatable: true,
        fields: [
          { id: "f_size", label: "Size", type: "select", options: ["S", "M"], defaultValue: "M" },
        ],
      },
    ]);
    const variants = fields[3]!;
    assert.deepStrictEqual(defaultValues(fields), { f_discount: 3, "f_terms.f_paid": false });
    assert.deepStrictEqual(
      defaultValues(variants.type === "group" ? variants.fields : [], "f_variants.r1"),
      { "f_variants.r1.f_size": "M" },
    );
  });

  it("must fit their field", () => {
    assert.isTrue(
      Option.isSome(stepWith([{ id: "f_rate", label: "Rate", type: "number", defaultValue: 3 }])),
    );
    assert.isTrue(
      Option.isNone(stepWith([{ id: "f_rate", label: "Rate", type: "number", defaultValue: "3" }])),
    );
    assert.isTrue(
      Option.isNone(
        stepWith([
          { id: "f_rate", label: "Rate", type: "select", options: ["S"], defaultValue: "M" },
        ]),
      ),
    );
    assert.isTrue(
      Option.isNone(
        stepWith([
          {
            id: "f_group",
            label: "G",
            type: "group",
            repeatable: true,
            fields: [{ id: "f_date", label: "Date", type: "date", defaultValue: "1/12/2026" }],
          },
        ]),
      ),
    );
  });
});

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

it("an edit releases only its record's confirmation and prevents a stale review from saving", () => {
  const fields = [
    { type: "records", id: "articles", label: "Articles", collectionId: "products" },
    {
      type: "group",
      id: "properties",
      label: "Properties",
      repeatable: true,
      recordReview: { recordsFieldId: "articles", recordKeyFieldId: "articleKey" },
      fields: [
        { type: "text", id: "articleKey", label: "Article key" },
        { type: "text", id: "temperature", label: "Temperature" },
      ],
    },
  ] satisfies ReadonlyArray<Field>;
  const confirmed: Step = {
    ...step,
    confirmedReviewRows: ["properties.rowCoral", "properties.rowBlue"],
    values: {
      articles: ["coral-tape", "blue-tape"],
      properties: ["rowCoral", "rowBlue"],
      "properties.rowCoral.articleKey": "coral-tape",
      "properties.rowCoral.temperature": "100 °C",
      "properties.rowBlue.articleKey": "blue-tape",
      "properties.rowBlue.temperature": "110 °C",
    },
  };
  const edited = withEditedStepValues(fields, confirmed, {
    ...confirmed.values,
    "properties.rowCoral.temperature": "100 °C for 30 minutes",
  });
  assert.deepEqual(
    recordReviewsOf(fields, edited)[0]?.entries.map(({ isConfirmed }) => isConfirmed),
    [false, true],
  );
  assert.include(
    confirmRecordEntry(fields, edited, {
      groupFieldId: "properties",
      recordKey: "coral-tape",
      rowId: "rowCoral",
      previousValues: reviewEntryValues(confirmed.values, "properties.rowCoral"),
      values: { temperature: "100 °C" },
    }),
    "changed while you were reviewing",
  );
});

describe("proposing a value", () => {
  const listings: Field = {
    id: "f_listings",
    label: "Listings",
    type: "records",
    collectionId: "collection01",
    isReviewed: true,
  };
  const brand: Field = { id: "f_brand", label: "Brand", type: "text", isReviewed: true };
  const proposal = (id: string, fieldKey: string, value: string, extra = {}) => ({
    id,
    fieldKey,
    value,
    whyYes: "Same width and length.",
    whyNo: "",
    author: "agent001",
    isDiscarded: false,
    createdAt: at,
    ...extra,
  });
  const reviewed: Step = {
    ...step,
    values: { f_listings: ["B0LINKED"], f_brand: "Tesa" },
    proposals: [
      proposal("proposal1", "f_listings", "B0OPEN", { score: 40 }),
      proposal("proposal2", "f_listings", "B0GONE", { isDiscarded: true }),
      proposal("proposal3", "f_brand", "Scotch", { score: 90 }),
      proposal("proposal4", "f_brand", "3M"),
    ],
  };

  it("takes one record's key at a time, never one proposed, discarded or already linked", () => {
    assert.isNull(proposalRefusal(reviewed, listings, "f_listings", "B0NEW"));
    assert.include(proposalRefusal(reviewed, listings, "f_listings", ["B0NEW"])!, "one record");
    assert.include(
      proposalRefusal(reviewed, listings, "f_listings", "B0OPEN")!,
      "already proposed",
    );
    assert.include(proposalRefusal(reviewed, listings, "f_listings", "B0GONE")!, "discarded");
    assert.include(proposalRefusal(reviewed, listings, "f_listings", "B0LINKED")!, "already holds");
  });

  it("is only for reviewed fields, and never the value a field holds", () => {
    const { isReviewed: _, ...plain } = brand;
    assert.include(proposalRefusal(reviewed, plain, "f_brand", "Pattex")!, "isn't reviewed");
    assert.include(proposalRefusal(reviewed, brand, "f_brand", "Tesa")!, "already holds");
    assert.isNull(proposalRefusal(reviewed, brand, "f_brand", "Pattex"));
  });

  it("links one more record when approved, and replaces any other value", () => {
    const [linked, , named] = reviewed.proposals!;
    assert.deepStrictEqual(approvedValue(listings, ["B0LINKED"], linked!), ["B0LINKED", "B0OPEN"]);
    assert.deepStrictEqual(approvedValue(listings, undefined, linked!), ["B0OPEN"]);
    assert.strictEqual(approvedValue(brand, "Tesa", named!), "Scotch");
  });

  it("keeps every article association when approving and removes only the unlinked record's associations", () => {
    const fieldKey = "f_listings";
    const proposed: Step = {
      ...step,
      values: { [fieldKey]: ["already-linked"] },
      recordAssociations: { [fieldKey]: { "already-linked": ["article-c"] } },
      proposals: [
        proposal("shared-offer", fieldKey, "shared-record", {
          sourceRecordKeys: ["article-b", "article-a"],
        }),
        proposal("legacy-offer", fieldKey, "legacy-record", {
          comparison: { sourceRecordKey: "article-b", assessments: [] },
        }),
        proposal("rejected-offer", fieldKey, "rejected-record", {
          sourceRecordKeys: ["article-a", "article-b"],
        }),
      ],
    };
    const approved = withReviewedProposals(proposed, listings, fieldKey, {
      approveIds: ["shared-offer"],
      discardIds: [],
    });
    assert.isNotString(approved);
    if (typeof approved === "string") return;
    assert.deepEqual(approved.approvedValue, ["already-linked", "shared-record"]);
    assert.deepEqual(approved.step.recordAssociations?.[fieldKey], {
      "already-linked": ["article-c"],
      "shared-record": ["article-a", "article-b"],
    });

    const batch = withReviewedProposals(proposed, listings, fieldKey, {
      approveIds: ["shared-offer", "legacy-offer"],
      discardIds: ["rejected-offer"],
    });
    assert.isNotString(batch);
    if (typeof batch === "string") return;
    assert.deepEqual(batch.approvedValue, ["already-linked", "shared-record", "legacy-record"]);
    assert.deepEqual(batch.step.recordAssociations?.[fieldKey], {
      "already-linked": ["article-c"],
      "shared-record": ["article-a", "article-b"],
      "legacy-record": ["article-b"],
    });
    const corrected = withRecordAssociation(batch.step, fieldKey, "legacy-record", ["article-a"]);
    const unlinked = retainRecordAssociations(corrected, fieldKey, [
      "shared-record",
      "legacy-record",
    ]);
    assert.deepEqual(unlinked.recordAssociations?.[fieldKey], {
      "shared-record": ["article-a", "article-b"],
      "legacy-record": ["article-a"],
    });
  });

  it("reviews the open proposals best first, unscored last", () => {
    assert.deepStrictEqual(
      openProposals(reviewed.proposals).map(({ id }) => id),
      ["proposal3", "proposal1", "proposal4"],
    );
  });
});

describe("discrepancy filter cascade and batch discards", () => {
  const products: Field = {
    id: "competitor_products",
    label: "Competitor products",
    type: "records",
    collectionId: "collection01",
    isReviewed: true,
  };
  const makeProposal = (id: string, value: string, extra = {}) => ({
    id,
    fieldKey: "competitor_products",
    value,
    whyYes: "Comparable tape.",
    whyNo: "",
    author: "agent001",
    isDiscarded: false,
    createdAt: at,
    ...extra,
  });
  const makeFilter = (
    id: string,
    question: string,
    proposalIds: ReadonlyArray<string>,
  ): ProposalFilter => ({
    id,
    fieldKey: "competitor_products",
    question,
    driftSummary: question,
    items: proposalIds.map((proposalId) => ({ proposalId, reason: `Matched ${proposalId}` })),
  });

  it("validates filters against open proposals on a reviewed field, allowing 0, single-item, and >6 questions", () => {
    const withProposals: Step = {
      ...step,
      proposals: [
        makeProposal("prop0001", "sku-1"),
        makeProposal("prop0002", "sku-2", { isDiscarded: true }),
      ],
    };
    const plain: Field = { id: "notes", label: "Notes", type: "text" };
    assert.include(
      proposalFiltersRefusal(withProposals, plain, "notes", []) ?? "",
      "isn't reviewed",
    );
    assert.isNull(proposalFiltersRefusal(withProposals, products, "competitor_products", []));
    // Single-tape questions and more than 6 questions are both allowed.
    const sevenSingle = Array.from({ length: 7 }, (_, index) =>
      makeFilter(`filter0${index}`, `Question ${index}`, ["prop0001"]),
    );
    assert.isNull(
      proposalFiltersRefusal(withProposals, products, "competitor_products", sevenSingle),
    );
    assert.include(
      proposalFiltersRefusal(withProposals, products, "competitor_products", [
        makeFilter("filter01", "Discarded", ["prop0002"]),
      ]) ?? "",
      "open proposal",
    );
    assert.include(
      proposalFiltersRefusal(withProposals, products, "competitor_products", [
        makeFilter("filter01", "Duplicate", ["prop0001", "prop0001"]),
      ]) ?? "",
      "at most once",
    );
  });

  it("keeps candidates in play when a discrepancy is accepted and excludes only checked items on later questions", () => {
    const open = [makeProposal("tape-acrylic", "sku-a"), makeProposal("tape-rubber", "sku-b")];
    const filters = [
      makeFilter("f-temp", "Accept 90 °C maximum temperature?", ["tape-acrylic", "tape-rubber"]),
      makeFilter("f-adhesive", "Accept acrylic adhesive?", ["tape-acrylic"]),
    ];
    const afterTemp = evaluateProposalFilterCascade(open, filters, {
      "f-temp": {
        decision: "accept",
        shownIds: ["tape-acrylic", "tape-rubber"],
        excludedIds: [],
      },
    });
    assert.deepStrictEqual(afterTemp.inPlayIds, ["tape-acrylic", "tape-rubber"]);
    assert.deepStrictEqual(afterTemp.excludedIds, []);
    assert.strictEqual(afterTemp.nextUnansweredIndex, 1);
    assert.deepStrictEqual(
      afterTemp.steps[1]?.liveItems.map(({ proposalId }) => proposalId),
      ["tape-acrylic"],
    );

    const afterAdhesive = evaluateProposalFilterCascade(open, filters, {
      "f-temp": {
        decision: "accept",
        shownIds: ["tape-acrylic", "tape-rubber"],
        excludedIds: [],
      },
      "f-adhesive": {
        decision: "exclude",
        shownIds: ["tape-acrylic"],
        excludedIds: ["tape-acrylic"],
      },
    });
    assert.deepStrictEqual(afterAdhesive.excludedIds, ["tape-acrylic"]);
    assert.deepStrictEqual(afterAdhesive.inPlayIds, ["tape-rubber"]);
    assert.strictEqual(afterAdhesive.nextUnansweredIndex, -1);
  });

  it("invalidates downstream answers when going back changes affected items, while preserving unaffected answers", () => {
    const open = [
      makeProposal("w-acr", "w-acr"),
      makeProposal("a-acr-1", "a-acr-1"),
      makeProposal("a-acr-2", "a-acr-2"),
      makeProposal("a-acr-3", "a-acr-3"),
      makeProposal("a-rub-1", "a-rub-1"),
      makeProposal("a-rub-2", "a-rub-2"),
      makeProposal("a-rub-3", "a-rub-3"),
      makeProposal("a-rub-4", "a-rub-4"),
      makeProposal("f-conf-1", "f-conf-1"),
    ];
    const filters = [
      makeFilter("f-acrylic", "Acrylic?", ["w-acr", "a-acr-1", "a-acr-2", "a-acr-3"]),
      makeFilter("f-temp", "Missing max temp?", [
        "a-acr-1",
        "a-acr-2",
        "a-acr-3",
        "a-rub-1",
        "a-rub-2",
        "a-rub-3",
        "a-rub-4",
      ]),
      makeFilter("f-conflict", "Unresolved conflict?", ["f-conf-1"]),
    ];
    // Reviewer excluded acrylic (4), then excluded the remaining 4 missing-temp tapes and the conflict.
    const initial = evaluateProposalFilterCascade(open, filters, {
      "f-acrylic": {
        decision: "exclude",
        shownIds: ["w-acr", "a-acr-1", "a-acr-2", "a-acr-3"],
        excludedIds: ["w-acr", "a-acr-1", "a-acr-2", "a-acr-3"],
      },
      "f-temp": {
        decision: "exclude",
        shownIds: ["a-rub-1", "a-rub-2", "a-rub-3", "a-rub-4"],
        excludedIds: ["a-rub-1", "a-rub-2", "a-rub-3", "a-rub-4"],
      },
      "f-conflict": {
        decision: "exclude",
        shownIds: ["f-conf-1"],
        excludedIds: ["f-conf-1"],
      },
    });
    assert.strictEqual(initial.nextUnansweredIndex, -1);
    assert.strictEqual(initial.steps[1]?.liveItems.length, 4);

    // Going back to accept acrylic expands f-temp from 4 to 7, invalidating f-temp but keeping f-conflict.
    const afterBack = evaluateProposalFilterCascade(open, filters, {
      "f-acrylic": {
        decision: "accept",
        shownIds: ["w-acr", "a-acr-1", "a-acr-2", "a-acr-3"],
        excludedIds: [],
      },
      "f-temp": {
        decision: "exclude",
        shownIds: ["a-rub-1", "a-rub-2", "a-rub-3", "a-rub-4"],
        excludedIds: ["a-rub-1", "a-rub-2", "a-rub-3", "a-rub-4"],
      },
      "f-conflict": {
        decision: "exclude",
        shownIds: ["f-conf-1"],
        excludedIds: ["f-conf-1"],
      },
    });
    assert.strictEqual(afterBack.steps[1]?.liveItems.length, 7);
    assert.isTrue(afterBack.steps[1]?.isInvalidated);
    assert.isNull(afterBack.steps[1]?.answer);
    assert.strictEqual(afterBack.nextUnansweredIndex, 1);
    // f-temp's stale exclusion is not applied, while unaffected f-conflict stays answered.
    assert.deepStrictEqual(afterBack.excludedIds, ["f-conf-1"]);
    assert.isNotNull(afterBack.steps[2]?.answer);
  });

  it("exempts unchecked items only from that question, skips zero-item questions, and ignores stale ids", () => {
    const open = [makeProposal("p1", "sku-1"), makeProposal("p2", "sku-2")];
    const filters = [
      makeFilter("f1", "First?", ["p1", "p2", "stale-id"]),
      makeFilter("f2", "Second?", ["p1"]),
    ];
    // Unchecking p1 in f1 leaves p1 in play for f2.
    const partial = evaluateProposalFilterCascade(open, filters, {
      f1: { decision: "exclude", shownIds: ["p1", "p2"], excludedIds: ["p2"] },
    });
    assert.deepStrictEqual(
      partial.steps.map((s) => s.filter.id),
      ["f1", "f2"],
    );
    assert.deepStrictEqual(
      partial.steps[1]?.liveItems.map(({ proposalId }) => proposalId),
      ["p1"],
    );
    // Excluding both in f1 drops f2 to 0 remaining items and skips it.
    const allExcluded = evaluateProposalFilterCascade(open, filters, {
      f1: { decision: "exclude", shownIds: ["p1", "p2"], excludedIds: ["p1", "p2"] },
    });
    assert.deepStrictEqual(
      allExcluded.steps.map((s) => s.filter.id),
      ["f1"],
    );
  });

  it("approves survivors and discards excluded proposals atomically while preserving prior decisions", () => {
    const initial: Step = {
      ...step,
      values: { competitor_products: ["approved-sku"] },
      proposals: [
        makeProposal("tape-acrylic", "sku-a"),
        makeProposal("tape-rubber", "sku-b"),
        makeProposal("already-gone", "sku-c", { isDiscarded: true }),
      ],
    };
    const updated = withReviewedProposals(initial, products, "competitor_products", {
      approveIds: ["tape-rubber"],
      discardIds: ["tape-acrylic"],
    });
    assert.isNotString(updated);
    if (typeof updated !== "string") {
      assert.deepStrictEqual(updated.approvedValue, ["approved-sku", "sku-b"]);
      assert.deepStrictEqual(
        updated.step.proposals?.map(({ id, isDiscarded }) => [id, isDiscarded]),
        [
          ["tape-acrylic", true],
          ["already-gone", true],
        ],
      );
    }
    assert.isString(
      withReviewedProposals(initial, products, "competitor_products", {
        approveIds: [],
        discardIds: [],
      }),
    );
    assert.isString(
      withReviewedProposals(initial, products, "competitor_products", {
        approveIds: ["tape-acrylic"],
        discardIds: ["tape-acrylic"],
      }),
    );
    assert.isString(
      withReviewedProposals(initial, products, "competitor_products", {
        approveIds: [],
        discardIds: ["already-gone"],
      }),
    );
    assert.isString(
      withReviewedProposals(initial, products, "other_field", {
        approveIds: [],
        discardIds: ["tape-acrylic"],
      }),
    );
  });
});

it("requires confirmation for completion and comparison unless the review makes it optional", () => {
  const mapping = {
    stepId: root.id,
    reviewId: "reviews",
    tableId: "criteria",
    nameId: "trait-name",
    valueId: "trait-value",
  };
  const records: Field = {
    type: "records",
    id: "articles",
    label: "Articles",
    collectionId: "catalog",
  };
  const review: Field = {
    type: "group",
    id: "reviews",
    label: "Reviews",
    repeatable: true,
    recordReview: { recordsFieldId: "articles", recordKeyFieldId: "article" },
    fields: [
      { type: "text", id: "article", label: "Article" },
      {
        type: "group",
        id: "criteria",
        label: "Criteria",
        repeatable: true,
        fields: [
          { type: "text", id: "trait-name", label: "Name" },
          { type: "text", id: "trait-value", label: "Value" },
        ],
      },
    ],
  };
  const source = {
    ...step,
    confirmedReviewRows: ["reviews.row-first"],
    values: {
      articles: ["article-one", "article-two"],
      reviews: ["row-first", "row-second"],
      "reviews.row-first.article": "article-one",
      "reviews.row-second.article": "article-two",
      "reviews.row-first.criteria": ["row-test"],
      "reviews.row-first.criteria.row-test.trait-name": "UV",
      "reviews.row-first.criteria.row-test.trait-value": "7 days",
      "reviews.row-second.criteria": ["row-test"],
      "reviews.row-second.criteria.row-test.trait-name": "Heat",
      "reviews.row-second.criteria.row-test.trait-value": "100 °C",
    },
  };
  const inputs = [
    { source, field: review },
    { source, field: records },
  ];
  const field = { ...records, comparisonCriteria: mapping };
  const comparison = {
    sourceRecordKey: "article-one",
    assessments: [
      {
        criterionId: "row-test",
        status: "different" as const,
        value: "No",
        evidence: "Technical sheet",
      },
    ],
  };
  assert.deepEqual(getComparisonSources(mapping, inputs), {
    recordsIndex: 1,
    records: [
      { recordKey: "article-one", criteria: [{ id: "row-test", name: "UV", value: "7 days" }] },
    ],
  });
  assert.isUndefined(getComparisonSources(mapping, inputs.slice(0, 1)));
  assert.isNull(getComparisonRefusal(field, inputs, comparison));
  assert.match(
    getComparisonRefusal(field, inputs, { ...comparison, assessments: [] }) ?? "",
    /Assess every criterion/,
  );
  assert.isNull(
    getComparisonRefusal(field, inputs, {
      ...comparison,
      assessments: [
        { criterionId: "row-test", status: "missing", evidence: "UV test unavailable" },
      ],
    }),
  );
  assert.isNotNull(
    getComparisonRefusal(field, inputs, { ...comparison, sourceRecordKey: "article-two" }),
  );
  assert.isNotNull(
    getComparisonRefusal(field, inputs, {
      ...comparison,
      assessments: [...comparison.assessments, ...comparison.assessments],
    }),
  );

  const reviewStep = definition(root.id, [], { fields: [records, review] });
  assert.strictEqual(stepCompletionRefusal(reviewStep, ticket, source), "record_review_pending");
  const confirmed = {
    ...source,
    confirmedReviewRows: [...source.confirmedReviewRows, "reviews.row-second"],
  };
  assert.isNull(stepCompletionRefusal(reviewStep, ticket, confirmed));
  assert.deepEqual(
    getComparisonSources(mapping, [
      { source: confirmed, field: review },
      { source: confirmed, field: records },
    ])?.records.map(({ recordKey }) => recordKey),
    ["article-one", "article-two"],
  );

  const optionalReview = {
    ...review,
    recordReview: { ...review.recordReview!, isConfirmationOptional: true },
  };
  const optionalStep = definition(root.id, [], { fields: [records, optionalReview] });
  const optionalInputs = [
    { source, field: optionalReview },
    { source, field: records },
  ];
  assert.isNull(stepCompletionRefusal(optionalStep, ticket, source));
  assert.isNull(
    getComparisonRefusal(field, optionalInputs, { ...comparison, sourceRecordKey: "article-two" }),
  );
  assert.deepEqual(getComparisonSources(mapping, optionalInputs)?.records[1], {
    recordKey: "article-two",
    criteria: [{ id: "row-test", name: "Heat", value: "100 °C" }],
  });
  assert.strictEqual(
    stepCompletionRefusal(optionalStep, ticket, {
      ...source,
      values: { ...source.values, reviews: ["row-first"] },
    }),
    "step_incomplete",
  );
});
