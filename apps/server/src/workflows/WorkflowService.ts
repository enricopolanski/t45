import type { Automation, AutomationId } from "@t45/contracts/models/Automation";
import { AutomationRepository } from "../automations/AutomationRepository.ts";
import type { CurrentActor } from "@t45/contracts/Authorization";
import { ChatService } from "../chats/ChatService.ts";
import * as WorkflowAssistant from "./WorkflowAssistant.ts";
import type { Workflows } from "@t45/contracts/resources/Workflows";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import { ChatRepository } from "../chats/ChatRepository.ts";
import { ChatEvents } from "../chats/ChatEvents.ts";
import type { ChatId } from "@t45/contracts/models/Chat";
import type { AutomationOrigin } from "@t45/contracts/models/ChatOrigin";
import { canWorkSteps } from "@t45/contracts/models/Agent";
import type { Attachment } from "@t45/contracts/models/Attachment";
import {
  type Notification,
  NotificationId,
  type NotificationKind,
} from "@t45/contracts/models/Notification";
import { generateId } from "@t45/contracts/models/primitives";
import { Refused as UserRefused } from "@t45/contracts/models/User";
import {
  stepInTicket,
  childSteps,
  ancestorSteps,
  putTicketStep,
  completeTicketStep,
  currentStep,
  ticketStartRefusal,
  definitionChangeRefusal,
  canUpdateDefinition,
  fieldPathSurvives,
  stepAfterDefinitionChange,
  subStepsToEnter,
  fieldValueRefusal,
  type WorkflowActor,
  findStep,
  rowIds,
  groupRows,
  resolveFieldPath,
  buildPreviousStepsFieldViews,
  isActionable,
  isLive,
  isAdmin,
  oversees,
  isInvolved,
  canViewTicket,
  stepCompletionRefusal,
  lastAdminRefusal,
  Step,
  type StepDefinition,
  type StepField,
  type Ticket,
  type Workflow,
  type WorkflowDefinition,
  Refused as WorkflowRefused,
} from "@t45/contracts/models/Workflow";
import type { AssignmentView } from "@t45/contracts/resources/Assignments";
import { NotFound } from "@t45/contracts/resources/errors";
import type { NotificationView } from "@t45/contracts/resources/Notifications";
import type { FieldView, TicketSummaryView } from "@t45/contracts/resources/Workflows";
import { StepView } from "@t45/contracts/resources/Workflows";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { AgentRepository } from "../agents/AgentRepository.ts";
import { AttachmentRepository } from "../attachments/AttachmentRepository.ts";
import { UserRepository } from "../org/UserRepository.ts";
import { NotificationRepository } from "./NotificationRepository.ts";
import { TicketRepository } from "./TicketRepository.ts";
import { WorkflowDefinitionRepository } from "./WorkflowDefinitionRepository.ts";
import { WorkflowRepository } from "./WorkflowRepository.ts";

type Caller = string | Extract<CurrentActor["Service"], { agentId: string }>;
type WorkflowRpc = RpcGroup.Rpcs<typeof Workflows>;
type Payload<Tag extends string> = Rpc.Payload<Rpc.ExtractTag<WorkflowRpc, `workflows.${Tag}`>>;

const toFile = ({ id, name }: Attachment) => ({ id, name });

const summaryOf = (ticket: Ticket): TicketSummaryView => ({
  ...ticket,
  currentStep: currentStep(ticket),
});

const millis = (at: DateTime.Utc | null) => (at === null ? Infinity : DateTime.toEpochMillis(at));

const NOTIFICATIONS_LIMIT = 50;

const STEP_FILE_TYPE = "application/octet-stream";

const stepFileForChat = (file: Attachment) => ({
  type: "file" as const,
  id: file.id,
  name: file.name,
  mimeType: STEP_FILE_TYPE,
  sizeBytes: file.sizeBytes,
});

const sameStepView = Schema.toEquivalence(StepView);

interface Work {
  readonly workflow: Workflow;
  readonly definition: WorkflowDefinition;
  ticket: Ticket;
}

