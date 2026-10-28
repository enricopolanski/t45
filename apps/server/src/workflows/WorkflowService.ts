import type { Workflows } from "@t45/contracts/resources/Workflows";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type { SessionMessage } from "@opencode/client/effect";
import type { Task } from "@t45/contracts/models/Task";
import { TaskService, type StepHooks } from "../tasks/TaskService.ts";
import { canWorkSteps } from "@t45/contracts/models/Agent";
import { type Attachment, AttachmentId } from "@t45/contracts/models/Attachment";
import {
  type Notification,
  NotificationId,
  type NotificationKind,
} from "@t45/contracts/models/Notification";
import { generateId } from "@t45/contracts/models/primitives";
import { Refused as UserRefused } from "@t45/contracts/models/User";
import {
  type StepAutomation,
  stepReadyForApproval,
  stepAutomationRefusal,
  resolveResponsible,
  resolveAssignee,
  stepPeopleOnEntry,
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
  needsWorkAfterDefinitionChange,
  fieldValueRefusal,
  type WorkflowActor,
  findStep,
  rowIds,
  groupRows,
  resolveFieldPath,
  carriedFields,
  isActionable,
  isLive,
  isAdmin,
  oversees,
  isInvolved,
  canViewTicket,
  stepApprovalRefusal,
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
import { STEP_TOOL_NAMES, StepToolCall } from "@t45/contracts/resources/AgentTools";
import type { AssignmentSection, AssignmentView } from "@t45/contracts/resources/Assignments";
import { NotFound } from "@t45/contracts/resources/errors";
import type { NotificationView } from "@t45/contracts/resources/Notifications";
import type { FieldView, TicketSummaryView } from "@t45/contracts/resources/Workflows";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { AgentRepository } from "../agents/AgentRepository.ts";
import { AttachmentRepository } from "../attachments/AttachmentRepository.ts";
import { textOf } from "../opencode/OpenCode2Client.ts";
import { UserRepository } from "../org/UserRepository.ts";
import { NotificationRepository } from "./NotificationRepository.ts";
import { TicketRepository } from "./TicketRepository.ts";
import { WorkflowDefinitionRepository } from "./WorkflowDefinitionRepository.ts";
import { WorkflowRepository } from "./WorkflowRepository.ts";

type WorkflowRpc = RpcGroup.Rpcs<typeof Workflows>;
type Payload<Tag extends string> = Rpc.Payload<Rpc.ExtractTag<WorkflowRpc, `workflows.${Tag}`>>;

const toFile = ({ id, name }: Attachment) => ({ id, name });

const summaryOf = (ticket: Ticket): TicketSummaryView => ({
  ...ticket,
  currentStep: currentStep(ticket),
});

const millis = (at: DateTime.Utc | null) => (at === null ? Infinity : DateTime.toEpochMillis(at));

const SECTIONS: ReadonlyArray<AssignmentSection> = ["to_approve", "to_do", "waiting"];

const NOTIFICATIONS_LIMIT = 50;

const STEP_FILE_TYPE = "application/octet-stream";

const stepFileForChat = (file: Attachment) => ({
  type: "file" as const,
  id: file.id,
  name: file.name,
  mimeType: STEP_FILE_TYPE,
  sizeBytes: file.sizeBytes,
});

const INPUT_REFUSED = "its input doesn't fit the tool";

const ATTACH_UNREAD = "T45 couldn't read the file; attach it again";

const decodeReply = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      ok: Schema.Literal(true),
      name: Schema.optionalKey(Schema.String),
      file: Schema.optionalKey(Schema.String),
    }),
  ),
);
const decodeCall = Schema.decodeUnknownOption(StepToolCall);

const callOf = (part: SessionMessage.AssistantTool) => {
  const tool = STEP_TOOL_NAMES.find((name) => name === part.name);
  if (tool === undefined || part.state.status !== "completed") return null;
  const reply = Option.getOrNull(decodeReply(textOf(part.state.content)));
  if (reply === null) return null;
  return {
    tool,
    call: Option.getOrNull(decodeCall({ tool, input: part.state.input })),
    attached:
      reply.name !== undefined && reply.file !== undefined
        ? { name: reply.name, file: reply.file }
        : null,
  };
};

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
  const files = yield* AttachmentRepository;
  const fieldTrees = (
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
                  fieldTrees(field.fields, rowId === null ? path : `${path}.${rowId}`, values),
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

  const tasks = yield* TaskService;
  const { transaction } = tickets;

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

  const stepResponsible = Effect.fnUntraced(function* (workflow: Workflow, userId: string | null) {
    const candidates = new Set([
      ...workflow.adminUserIds,
      workflow.responsible,
      userId ?? workflow.responsible,
    ]);
    const active = new Set(yield* Effect.filter(candidates, isActivePerson));
    const resolved = resolveResponsible(workflow, userId, active);
    for (const notice of resolved.notices) yield* tellAdmins(workflow, notice);
    if (resolved.responsible === null)
      return yield* Effect.die("a workflow always keeps an active admin");
    return resolved.responsible;
  });

  const liveAssignee = Effect.fnUntraced(function* (
    workflow: Workflow,
    id: string | null,
    fallback: string,
  ) {
    const resolved = resolveAssignee(id, fallback, id === null || (yield* isActivePerson(id)));
    if (resolved.namesDeactivated) yield* tellAdmins(workflow, "names_deactivated");
    return resolved.assignee;
  });

  const revive = Effect.fnUntraced(function* (
    workflow: Workflow,
    step: Step,
    keepAssignee = false,
  ) {
    const responsible = yield* stepResponsible(workflow, step.responsible);
    const assignee = keepAssignee
      ? step.assignee
      : yield* liveAssignee(workflow, step.assignee, responsible);
    return responsible === step.responsible && assignee === step.assignee
      ? step
      : { ...step, responsible, assignee };
  });

  const definitionOf = (work: Work, step: Step) =>
    findStep(work.definition.steps, step.stepDefinitionId)?.step ?? null;

  const nameOf = (work: Work, step: Step) => definitionOf(work, step)?.name ?? work.workflow.name;

  const stepIn = (work: Work, stepId: string | null) => stepInTicket(work.ticket, stepId);
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

  const loadTaskStep = Effect.fnUntraced(function* (task: Task) {
    if (task.trigger.type !== "step") return yield* new NotFound();
    const work = yield* loadTicket(task.trigger.ticketId);
    const step = stepIn(work, task.trigger.stepId);
    const entry = step?.automations.find((entry) => entry.id === task.trigger.automationId);
    if (step === null || entry === undefined) return yield* new NotFound();
    return { work, step, entry };
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

  const stepTasks = (work: Work, step: Step) =>
    tasks.listByTrigger({ ticketId: work.ticket.id, stepId: step.id });
  const cancelTask = (task: Task) =>
    tasks.settle(task.chatId, { type: "cancelled", reason: "Work was cancelled." });
  const takeFromAgent = Effect.fnUntraced(function* (
    work: Work,
    step: Step,
    disposition: "stop" | "cancel" = "cancel",
  ) {
    for (const task of yield* stepTasks(work, step)) {
      if (task.state.type === "settled" || (disposition === "stop" && task.state.type !== "active"))
        continue;
      yield* disposition === "stop" ? tasks.requestStop(task.chatId) : cancelTask(task);
    }
  });

  const brief = Effect.fnUntraced(function* (work: Work, step: Step) {
    const definition = definitionOf(work, step);
    const containing = ancestorSteps(work.ticket, step);
    const root = containing.at(-1) ?? step;
    const inputs = [];
    for (const { source, definition: from, field } of carriedFields(
      work.definition.steps,
      root.stepDefinitionId,
      work.ticket.steps,
    )) {
      const [view] = yield* fieldTrees([field], "", source.values);
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
      fields: yield* fieldsOf(work, step),
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

  type AgentBrief = Effect.Success<ReturnType<typeof brief>>;

  const briefJson = (brief: AgentBrief) =>
    ["```json", JSON.stringify(brief, null, 2), "```"].join("\n");

  const target = (brief: AgentBrief) =>
    brief.parents.length === 0
      ? `the step "${brief.stepName}"`
      : `the sub-step "${brief.stepName}" of ${brief.parents.map((parent) => `"${parent.name}"`).join(" › ")}`;

  const paragraphs = (...parts: ReadonlyArray<string>) => parts.filter(Boolean).join("\n\n");

  const assignedPrompt = (brief: AgentBrief) =>
    paragraphs(
      `You contribute to ${target(brief)} of "${brief.ticketTitle}" in the workflow "${brief.workflowName}". The step is below as JSON: its instructions, the fields of earlier steps it reads, its own fields, its comments and its files. That is all you can see of this ticket.`,
      "Fill the step's fields with step_set_field, report progress or results with step_comment, and attach files with step_attach. When your contribution is finished, call step_done even if the step still has missing fields or unfinished sub-steps. Explain any gaps in a comment first. If you cannot do your contribution, fill what you can, then call step_give_up with a note on what is missing and why. Either call ends your run and releases your sandbox. Do not invent field keys or missing data; invalid writes fail the run and notify the responsible person.",
      "You work in a folder of your own. Follow AGENTS.md if it is there.",
      brief.instructions.trim() ? `Instructions for this step:\n${brief.instructions.trim()}` : "",
      briefJson(brief),
    );

  const handBackPrompt = (brief: AgentBrief) =>
    paragraphs(
      `The step "${brief.stepName}" is back with you; its latest comments say why. Here it is as it stands now. Finish it and call step_done, or fill what you can and call step_give_up with a note on what is missing.`,
      briefJson(brief),
    );

  const fieldFiles = (fields: ReadonlyArray<FieldView>): ReadonlyArray<string> =>
    fields.flatMap((field) =>
      field.file === null ? field.rows.flatMap((row) => fieldFiles(row.fields)) : [field.file.id],
    );

  const taskInput = Effect.fnUntraced(function* (
    work: Work,
    step: Step,
    entry: StepAutomation,
    again = false,
  ) {
    const full = yield* brief(work, step);
    return {
      text: paragraphs(
        again ? handBackPrompt(full) : assignedPrompt(full),
        `Your automation: ${entry.instructions}. Other automations may work on this step at the same time. step_done signals that your contribution is finished. T45 checks the shared step's fields and sub-steps separately before making it ready for approval.`,
      ),
      attachments: (yield* files.forIds([
        ...new Set([
          ...fieldFiles(full.inputs),
          ...fieldFiles(full.fields),
          ...full.attachments.map((file) => file.id),
        ]),
      ])).map(stepFileForChat),
    };
  });
  const taskFailed = Effect.fnUntraced(function* (
    work: Work,
    step: Step,
    agentId: string,
    reason: string,
  ) {
    yield* tickets.insertComment(work.ticket.id, {
      id: generateId(),
      author: agentId,
      body: reason,
      createdAt: yield* DateTime.now,
      stepId: step.id,
    });
    yield* notify({
      kind: "agent_failed",
      to: step.responsible,
      workflow: work.workflow,
      step,
      actorId: null,
    });
  });
  const startEntry = (work: Work, step: Step, entry: StepAutomation) =>
    Effect.gen(function* () {
      const agent = yield* agents.get(entry.agentId);
      if (agent === null || !canWorkSteps(agent))
        return yield* taskFailed(
          work,
          step,
          entry.agentId,
          "The automation could not start because its agent is unavailable or no longer has step tools.",
        );
      yield* tasks
        .start(
          { type: "step", ticketId: work.ticket.id, stepId: step.id, automationId: entry.id },
          entry.agentId,
          {
            title: `${work.ticket.title} · ${nameOf(work, step)}`.slice(0, 200).trim(),
            input: yield* taskInput(work, step, entry),
          },
        )
        .pipe(Effect.catch((error) => taskFailed(work, step, entry.agentId, error.message)));
    });
  const continueEntry = (work: Work, step: Step, entry: StepAutomation, task: Task) =>
    Effect.gen(function* () {
      yield* tasks
        .continue(task.chatId, yield* taskInput(work, step, entry, true))
        .pipe(
          Effect.catch((error) =>
            tasks.settle(task.chatId, { type: "failed", reason: error.message }),
          ),
        );
    });
  const startWork = Effect.fnUntraced(function* (
    work: Work,
    step: Step,
    actorId: string | null,
    restarting = false,
  ) {
    const existing = yield* stepTasks(work, step);
    for (const entry of step.automations) {
      const current = existing.find(
        (task) => task.trigger.automationId === entry.id && task.state.type !== "settled",
      );
      if (current === undefined) {
        if (
          restarting ||
          !existing.some(
            (task) =>
              task.trigger.automationId === entry.id &&
              (task.state.type !== "settled" || task.state.outcome.type !== "cancelled"),
          )
        )
          yield* startEntry(work, step, entry);
      } else if (current.state.type === "active" || restarting)
        yield* continueEntry(work, step, entry, current);
    }
    yield* notify({ kind: "to_do", to: step.assignee, workflow: work.workflow, step, actorId });
  });

  const enterStep = Effect.fnUntraced(function* (
    work: Work,
    definition: StepDefinition,
    parent: Step | null,
    inherited: string | null,
    actorId: string | null,
  ): Effect.fn.Return<Step> {
    const requested = stepPeopleOnEntry(work.workflow, definition, inherited);
    const responsible = yield* stepResponsible(work.workflow, requested.responsible);
    const assignee = yield* liveAssignee(work.workflow, requested.assignee, responsible);
    const step = Step.make({
      stepDefinitionId: definition.id,
      status: { type: "working", at: yield* DateTime.now },
      parentStepId: parent?.id ?? null,
      assignee,
      responsible,
      automations: work.workflow.defaultAssignments[definition.id]?.automations ?? [],
      values: {},
    });
    putStep(work, step);
    yield* startWork(work, step, actorId);
    for (const child of definition.subSteps) {
      yield* enterStep(work, child, step, assignee, actorId);
    }
    return step;
  });

  const complete = Effect.fnUntraced(function* (work: Work, step: Step, actorId: string) {
    for (const task of yield* stepTasks(work, step)) {
      if (task.state.type === "submitted") yield* tasks.settle(task.chatId, { type: "succeeded" });
      else if (task.state.type !== "settled") yield* cancelTask(task);
    }
    const completed = completeTicketStep(
      work.ticket,
      work.definition.steps,
      step,
      yield* DateTime.now,
    );
    work.ticket = completed.ticket;
    if (completed.next === null) return;
    yield* enterStep(work, completed.next, null, step.assignee, actorId);
  });

  const requireComplete = (work: Work, step: Step) => {
    const refusal = stepCompletionRefusal(definitionOf(work, step), work.ticket, step);
    return refusal === null ? Effect.void : Effect.fail(new WorkflowRefused({ reason: refusal }));
  };

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
    const reworked: Array<Step> = [];
    for (const step of work.ticket.steps) {
      if (needsWorkAfterDefinitionChange(work.ticket, step, definitionOf(work, step))) {
        const revived = yield* revive(work.workflow, step);
        const working: Step = { ...revived, status: { type: "working", at: yield* DateTime.now } };
        putStep(work, working);
        reworked.push(working);
      }
    }
    yield* save(work);
    for (const step of reworked) yield* startWork(work, step, actorId, true);
  });

  const fieldsOf = (work: Work, step: Step) =>
    fieldTrees(definitionOf(work, step)?.fields ?? [], "", step.values);

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
    if (changes.steps !== undefined) {
      for (const workflow of running) {
        for (const ticket of yield* tickets.listOpen(workflow.id)) {
          yield* moveOntoSteps({ workflow, definition: next, ticket }, actorId);
        }
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
      yield* validateEntries(assignment.automations);
      if (assignment.assignee !== null) yield* requireValidPerson(assignment.assignee);
      if (assignment.responsible !== null) yield* requireValidPerson(assignment.responsible);
    }
    const listed = changes.adminUserIds ?? workflow.adminUserIds;
    const adminUserIds = [
      ...new Set([...workflow.adminUserIds.filter((id) => listed.includes(id)), ...listed]),
    ];
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

  const startTicket = Effect.fnUntraced(function* (actorId: string, input: Payload<"startTicket">) {
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
    return { stepId: step.id };
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
    for (const step of work.ticket.steps) yield* takeFromAgent(work, step);
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
    for (const step of work.ticket.steps) {
      const live = isLive(step);
      if (!live && step.status.type !== "waiting_approval") continue;
      const revived = yield* revive(work.workflow, step, !live);
      if (revived !== step) putStep(work, revived);
    }
    const restarting = new Set(work.ticket.steps.filter(isActionable).map((step) => step.id));
    yield* moveOntoSteps(work, actorId);
    for (const step of work.ticket.steps) {
      if (restarting.has(step.id)) yield* startWork(work, step, actorId, true);
    }
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

  const getStep = Effect.fnUntraced(function* (actorId: string, stepId: string) {
    const { work, step } = yield* loadStep(stepId);
    const actor = yield* actorOf(actorId);
    if (!canViewTicket(actor, work.workflow, work.ticket)) return yield* new NotFound();
    yield* notifications.markReadForStep({ userId: actorId, stepId, at: yield* DateTime.now });
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
              fields: other.id === (parents[0]?.id ?? step.id) ? [] : yield* fieldsOf(work, other),
            };
          }),
      ),
      step,
      definition: definitionOf(work, step),
      parents: parents.map((parent) => ({ id: parent.id, name: nameOf(work, parent) })),
      canOpenBoard: work.workflow.isPublic || oversees(actor, work.workflow),
      canRunAutomations:
        isInvolved(actor, work.workflow, work.ticket) &&
        stepAutomationRefusal(work.ticket, step) === null,
      fields: yield* fieldsOf(work, step),
      subSteps: childSteps(work.ticket, work.definition.steps, step).map((child) => ({
        ...child,
        name: nameOf(work, child),
      })),
      comments: yield* tickets.comments(step.id),
      files: (yield* files.forStep(step.id)).filter((file) => file.fieldKey === null).map(toFile),
      tasks: yield* tasks.runsByTrigger({ ticketId: work.ticket.id, stepId: step.id }),
    };
  });

  const setField = Effect.fnUntraced(function* (
    work: Work,
    step: Step,
    _actorId: string,
    input: Payload<"setStepField">,
  ) {
    if (work.ticket.status.type !== "open")
      return yield* new WorkflowRefused({ reason: "ticket_not_open" });
    yield* requireActionable(step);
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
    yield* requireComplete(work, step);
    for (const task of yield* stepTasks(work, step)) {
      if (task.state.type === "active") yield* cancelTask(task);
    }
    const approver = step.responsible;
    if (approver === actorId) {
      yield* complete(work, step, actorId);
    } else {
      putStep(work, { ...step, status: { type: "waiting_approval", at: yield* DateTime.now } });
      yield* notify({
        kind: "to_approve",
        to: approver,
        workflow: work.workflow,
        step,
        actorId,
      });
    }
    yield* save(work);
  }, transaction);

  const loadForApproval = Effect.fnUntraced(function* (actorId: string, stepId: string) {
    const loaded = yield* loadStep(stepId);
    const refusal = stepApprovalRefusal(actorId, loaded.work.ticket, loaded.step);
    if (refusal !== null) return yield* new WorkflowRefused({ reason: refusal });
    return loaded;
  });

  const approveStep = Effect.fnUntraced(function* (actorId: string, stepId: string) {
    const { work, step } = yield* loadForApproval(actorId, stepId);
    yield* requireComplete(work, step);
    yield* complete(work, step, actorId);
    yield* save(work);
  }, transaction);

  const rejectStep = Effect.fnUntraced(function* (actorId: string, input: Payload<"rejectStep">) {
    const { work, step } = yield* loadForApproval(actorId, input.stepId);
    const reason = yield* requireReason(input.reason);
    const at = yield* DateTime.now;
    const revived = yield* revive(work.workflow, step);
    const rejected: Step = { ...revived, status: { type: "rejected", at, reason } };
    putStep(work, rejected);
    yield* tickets.insertComment(work.ticket.id, {
      id: generateId(),
      author: actorId,
      body: reason,
      createdAt: at,
      stepId: step.id,
    });
    yield* notify({
      kind: "rejected",
      to: rejected.assignee,
      workflow: work.workflow,
      step: rejected,
      actorId,
    });
    yield* save(work);
    for (const task of yield* stepTasks(work, rejected)) {
      if (task.state.type !== "submitted") continue;
      const entry = rejected.automations.find((entry) => entry.id === task.trigger.automationId);
      if (entry !== undefined) yield* continueEntry(work, rejected, entry, task);
    }
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
    yield* takeFromAgent(work, step, "stop");
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
    yield* startWork(work, stepIn(work, step.id)!, actorId);
  }, transaction);

  const comment = (work: Work, step: Step, actorId: string, input: Payload<"commentOnStep">) =>
    DateTime.now.pipe(
      Effect.flatMap((createdAt) =>
        tickets.insertComment(work.ticket.id, {
          id: generateId(),
          author: actorId,
          body: input.body,
          createdAt,
          stepId: step.id,
        }),
      ),
    );
  const attachFile = Effect.fnUntraced(function* (
    work: Work,
    step: Step,
    actorId: string,
    input: Payload<"attachStepFile">,
  ) {
    const fieldKey = input.fieldKey ?? null;
    if (fieldKey !== null) {
      if (work.ticket.status.type !== "open") {
        return yield* new WorkflowRefused({ reason: "ticket_not_open" });
      }
      yield* requireActionable(step);
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
    if (fieldKey === null) return yield* tickets.changed(work.ticket.id);
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
    yield* tickets.changed(work.ticket.id);
  }, transaction);

  const listAssignments = Effect.fnUntraced(function* (actorId: string) {
    const rows: Array<{
      readonly section: AssignmentSection;
      readonly assignment: AssignmentView;
    }> = [];
    for (const ticket of yield* tickets.listOpenInvolving(actorId)) {
      const work = yield* workOf(ticket);
      for (const step of ticket.steps) {
        const approves = step.responsible === actorId;
        const section =
          step.status.type === "waiting_approval"
            ? approves
              ? "to_approve"
              : null
            : !isLive(step)
              ? null
              : step.assignee === actorId
                ? "to_do"
                : approves
                  ? "waiting"
                  : null;
        if (section === null) continue;
        rows.push({
          section,
          assignment: {
            ticket: summaryOf(ticket),
            step,
            workflowName: work.workflow.name,
            stepName: nameOf(work, step),
            parentNames: ancestorSteps(work.ticket, step)
              .toReversed()
              .map((parent) => nameOf(work, parent)),
          },
        });
      }
    }
    const sorted = rows.toSorted(
      (left, right) =>
        millis(left.assignment.ticket.dueDate) - millis(right.assignment.ticket.dueDate) ||
        millis(left.assignment.step.status.at) - millis(right.assignment.step.status.at),
    );
    return {
      sections: SECTIONS.flatMap((section) => {
        const assignments = sorted
          .filter((row) => row.section === section)
          .map((row) => row.assignment);
        return assignments.length === 0 ? [] : [{ section, assignments }];
      }),
    };
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
    for (const ticket of yield* tickets.listOpenInvolving(userId)) {
      const work = yield* workOf(ticket).pipe(Effect.orDie);
      for (const step of ticket.steps) {
        const waiting = step.status.type === "waiting_approval";
        if (!waiting && !isLive(step)) continue;
        const revived = yield* revive(work.workflow, step, waiting);
        if (revived === step) continue;
        putStep(work, revived);
        if (waiting) {
          yield* notify({
            kind: "to_approve",
            to: revived.responsible,
            workflow: work.workflow,
            step: revived,
            actorId: null,
          });
        } else if (revived.assignee !== step.assignee) {
          yield* notify({
            kind: "to_do",
            to: revived.assignee,
            workflow: work.workflow,
            step: revived,
            actorId: null,
          });
        }
      }
      yield* save(work);
    }
    for (const workflow of all) {
      if (workflow.isArchived) continue;
      if (workflow.responsible === userId) yield* tellAdmins(workflow, "needs_responsible");
      const named = Object.values(workflow.defaultAssignments).some(
        (assignment) => assignment.assignee === userId || assignment.responsible === userId,
      );
      if (named) yield* tellAdmins(workflow, "names_deactivated");
    }
  });

  const validateEntries = Effect.fnUntraced(function* (entries: ReadonlyArray<StepAutomation>) {
    for (const entry of entries) {
      const agent = yield* agents.get(entry.agentId);
      if (agent === null || !canWorkSteps(agent))
        return yield* new WorkflowRefused({ reason: "invalid_automations" });
    }
  });
  const runStepAutomation = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"runStepAutomation">,
  ) {
    const { work, step } = yield* loadForCommand(actorId, input.stepId);
    const refusal = stepAutomationRefusal(work.ticket, step);
    if (refusal !== null) return yield* new WorkflowRefused({ reason: refusal });
    const entry = step.automations.find((entry) => entry.id === input.automationId);
    if (entry === undefined) return yield* new NotFound();
    yield* validateEntries([entry]);
    for (const task of yield* stepTasks(work, step)) {
      if (task.trigger.automationId === entry.id && task.state.type !== "settled")
        yield* cancelTask(task);
    }
    const updated = { ...step, status: { type: "working" as const, at: yield* DateTime.now } };
    putStep(work, updated);
    yield* save(work);
    yield* startEntry(work, updated, entry);
  }, transaction);
  const stopStepAutomation = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"stopStepAutomation">,
  ) {
    const { work, step } = yield* loadForCommand(actorId, input.stepId);
    if (!step.automations.some((entry) => entry.id === input.automationId))
      return yield* new NotFound();
    for (const task of yield* stepTasks(work, step)) {
      if (task.trigger.automationId === input.automationId && task.state.type === "active")
        yield* tasks.settle(task.chatId, {
          type: "cancelled",
          reason: "Stopped by a person on the step.",
        });
    }
    yield* tickets.changed(work.ticket.id);
  }, transaction);
  const setStepAutomations = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"setStepAutomations">,
  ) {
    const { work, step } = yield* loadForCommand(actorId, input.stepId);
    yield* requireActionable(step);
    yield* validateEntries(input.automations);
    const current = yield* stepTasks(work, step);
    const same = (entry: StepAutomation, other: StepAutomation) =>
      entry.id === other.id &&
      entry.agentId === other.agentId &&
      entry.instructions === other.instructions;
    for (const task of current) {
      const before = step.automations.find((entry) => entry.id === task.trigger.automationId);
      if (
        task.state.type === "settled" ||
        (before !== undefined && input.automations.some((entry) => same(entry, before)))
      )
        continue;
      yield* cancelTask(task);
    }
    const updated = { ...step, automations: input.automations };
    putStep(work, updated);
    yield* refreshReadiness(work, updated);
    yield* save(work);
  }, transaction);
  const refreshReadiness = Effect.fnUntraced(function* (work: Work, step: Step) {
    if (
      !stepReadyForApproval(
        definitionOf(work, step),
        work.ticket,
        step,
        yield* stepTasks(work, step),
      )
    )
      return;
    putStep(work, { ...step, status: { type: "waiting_approval", at: yield* DateTime.now } });
    yield* notify({
      kind: "to_approve",
      to: step.responsible,
      workflow: work.workflow,
      step,
      actorId: null,
    });
  });
  const taskHooks: StepHooks = {
    canRun: (task) =>
      loadTaskStep(task).pipe(
        Effect.map(({ work, step }) => work.ticket.status.type === "open" && isActionable(step)),
        Effect.orElseSucceed(() => false),
      ),
    prepare: (task, part, read) =>
      Effect.gen(function* () {
        const parsed = callOf(part);
        if (parsed === null) return null;
        let attachmentId: AttachmentId | null = null;
        const file = parsed.attached;
        if (file !== null && /^\.t45\/attached\/[0-9a-f-]{36}$/u.test(file.file)) {
          const loaded = yield* loadTaskStep(task).pipe(Effect.option);
          if (Option.isNone(loaded)) return null;
          const bytes = yield* read(file.file);
          if (bytes !== null) {
            const stored = yield* files
              .store({
                name: file.name,
                mimeType: STEP_FILE_TYPE,
                bytes,
                uploader: loaded.value.entry.agentId,
              })
              .pipe(Effect.catchTags({ AttachmentNameError: () => Effect.succeed(null) }));
            attachmentId = stored?.id ?? null;
          }
        }
        return {
          apply: Effect.gen(function* () {
            const loaded = yield* loadTaskStep(task).pipe(Effect.option);
            if (Option.isNone(loaded)) return null;
            const { work, step, entry } = loaded.value;
            if (work.ticket.status.type !== "open" || !isActionable(step)) return null;
            const call = parsed.call;
            if (call?.tool === "step_give_up")
              return {
                type: "settled",
                outcome: { type: "failed", reason: call.input.note },
              } as const;
            const execute = Effect.gen(function* () {
              if (call === null) return INPUT_REFUSED;
              if (call.tool === "step_done") return null;
              if (call.tool === "step_set_field")
                yield* setField(work, step, entry.agentId, { stepId: step.id, ...call.input });
              else if (call.tool === "step_comment")
                yield* comment(work, step, entry.agentId, { stepId: step.id, ...call.input });
              else {
                if (attachmentId === null) return ATTACH_UNREAD;
                yield* attachFile(work, step, entry.agentId, {
                  stepId: step.id,
                  attachmentId,
                  ...call.input,
                });
              }
              return null;
            });
            const refusal = yield* execute.pipe(
              transaction,
              Effect.catchTags({
                WorkflowRefused: (error) => Effect.succeed(error.message),
                NotFound: () => Effect.succeed(ATTACH_UNREAD),
              }),
            );
            if (refusal !== null)
              return {
                type: "settled",
                outcome: { type: "failed", reason: `${parsed.tool}: ${refusal}` },
              } as const;
            return call?.tool === "step_done" ? ({ type: "submitted" } as const) : null;
          }),
        };
      }),
    changed: (task) =>
      Effect.gen(function* () {
        const loaded = yield* loadTaskStep(task).pipe(Effect.option);
        if (Option.isNone(loaded)) return;
        const { work, step, entry } = loaded.value;
        if (task.state.type === "settled" && task.state.outcome.type === "failed")
          yield* taskFailed(work, step, entry.agentId, task.state.outcome.reason);
        if (task.state.type === "submitted") {
          yield* refreshReadiness(work, step);
          yield* save(work);
        }
      }),
  };

  const memberCommand = <I extends { readonly stepId: string }, A, E>(
    mutate: (work: Work, step: Step, actorId: string, input: I) => Effect.Effect<A, E>,
  ) =>
    Effect.fnUntraced(function* (actorId: string, input: I) {
      const { work, step } = yield* loadStep(input.stepId);
      yield* requireInvolved(work, actorId);
      return yield* mutate(work, step, actorId, input);
    }, transaction);

  return {
    memberDeactivated,
    taskHooks,
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
    getStep,
    watchStep: (actorId: string, stepId: string) =>
      Stream.unwrap(
        Effect.map(loadStep(stepId), ({ work }) =>
          tickets.watch(
            work.ticket.id,
            getStep(actorId, stepId),
            tasks.changesForTicket(work.ticket.id),
          ),
        ),
      ),
    setStepField: memberCommand(setField),
    markStepDone,
    approveStep,
    rejectStep,
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