const make = Effect.gen(function* () {
  const definitions = yield* WorkflowDefinitionRepository;
  const workflows = yield* WorkflowRepository;
  const tickets = yield* TicketRepository;
  const notifications = yield* NotificationRepository;
  const users = yield* UserRepository;
  const agents = yield* AgentRepository;
  const automations = yield* AutomationRepository;
  const files = yield* AttachmentRepository;
  const buildCurrentStepFieldViews = (
    fields: ReadonlyArray<StepField>,
    prefix: string,
    values: Step["values"],
  ): Effect.Effect<Array<FieldView>> =>
    Effect.forEach(fields, (field) =>
      Effect.gen(function* () {
        const path = prefix ? `${prefix}.${field.id}` : field.id;
        const value = values[path];
        const rows =
          field.type === "group"
            ? yield* Effect.forEach(groupRows(field, value), (rowId) =>
                Effect.map(
                  buildCurrentStepFieldViews(
                    field.fields,
                    rowId === null ? path : `${path}.${rowId}`,
                    values,
                  ),
                  (children) => ({ id: rowId, fields: children }),
                ),
              )
            : [];
        const file =
          field.type === "file" && typeof value === "string" ? yield* files.get(value) : null;
        return {
          file: file === null ? null : toFile(file),
          key: path,
          label: field.label,
          description: field.description ?? "",
          type: field.type,
          options: field.type === "select" ? field.options : [],
          value: field.type === "group" ? null : (value ?? null),
          repeatable: field.type === "group" && field.repeatable,
          rows,
        };
      }),
    );

  const chats = yield* ChatService;
  const chatRepository = yield* ChatRepository;
  const changes = yield* (yield* ChatEvents).subscribe(
    (change) => change.kind === "chat" || change.kind === "posted",
  );
  yield* changes.pipe(
    Stream.runForEach((change) =>
      Effect.gen(function* () {
        if (change.kind === "missed") return yield* tickets.publishChange();
        const origin = yield* chatRepository.origins.get(change.chatId);
        if (origin?.kind === "automation" && origin.trigger.type === "step")
          yield* tickets.publishChange(origin.trigger.ticketId);
      }),
    ),
    Effect.forkScoped,
  );
  const { transaction } = tickets;
  const workflowAccess = yield* WorkflowAssistant.makeAccess;
  const loadWorkflow = Effect.fnUntraced(function* (caller: Caller, workflowId: string) {
    if (typeof caller === "string") return yield* workflowAccess.load(caller, workflowId);
    if (caller.origin.kind !== "conversation" || caller.origin.workflowId !== workflowId)
      return yield* new NotFound();
    return yield* workflowAccess.load(caller.origin.ownerUserId, workflowId);
  });
  const resolvePerson = (caller: Caller, workflowId: string) =>
    typeof caller === "string"
      ? Effect.succeed(caller)
      : loadWorkflow(caller, workflowId).pipe(Effect.map(({ actor }) => actor.id));

  const found = <A>(effect: Effect.Effect<A | null>) =>
    effect.pipe(
      Effect.filterOrFail(
        (value) => value !== null,
        () => new NotFound(),
      ),
    );

  const actorOf = (id: string) =>
    users.get(id).pipe(
      Effect.map((user): WorkflowActor => ({
        id,
        isOrgAdmin: user?.state === "active" && user.role === "admin",
      })),
    );
  const isActivePerson = (id: string) =>
    users.get(id).pipe(Effect.map((user) => user?.state === "active"));

  const requireValidPerson = Effect.fnUntraced(function* (id: string) {
    if (!(yield* isActivePerson(id))) {
      return yield* new WorkflowRefused({ reason: "invalid_people_ref" });
    }
  });

  const activeAdminIds = (workflow: Workflow) =>
    Effect.filter(workflow.adminUserIds, isActivePerson);

  const notify = Effect.fnUntraced(function* (input: {
    readonly kind: NotificationKind;
    readonly to: string | null;
    readonly workflow: Workflow;
    readonly step: Step;
    readonly actorId: string | null;
  }) {
    if (input.to === null || input.to === input.actorId) return;
    if ((yield* users.get(input.to)) === null) return;
    yield* notifications.insert(input.to, {
      id: NotificationId.make(generateId()),
      kind: input.kind,
      stepId: input.step.id,
      workflowId: input.workflow.id,
      isRead: false,
      createdAt: yield* DateTime.now,
    });
  });

  const tellAdmins = Effect.fnUntraced(function* (
    workflow: Workflow,
    kind: "needs_responsible" | "names_deactivated",
  ) {
    const at = yield* DateTime.now;
    for (const userId of yield* activeAdminIds(workflow)) {
      if (yield* notifications.hasUnreadNotice({ userId, kind, workflowId: workflow.id })) continue;
      yield* notifications.insert(userId, {
        id: NotificationId.make(generateId()),
        kind,
        stepId: null,
        workflowId: workflow.id,
        isRead: false,
        createdAt: at,
      });
    }
  });

  const definitionOf = (work: Work, step: Step) =>
    findStep(work.definition.steps, step.stepDefinitionId)?.step ?? null;

  const nameOf = (work: Work, step: Step) => definitionOf(work, step)?.name ?? work.workflow.name;

  const stepIn = (work: Work, stepId: string) => stepInTicket(work.ticket, stepId);
  const putStep = (work: Work, step: Step) => {
    work.ticket = putTicketStep(work.ticket, step);
  };

  const save = (work: Work) => tickets.update(work.ticket);
  const workOf = Effect.fnUntraced(function* (ticket: Ticket) {
    const workflow = yield* found(workflows.get(ticket.workflowId));
    const definition = yield* found(definitions.get(workflow.definitionId));
    return { workflow, definition, ticket };
  });

  const loadTicket = (ticketId: string) =>
    found(tickets.get(ticketId)).pipe(Effect.flatMap(workOf));

  const loadStep = Effect.fnUntraced(function* (stepId: string) {
    const work = yield* found(tickets.getByStepId(stepId)).pipe(Effect.flatMap(workOf));
    const step = stepIn(work, stepId);
    if (step === null) return yield* new NotFound();
    return { work, step };
  });

  const requireInvolved = Effect.fnUntraced(function* (work: Work, actorId: string) {
    if (isInvolved(yield* actorOf(actorId), work.workflow, work.ticket)) return;
    return yield* work.workflow.isPublic
      ? new WorkflowRefused({ reason: "not_overseer" })
      : new NotFound();
  });

  const loadAutomationStep = Effect.fnUntraced(function* (origin: AutomationOrigin) {
    if (origin.trigger.type !== "step") return yield* new NotFound();
    const work = yield* loadTicket(origin.trigger.ticketId);
    const step = stepIn(work, origin.trigger.stepId);
    if (step === null || !step.automationIds.includes(origin.trigger.automationId))
      return yield* new NotFound();
    return { work, step };
  });
  const loadForCommand = Effect.fnUntraced(function* (actorId: string, stepId: string) {
    const loaded = yield* loadStep(stepId);
    if (loaded.work.ticket.status.type !== "open")
      return yield* new WorkflowRefused({ reason: "ticket_not_open" });
    yield* requireInvolved(loaded.work, actorId);
    return loaded;
  });
  const requireActionable = (step: Step) =>
    isActionable(step)
      ? Effect.void
      : Effect.fail(new WorkflowRefused({ reason: "step_not_actionable" }));
  const requireWorkingStep = (work: Work, step: Step) =>
    work.ticket.status.type === "open"
      ? requireActionable(step)
      : Effect.fail(new WorkflowRefused({ reason: "ticket_not_open" }));

  const requireReason = (reason: string) => {
    const trimmed = reason.trim();
    return trimmed
      ? Effect.succeed(trimmed)
      : Effect.fail(new WorkflowRefused({ reason: "reason_required" }));
  };

  const requireAdmin = (actor: WorkflowActor, workflow: Workflow) =>
    isAdmin(actor, workflow)
      ? Effect.succeed(workflow)
      : Effect.fail(new WorkflowRefused({ reason: "not_workflow_admin" }));

  const instancesOf = Effect.fnUntraced(function* (list: ReadonlyArray<Workflow>) {
    const byId = new Map(
      (yield* definitions.list).map((definition) => [definition.id, definition]),
    );
    return list.flatMap((workflow) => {
      const definition = byId.get(workflow.definitionId);
      return definition === undefined ? [] : [{ workflow, definition }];
    });
  });

  const stepRuns = (work: Work, step: Step) =>
    chatRepository.origins.listByTrigger({ ticketId: work.ticket.id, stepId: step.id });
  const stopStepRuns = Effect.fnUntraced(function* (
    work: Work,
    step: Step,
    matches: (automationId: AutomationId) => boolean = () => true,
  ) {
    const stopped: Array<ChatId> = [];
    for (const run of yield* stepRuns(work, step)) {
      if (matches(run.trigger.automationId) && (yield* chats.requestStop(run.chatId)))
        stopped.push(run.chatId);
    }
    return stopped;
  });

  const buildAutomationContext = Effect.fnUntraced(function* (work: Work, step: Step) {
    const definition = definitionOf(work, step);
    const containing = ancestorSteps(work.ticket, step);
    const root = containing.at(-1) ?? step;
    const inputs = [];
    for (const { source, definition: from, field } of buildPreviousStepsFieldViews(
      work.definition.steps,
      root.stepDefinitionId,
      work.ticket.steps,
    )) {
      const [view] = yield* buildCurrentStepFieldViews([field], "", source.values);
      if (view !== undefined) inputs.push({ stepName: from.name, ...view });
    }
    return {
      workflowName: work.workflow.name,
      ticketTitle: work.ticket.title,
      ticketDescription: work.ticket.description,
      stepName: nameOf(work, step),
      instructions: definition?.instructions ?? "",
      parents: containing.toReversed().map((parent) => ({
        name: nameOf(work, parent),
        instructions: definitionOf(work, parent)?.instructions ?? "",
      })),
      inputs,
      fields: yield* buildStepFieldViews(work, step),
      comments: (yield* tickets.comments(step.id)).map(({ author, body, createdAt }) => ({
        author,
        body,
        createdAt: DateTime.formatIso(createdAt),
      })),
      attachments: (yield* files.forStep(step.id))
        .filter((file) => file.fieldKey === null)
        .map(toFile),
    };
  });

  const buildFieldFileIds = (fields: ReadonlyArray<FieldView>): ReadonlyArray<string> =>
    fields.flatMap((field) =>
      field.file === null
        ? field.rows.flatMap((row) => buildFieldFileIds(row.fields))
        : [field.file.id],
    );

  const formatAutomationContext = (brief: unknown) =>
    ["```json", JSON.stringify(brief, null, 2), "```"].join("\n");

  const buildAutomationInput = Effect.fnUntraced(function* (
    work: Work,
    step: Step,
    automation: Automation,
  ) {
    const brief = yield* buildAutomationContext(work, step);
    const instructions = brief.instructions.trim();
    const subject =
      brief.parents.length === 0
        ? `the step "${brief.stepName}"`
        : `the sub-step "${brief.stepName}" of ${brief.parents.map((parent) => `"${parent.name}"`).join(" › ")}`;
    return {
      text: [
        `You contribute to ${subject} of "${brief.ticketTitle}" in the workflow "${brief.workflowName}". The step is below as JSON: its instructions, the fields of earlier steps it reads, its own fields, its comments and its files. That is all you can see of this ticket.`,
        "Fill the step's fields with step_set_field, report progress or results with step_comment, and attach files with step_attach. Each tool returns the actual operation result. When your contribution is finished, end the conversation.",
        "You work in a folder of your own. Follow AGENTS.md if it is there.",
        instructions ? `Instructions for this step:\n${instructions}` : "",
        formatAutomationContext(brief),
        `Your automation: ${automation.prompt}. Other people and automations may work on this step at the same time. Do not wait for their work or unrelated fields and sub-steps to be complete.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      attachments: (yield* files.forIds([
        ...new Set([
          ...buildFieldFileIds([...brief.inputs, ...brief.fields]),
          ...brief.attachments.map((file) => file.id),
        ]),
      ])).map(stepFileForChat),
    };
  });
  const automationEnded = Effect.fnUntraced(function* (chatId: ChatId, actorId: string | null) {
    const origin = yield* chatRepository.origins.get(chatId);
    if (origin?.kind !== "automation" || origin.trigger.type !== "step") return;
    const loaded = yield* loadAutomationStep(origin).pipe(Effect.option);
    if (Option.isNone(loaded)) return;
    const { work, step } = loaded.value;
    yield* notify({
      kind: "automation_ended",
      to: step.assignee,
      workflow: work.workflow,
      step,
      actorId,
    });
  });
  const enterStep = Effect.fnUntraced(function* (
    work: Work,
    definition: StepDefinition,
    parent: Step | null,
    inherited: string | null,
    actorId: string | null,
  ): Effect.fn.Return<Step> {
    const defaults = work.workflow.defaultAssignments[definition.id];
    const requested = defaults?.assignee ?? inherited;
    const step = Step.make({
      stepDefinitionId: definition.id,
      status: { type: "working", at: yield* DateTime.now },
      parentStepId: parent?.id ?? null,
      assignee: requested !== null && (yield* isActivePerson(requested)) ? requested : null,
      automationIds: defaults?.automationIds ?? [],
      values: {},
    });
    putStep(work, step);
    yield* notify({ kind: "to_do", to: step.assignee, workflow: work.workflow, step, actorId });
    for (const child of definition.subSteps) {
      yield* enterStep(work, child, step, step.assignee, actorId);
    }
    return step;
  });

  const resolveField = (work: Work, step: Step, path: string) => {
    const resolved = resolveFieldPath(definitionOf(work, step)?.fields ?? [], path);
    if (
      resolved === null ||
      resolved.rows.some((row) => !rowIds(step.values[row.groupPath]).includes(row.rowId))
    ) {
      return Effect.fail(new WorkflowRefused({ reason: "invalid_field_value" }));
    }
    return Effect.succeed(resolved.field);
  };

  const withoutRemovedRows = Effect.fnUntraced(function* (
    step: Step,
    path: string,
    keep: ReadonlyArray<string>,
  ) {
    const removed = (key: string | null) =>
      key !== null &&
      key.startsWith(`${path}.`) &&
      !keep.includes(key.slice(path.length + 1).split(".")[0] ?? "");
    for (const file of yield* files.forStep(step.id)) {
      if (removed(file.fieldKey)) yield* files.detach(file.id);
    }
    return Object.fromEntries(Object.entries(step.values).filter(([key]) => !removed(key)));
  });

  const moveOntoSteps = Effect.fnUntraced(function* (work: Work, actorId: string) {
    const refusal = definitionChangeRefusal(work.ticket, work.definition.steps);
    if (refusal !== null) return yield* new WorkflowRefused({ reason: refusal });
    for (const step of work.ticket.steps) {
      const definition = definitionOf(work, step);
      putStep(work, stepAfterDefinitionChange(step, definition));
      for (const file of yield* files.forStep(step.id)) {
        if (file.fieldKey !== null && !fieldPathSurvives(definition, file.fieldKey))
          yield* files.detach(file.id);
      }
    }
    const current = currentStep(work.ticket);
    const definition = current === null ? null : definitionOf(work, current);
    if (current !== null && definition !== null) {
      for (const missing of subStepsToEnter(work.ticket, current, definition)) {
        yield* enterStep(
          work,
          missing.definition,
          missing.parent,
          missing.parent.assignee,
          actorId,
        );
      }
    }
    yield* save(work);
  });

  const buildStepFieldViews = (work: Work, step: Step) =>
    buildCurrentStepFieldViews(definitionOf(work, step)?.fields ?? [], "", step.values);

  const listInstances = Effect.fnUntraced(function* (actorId: string) {
    const actor = yield* actorOf(actorId);
    const overseen = (yield* workflows.list).filter((workflow) => oversees(actor, workflow));
    return (yield* instancesOf(overseen)).map((instance) => ({
      ...instance,
      canManage: isAdmin(actor, instance.workflow),
    }));
  });

  const listStartableInstances = Effect.fnUntraced(function* (actorId: string) {
    const actor = yield* actorOf(actorId);
    return (yield* instancesOf(yield* workflows.list))
      .filter(
        ({ workflow, definition }) => ticketStartRefusal(actor, workflow, definition) === null,
      )
      .map(({ workflow }) => workflow);
  });

  const getInstance = Effect.fnUntraced(function* (actorId: string, idOrSlug: string) {
    const workflow = yield* requireAdmin(
      yield* actorOf(actorId),
      yield* found(workflows.getByIdOrSlug(idOrSlug)),
    );
    return { workflow, definition: yield* found(definitions.get(workflow.definitionId)) };
  });

  const getInstanceBoard = Effect.fnUntraced(function* (actorId: string, idOrSlug: string) {
    const actor = yield* actorOf(actorId);
    const workflow = yield* found(workflows.getByIdOrSlug(idOrSlug));
    if (!workflow.isPublic && !oversees(actor, workflow)) {
      return yield* new WorkflowRefused({ reason: "not_overseer" });
    }
    return {
      workflow,
      definition: yield* found(definitions.get(workflow.definitionId)),
      tickets: (yield* tickets.listOpen(workflow.id)).map(summaryOf),
    };
  });

  const createDefinition = Effect.fnUntraced(function* (input: Payload<"createDefinition">) {
    const definition: WorkflowDefinition = {
      id: generateId(),
      name: input.name,
      steps: input.steps ?? [],
      isArchived: false,
    };
    yield* definitions.insert(definition);
    return { definitionId: definition.id };
  });

  const updateDefinition = Effect.fnUntraced(function* (
    actorId: string,
    { definitionId, ...changes }: Payload<"updateDefinition">,
  ) {
    const definition = yield* found(definitions.get(definitionId));
    const actor = yield* actorOf(actorId);
    const running = yield* workflows.listForDefinition(definition.id);
    if (!canUpdateDefinition(actor, running)) {
      return yield* new WorkflowRefused({ reason: "not_workflow_admin" });
    }
    const next: WorkflowDefinition = {
      ...definition,
      ...changes,
    };
    yield* definitions.update(next);
    for (const workflow of running) {
      yield* tickets.publishChange(workflow.id);
      if (changes.steps === undefined) continue;
      for (const ticket of yield* tickets.listOpen(workflow.id)) {
        yield* moveOntoSteps({ workflow, definition: next, ticket }, actorId);
      }
    }
  }, transaction);

  const createInstance = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"createInstance">,
  ) {
    yield* requireValidPerson(input.responsible);
    const definition = yield* found(definitions.get(input.definitionId));
    if (definition.isArchived) {
      return yield* new WorkflowRefused({ reason: "workflow_archived" });
    }
    const workflow: Workflow = {
      id: generateId(),
      definitionId: definition.id,
      name: input.name ?? definition.name,
      responsible: input.responsible,
      adminUserIds: [actorId],
      defaultAssignments: {},
      slug: null,
      isPublic: false,
      isArchived: false,
    };
    yield* workflows.insert(workflow);
    return { workflowId: workflow.id };
  }, transaction);

  const updateInstance = Effect.fnUntraced(function* (
    actorId: string,
    { workflowId, ...changes }: Payload<"updateInstance">,
  ) {
    const actor = yield* actorOf(actorId);
    const workflow = yield* requireAdmin(actor, yield* found(workflows.get(workflowId)));
    if (changes.responsible !== undefined) yield* requireValidPerson(changes.responsible);
    for (const assignment of Object.values(changes.defaultAssignments ?? {})) {
      yield* validateAutomations(assignment.automationIds);
      if (assignment.assignee !== null) yield* requireValidPerson(assignment.assignee);
    }
    const adminUserIds = [...new Set(changes.adminUserIds ?? workflow.adminUserIds)];
    for (const id of adminUserIds) {
      if (!workflow.adminUserIds.includes(id)) yield* requireValidPerson(id);
    }
    if (lastAdminRefusal(yield* Effect.filter(adminUserIds, isActivePerson)) !== null) {
      return yield* new WorkflowRefused({ reason: "last_admin" });
    }
    yield* workflows.update({
      ...workflow,
      ...changes,
      adminUserIds,
    });
    yield* tickets.publishChange(workflow.id);
  }, transaction);

  const deleteInstance = Effect.fnUntraced(function* (actorId: string, workflowId: string) {
    const workflow = yield* requireAdmin(
      yield* actorOf(actorId),
      yield* found(workflows.get(workflowId)),
    );
    if (yield* tickets.hasTickets(workflow.id)) {
      return yield* new WorkflowRefused({ reason: "archive_instead_of_delete" });
    }
    yield* workflows.remove(workflow.id);
  }, transaction);

  const startTicket = Effect.fnUntraced(function* (caller: Caller, input: Payload<"startTicket">) {
    const actorId = yield* resolvePerson(caller, input.workflowId);
    const workflow = yield* found(workflows.get(input.workflowId));
    const definition = yield* found(definitions.get(workflow.definitionId));
    const refusal = ticketStartRefusal(yield* actorOf(actorId), workflow, definition);
    if (refusal !== null) return yield* new WorkflowRefused({ reason: refusal });
    const first = definition.steps[0]!;
    const at = yield* DateTime.now;
    const work: Work = {
      workflow,
      definition,
      ticket: {
        id: generateId(),
        workflowId: workflow.id,
        title: input.title,
        description: (input.description ?? "").trim(),
        dueDate: null,
        status: { type: "open" },
        steps: [],
        createdAt: at,
      },
    };
    yield* tickets.insert(work.ticket);
    const step = yield* enterStep(work, first, null, null, actorId);
    yield* save(work);
    return { ticketId: work.ticket.id, stepId: step.id };
  }, transaction);

  const cancelTicket = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"cancelTicket">,
  ) {
    const work = yield* loadTicket(input.ticketId);
    yield* requireInvolved(work, actorId);
    if (work.ticket.status.type !== "open") {
      return yield* new WorkflowRefused({ reason: "ticket_not_open" });
    }
    const reason = yield* requireReason(input.reason);
    for (const step of work.ticket.steps) yield* stopStepRuns(work, step);
    work.ticket = {
      ...work.ticket,
      status: { type: "cancelled", reason },
    };
    yield* save(work);
  }, transaction);

  const reopenTicket = Effect.fnUntraced(function* (actorId: string, ticketId: string) {
    const work = yield* loadTicket(ticketId);
    yield* requireInvolved(work, actorId);
    if (work.ticket.status.type !== "cancelled") {
      return yield* new WorkflowRefused({ reason: "step_not_actionable" });
    }
    work.ticket = { ...work.ticket, status: { type: "open" } };
    yield* moveOntoSteps(work, actorId);
  }, transaction);

  const setTicketDueDate = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"setTicketDueDate">,
  ) {
    const work = yield* loadTicket(input.ticketId);
    yield* requireInvolved(work, actorId);
    work.ticket = { ...work.ticket, dueDate: input.dueDate };
    yield* save(work);
  }, transaction);

  const getStep = Effect.fnUntraced(function* (actorId: string, ticketId: string, stepId: string) {
    const work = yield* loadTicket(ticketId);
    const step = stepIn(work, stepId);
    const actor = yield* actorOf(actorId);
    if (step === null || !canViewTicket(actor, work.workflow, work.ticket))
      return yield* new NotFound();
    const parents = ancestorSteps(work.ticket, step).toReversed();
    return {
      ticket: work.ticket,
      workflowName: work.workflow.name,
      otherSteps: yield* Effect.forEach(
        work.ticket.steps.filter((other) => other.parentStepId === null),
        (other) =>
          Effect.gen(function* () {
            return {
              step: other,
              name: nameOf(work, other),
              fields:
                other.id === (parents[0]?.id ?? step.id)
                  ? []
                  : yield* buildStepFieldViews(work, other),
            };
          }),
      ),
      step,
      definition: definitionOf(work, step),
      parents: parents.map((parent) => ({ id: parent.id, name: nameOf(work, parent) })),
      canOpenBoard: work.workflow.isPublic || oversees(actor, work.workflow),
      fields: yield* buildStepFieldViews(work, step),
      subSteps: childSteps(work.ticket, work.definition.steps, step).map((child) => ({
        ...child,
        name: nameOf(work, child),
      })),
      comments: yield* tickets.comments(step.id),
      files: (yield* files.forStep(step.id)).filter((file) => file.fieldKey === null).map(toFile),
      automations: yield* Effect.gen(function* () {
        const attempts = yield* stepRuns(work, step);
        const canRun =
          work.ticket.status.type === "open" &&
          isInvolved(actor, work.workflow, work.ticket) &&
          isActionable(step);
        return step.automationIds.map((id) => {
          const latest = attempts.findLast((run) => run.trigger.automationId === id);
          if (latest === undefined)
            return {
              id,
              statusLabel: "Not run",
              runLabel: canRun ? ("Run" as const) : null,
              canStop: false,
            };
          const { chatStatus } = latest;
          const statusLabel = chatStatus === "running" ? "Running" : "Ended";
          return {
            id,
            statusLabel,
            runLabel: canRun ? ("Run again" as const) : null,
            canStop: canRun && chatStatus === "running",
          };
        });
      }),
    };
  });

  const setField = Effect.fnUntraced(function* (
    work: Work,
    step: Step,
    input: Payload<"setStepField">,
  ) {
    yield* requireWorkingStep(work, step);
    const field = yield* resolveField(work, step, input.fieldKey);
    const blank =
      (typeof input.value === "string" && input.value.trim() === "") ||
      (Array.isArray(input.value) && input.value.length === 0);
    const value = blank ? null : input.value;
    const invalid = () => new WorkflowRefused({ reason: "invalid_field_value" });
    let values = step.values;
    if (field.type === "file") return yield* invalid();
    if (
      (value !== null || field.type === "group") &&
      fieldValueRefusal(field, value ?? []) !== null
    )
      return yield* invalid();
    if (field.type === "group")
      values = yield* withoutRemovedRows(step, input.fieldKey, rowIds(value));
    const others = Object.fromEntries(
      Object.entries(values).filter(([key]) => key !== input.fieldKey),
    );
    putStep(work, {
      ...step,
      values: value === null ? others : { ...others, [input.fieldKey]: value },
    });
    yield* save(work);
  });

  const markStepDone = Effect.fnUntraced(function* (actorId: string, stepId: string) {
    const { work, step } = yield* loadForCommand(actorId, stepId);
    yield* requireActionable(step);
    const refusal = stepCompletionRefusal(definitionOf(work, step), work.ticket, step);
    if (refusal !== null) return yield* new WorkflowRefused({ reason: refusal });
    yield* stopStepRuns(work, step);
    const completed = completeTicketStep(
      work.ticket,
      work.definition.steps,
      step,
      yield* DateTime.now,
    );
    work.ticket = completed.ticket;
    if (completed.next !== null)
      yield* enterStep(work, completed.next, null, step.assignee, actorId);
    yield* save(work);
  }, transaction);

  const setStepAssignee = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"setStepAssignee">,
  ) {
    const { work, step } = yield* loadForCommand(actorId, input.stepId);
    if (!isLive(step)) return yield* new WorkflowRefused({ reason: "step_not_actionable" });
    if (input.assignee !== null) yield* requireValidPerson(input.assignee);
    if (input.assignee === step.assignee) return;
    const reassigned: Step = { ...step, assignee: input.assignee };
    putStep(work, reassigned);
    yield* notify({
      kind: "to_do",
      to: input.assignee,
      workflow: work.workflow,
      step: reassigned,
      actorId,
    });
    yield* save(work);
  }, transaction);

  const blockStep = Effect.fnUntraced(function* (actorId: string, input: Payload<"blockStep">) {
    const { work, step } = yield* loadForCommand(actorId, input.stepId);
    yield* requireActionable(step);
    const reason = yield* requireReason(input.reason);
    yield* stopStepRuns(work, step);
    putStep(work, { ...step, status: { type: "blocked", at: yield* DateTime.now, reason } });
    yield* save(work);
  }, transaction);

  const unblockStep = Effect.fnUntraced(function* (actorId: string, stepId: string) {
    const { work, step } = yield* loadForCommand(actorId, stepId);
    if (step.status.type !== "blocked") {
      return yield* new WorkflowRefused({ reason: "step_not_actionable" });
    }
    putStep(work, { ...step, status: { type: "working", at: yield* DateTime.now } });
    yield* save(work);
  }, transaction);

  const comment = Effect.fnUntraced(function* (
    work: Work,
    step: Step,
    input: Payload<"commentOnStep">,
    actorId: string,
    automated: boolean,
  ) {
    if (automated) yield* requireWorkingStep(work, step);
    yield* tickets.insertComment(work.ticket.id, {
      id: generateId(),
      author: actorId,
      body: input.body,
      createdAt: yield* DateTime.now,
      stepId: step.id,
    });
  });
  const attachFile = Effect.fnUntraced(function* (
    work: Work,
    step: Step,
    input: Payload<"attachStepFile">,
    actorId: string,
    automated: boolean,
  ) {
    const fieldKey = input.fieldKey ?? null;
    if (fieldKey !== null || automated) yield* requireWorkingStep(work, step);
    if (fieldKey !== null) {
      if ((yield* resolveField(work, step, fieldKey)).type !== "file") {
        return yield* new WorkflowRefused({ reason: "invalid_field_value" });
      }
      for (const previous of yield* files.forStep(step.id)) {
        if (previous.fieldKey === fieldKey) yield* files.detach(previous.id);
      }
    }
    const claimed = yield* files.claimForStep({
      id: input.attachmentId,
      actor: actorId,
      stepId: step.id,
      fieldKey,
    });
    if (claimed === null) return yield* new NotFound();
    if (claimed.sizeBytes === 0) {
      return yield* new WorkflowRefused({ reason: "invalid_attachment" });
    }
    if (fieldKey === null) return yield* tickets.publishChange(work.ticket.id);
    putStep(work, { ...step, values: { ...step.values, [fieldKey]: claimed.id } });
    yield* save(work);
  });

  const removeStepFile = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"removeStepFile">,
  ) {
    const { work, step } = yield* loadStep(input.stepId);
    yield* requireInvolved(work, actorId);
    const file = yield* files.get(input.attachmentId);
    if (file === null || file.stepId !== step.id) return yield* new NotFound();
    if (file.fieldKey !== null) {
      yield* requireActionable(step);
      putStep(work, {
        ...step,
        values: Object.fromEntries(
          Object.entries(step.values).filter(([key]) => key !== file.fieldKey),
        ),
      });
      yield* save(work);
    }
    yield* files.detach(file.id);
    if (file.fieldKey === null) yield* tickets.publishChange(work.ticket.id);
  }, transaction);

  const listAssignments = Effect.fnUntraced(function* (actorId: string) {
    const assignments: Array<AssignmentView> = [];
    for (const ticket of yield* tickets.listOpenInvolving(actorId)) {
      const work = yield* workOf(ticket);
      for (const step of ticket.steps) {
        if (!isLive(step) || step.assignee !== actorId) continue;
        assignments.push({
          ticket: summaryOf(ticket),
          step,
          workflowName: work.workflow.name,
          stepName: nameOf(work, step),
          parentNames: ancestorSteps(work.ticket, step)
            .toReversed()
            .map((parent) => nameOf(work, parent)),
        });
      }
    }
    return assignments.toSorted(
      (left, right) =>
        millis(left.ticket.dueDate) - millis(right.ticket.dueDate) ||
        millis(left.step.status.at) - millis(right.step.status.at),
    );
  });

  const describe = Effect.fnUntraced(function* (rows: ReadonlyArray<Notification>) {
    const views: Array<NotificationView> = [];
    for (const notification of rows) {
      const workflow = yield* workflows.get(notification.workflowId);
      if (workflow === null) continue;
      const definition = yield* definitions.get(workflow.definitionId);
      const ticket =
        notification.stepId === null ? null : yield* tickets.getByStepId(notification.stepId);
      const step = ticket?.steps.find((candidate) => candidate.id === notification.stepId);
      views.push({
        ...notification,
        workflowName: workflow.name,
        ticketTitle: ticket?.title ?? null,
        stepName:
          step === undefined || definition === null
            ? null
            : (findStep(definition.steps, step.stepDefinitionId)?.step.name ?? null),
      });
    }
    return views;
  });

  const listNotifications = Effect.fnUntraced(function* (actorId: string) {
    return {
      unread: yield* notifications.unreadCount(actorId),
      notifications: yield* describe(yield* notifications.list(actorId, NOTIFICATIONS_LIMIT)),
    };
  });

  const markNotificationRead = Effect.fnUntraced(function* (
    actorId: string,
    notificationId: string,
  ) {
    if ((yield* notifications.get(notificationId, actorId)) === null) return yield* new NotFound();
    yield* notifications.markRead({ id: notificationId, userId: actorId, at: yield* DateTime.now });
  });

  const memberDeactivated = Effect.fnUntraced(function* (userId: string) {
    const all = yield* workflows.list;
    for (const workflow of all) {
      if (!workflow.adminUserIds.includes(userId)) continue;
      if (lastAdminRefusal(yield* activeAdminIds(workflow)) !== null)
        return yield* new UserRefused({ reason: "last_workflow_admin" });
    }
    for (const workflow of all) {
      if (workflow.isArchived) continue;
      if (workflow.responsible === userId) yield* tellAdmins(workflow, "needs_responsible");
      const named = Object.values(workflow.defaultAssignments).some(
        (assignment) => assignment.assignee === userId,
      );
      if (named) yield* tellAdmins(workflow, "names_deactivated");
    }
  });

  const requireStepAutomation = Effect.fnUntraced(function* (id: AutomationId) {
    const automation = yield* automations.get(id);
    const agent = automation === null ? null : yield* agents.get(automation.agentId);
    if (automation === null || agent === null || !canWorkSteps(agent))
      return yield* new WorkflowRefused({ reason: "invalid_automations" });
    return automation;
  });
  const validateAutomations = (ids: ReadonlyArray<AutomationId>) =>
    Effect.forEach(ids, requireStepAutomation, { discard: true });
  const loadAutomation = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"runStepAutomation">,
  ) {
    const loaded = yield* loadForCommand(actorId, input.stepId);
    yield* requireActionable(loaded.step);
    if (!loaded.step.automationIds.includes(input.automationId)) return yield* new NotFound();
    return loaded;
  });
  const runStepAutomation = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"runStepAutomation">,
  ) {
    const { work, step } = yield* loadAutomation(actorId, input);
    const automation = yield* requireStepAutomation(input.automationId);
    yield* stopStepRuns(work, step, (id) => id === automation.id);
    yield* chats.startAutomation(
      { type: "step", ticketId: work.ticket.id, stepId: step.id, automationId: automation.id },
      automation.agentId,
      {
        title: `${work.ticket.title} · ${nameOf(work, step)}`.slice(0, 200).trim(),
        input: yield* buildAutomationInput(work, step, automation),
      },
    );
  }, transaction);
  const stopStepAutomation = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"stopStepAutomation">,
  ) {
    const { work, step } = yield* loadAutomation(actorId, input);
    for (const chatId of yield* stopStepRuns(work, step, (id) => id === input.automationId))
      yield* automationEnded(chatId, actorId);
  }, transaction);
  const setStepAutomations = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"setStepAutomations">,
  ) {
    const { work, step } = yield* loadForCommand(actorId, input.stepId);
    yield* requireActionable(step);
    yield* validateAutomations(input.automationIds);
    yield* stopStepRuns(work, step, (id) => !input.automationIds.includes(id));
    putStep(work, { ...step, automationIds: input.automationIds });
    yield* save(work);
  }, transaction);
  const memberCommand = <I extends { readonly stepId: string }, A, E>(
    mutate: (
      work: Work,
      step: Step,
      input: I,
      actorId: string,
      automated: boolean,
    ) => Effect.Effect<A, E>,
  ) =>
    Effect.fnUntraced(function* (caller: Caller, input: I) {
      const { work, step } = yield* loadStep(input.stepId);
      let actorId: string;
      const automated = typeof caller !== "string" && caller.origin.kind === "automation";
      if (automated) {
        const assigned = yield* loadAutomationStep(caller.origin);
        if (assigned.step.id !== step.id) return yield* new NotFound();
        actorId = caller.agentId;
      } else {
        actorId = yield* resolvePerson(caller, work.workflow.id);
        yield* requireInvolved(work, actorId);
      }
      return yield* mutate(work, step, input, actorId, automated);
    }, transaction);

  const getWorkflow = Effect.fnUntraced(function* (caller: Caller, workflowId: string) {
    const { workflow, definition } = yield* loadWorkflow(caller, workflowId);
    return { workflowId: workflow.id, name: workflow.name, blueprint: definition };
  });
  const listTickets = Effect.fnUntraced(function* (caller: Caller, input: Payload<"listTickets">) {
    const { actor, workflow } = yield* loadWorkflow(caller, input.workflowId);
    return yield* tickets.listForWorkflow(workflow, actor, input.query ?? "");
  });
  const getTicket = Effect.fnUntraced(function* (caller: Caller, input: Payload<"getTicket">) {
    const ticket = yield* found(tickets.get(input.ticketId));
    const actorId = yield* resolvePerson(caller, ticket.workflowId);
    const workflow = yield* found(workflows.get(ticket.workflowId));
    if (!canViewTicket(yield* actorOf(actorId), workflow, ticket)) return yield* new NotFound();
    return ticket;
  });
  yield* chats.onEnd((chatId) => automationEnded(chatId, null));

  return {
    getWorkflow,
    listTickets,
    getTicket,
    memberDeactivated,
    setStepAutomations,
    runStepAutomation,
    stopStepAutomation,
    listDefinitions: definitions.list,
    getDefinition: (actorId: string, definitionId: string) =>
      Effect.gen(function* () {
        const definition = yield* found(definitions.get(definitionId));
        const actor = yield* actorOf(actorId);
        const instances = yield* workflows.listForDefinition(definitionId);
        return { definition, canManage: canUpdateDefinition(actor, instances) };
      }),
    listInstances,
    listStartableInstances,
    getInstance,
    getInstanceBoard,
    createDefinition,
    createInstance,
    updateDefinition,
    updateInstance,
    deleteInstance,
    startTicket,
    cancelTicket,
    reopenTicket,
    setTicketDueDate,
    watchStep: (actorId: string, stepId: string) =>
      Stream.unwrap(
        Effect.map(found(tickets.getByStepId(stepId)), (ticket) =>
          tickets.watch(ticket, getStep(actorId, ticket.id, stepId)),
        ),
      ).pipe(Stream.changesWith(sameStepView)),
    setStepField: memberCommand(setField),
    markStepDone,
    setStepAssignee,
    blockStep,
    unblockStep,
    commentOnStep: memberCommand(comment),
    attachStepFile: memberCommand(attachFile),
    removeStepFile,
    listAssignments,
    listNotifications,
    markNotificationRead,
  };
});

export class WorkflowService extends Context.Service<
  WorkflowService,
  Effect.Success<typeof make>
>()("t45/workflows/WorkflowService") {}

export const layer = Layer.effect(WorkflowService, make);
