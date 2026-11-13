import type { Automation, AutomationId } from "@t45/contracts/models/Automation";
import { AutomationRepository } from "../automations/AutomationRepository.ts";
import type { CurrentActor } from "@t45/contracts/Authorization";
import { ChatService } from "../chats/ChatService.ts";
import * as ProjectAssistant from "./ProjectAssistant.ts";
import type { Workflows } from "@t45/contracts/resources/Workflows";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import { ChatRepository } from "../chats/ChatRepository.ts";
import { ChatEvents } from "../chats/ChatEvents.ts";
import type { ChatId } from "@t45/contracts/models/Chat";
import { type AutomationOrigin, effectiveUserIdOf } from "@t45/contracts/models/ChatOrigin";
import { canUse } from "@t45/contracts/models/Agent";
import { canWorkSteps } from "@t45/contracts/models/Workflow";
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
  applyWorkflowEdits,
  canAttachAgent,
  canEditWorkflow,
  canSetWorkflowEditors,
  stepIds,
  fieldValueProblem,
  type WorkflowActor,
  findStep,
  rowIds,
  groupRows,
  resolveFieldPath,
  isActionable,
  isLive,
  canManageProject,
  isProjectAdmin,
  ticketAccess,
  canSeeStep,
  topLevelStep,
  stepsAssignedUnder,
  stepInputFields,
  stepEntryRefusal,
  hasValidInputs,
  isSameInput,
  occupiedStep,
  stepCompletionRefusal,
  lastAdminRefusal,
  Step,
  StepDefinition,
  type StepField,
  type Ticket,
  type Project,
  type Workflow,
  type TicketAccess,
  type WorkflowEdit,
  type WorkflowVersion,
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
import { CapabilityRepository } from "../capabilities/CapabilityRepository.ts";
import { AttachmentRepository } from "../attachments/AttachmentRepository.ts";
import { type CommandLogEntry, CommandLogRepository } from "../persistence/CommandLogRepository.ts";
import { UserRepository } from "../org/UserRepository.ts";
import { NotificationRepository } from "./NotificationRepository.ts";
import { TicketRepository } from "./TicketRepository.ts";
import { WorkflowRepository } from "./WorkflowRepository.ts";
import { ProjectRepository } from "./ProjectRepository.ts";

type Caller = string | Extract<CurrentActor["Service"], { agentId: string }>;
type WorkflowRpc = RpcGroup.Rpcs<typeof Workflows>;
type Payload<Tag extends string> = Rpc.Payload<Rpc.ExtractTag<WorkflowRpc, `workflows.${Tag}`>>;

const toFile = ({ id, name }: Attachment) => ({ id, name });

/** Encoding the view drops what it doesn't name: the description and the steps' values. */
const summaryOf = (ticket: Ticket): TicketSummaryView => ({
  ...ticket,
  currentStep: currentStep(ticket),
});

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

/** A ticket with its project and the version of the workflow it runs on. */
interface Work {
  readonly project: Project;
  readonly version: WorkflowVersion;
  ticket: Ticket;
}

const make = Effect.gen(function* () {
  const workflows = yield* WorkflowRepository;
  const projects = yield* ProjectRepository;
  const tickets = yield* TicketRepository;
  const notifications = yield* NotificationRepository;
  const users = yield* UserRepository;
  const agents = yield* AgentRepository;
  const capabilities = yield* CapabilityRepository;
  const automations = yield* AutomationRepository;
  const files = yield* AttachmentRepository;
  const commandLog = yield* CommandLogRepository;
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
          rowFields: field.type === "group" && field.repeatable ? field.fields : [],
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
  const projectAccess = yield* ProjectAssistant.makeAccess;
  const loadProject = Effect.fnUntraced(function* (caller: Caller, projectId: string) {
    if (typeof caller === "string") return yield* projectAccess.load(caller, projectId);
    if (caller.origin.kind !== "conversation" || caller.origin.projectId !== projectId)
      return yield* new NotFound();
    return yield* projectAccess.load(caller.origin.ownerUserId, projectId);
  });
  const resolvePerson = (caller: Caller, projectId: string) =>
    typeof caller === "string"
      ? Effect.succeed(caller)
      : loadProject(caller, projectId).pipe(Effect.map(({ actor }) => actor.id));

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

  const activeAdminIds = (project: Project) => Effect.filter(project.adminUserIds, isActivePerson);

  /** The workflow's steps, by definition id, an active person is a member of in the project. */
  const memberOf = Effect.fnUntraced(function* (userId: string, projectId: string) {
    return new Set(
      (yield* isActivePerson(userId)) ? yield* projects.members.stepIdsOf(projectId, userId) : [],
    );
  });

  const notify = Effect.fnUntraced(function* (input: {
    readonly kind: NotificationKind;
    readonly to: string | null;
    readonly project: Project;
    readonly step: Step;
    readonly actorId: string | null;
  }) {
    if (input.to === null || input.to === input.actorId) return;
    if ((yield* users.get(input.to)) === null) return;
    yield* notifications.insert(input.to, {
      id: NotificationId.make(generateId()),
      kind: input.kind,
      stepId: input.step.id,
      projectId: input.project.id,
      isRead: false,
      createdAt: yield* DateTime.now,
    });
  });

  /** Tells the project's admins that it names someone who left as a step's default assignee. */
  const tellAdmins = Effect.fnUntraced(function* (project: Project) {
    const kind = "names_deactivated";
    const at = yield* DateTime.now;
    for (const userId of yield* activeAdminIds(project)) {
      if (yield* notifications.hasUnreadNotice({ userId, kind, projectId: project.id })) continue;
      yield* notifications.insert(userId, {
        id: NotificationId.make(generateId()),
        kind,
        stepId: null,
        projectId: project.id,
        isRead: false,
        createdAt: at,
      });
    }
  });

  /** Logs a successful command; call it inside the command's transaction. */
  const record = Effect.fnUntraced(function* (
    command: WorkflowRpc["_tag"],
    caller: Caller,
    target: Pick<CommandLogEntry, "workflowId" | "projectId" | "ticketId" | "stepId">,
    details: CommandLogEntry["details"] = {},
  ) {
    yield* commandLog.append({
      command,
      ...(typeof caller === "string"
        ? { userId: caller, agentId: null, chatId: null }
        : {
            userId: effectiveUserIdOf(caller.origin),
            agentId: caller.agentId,
            chatId: caller.chatId,
          }),
      ...target,
      details,
      createdAt: yield* DateTime.now,
    });
  });
  const targetOf = (work: Work, step?: Step) => ({
    projectId: work.project.id,
    ticketId: work.ticket.id,
    stepId: step?.id,
  });

  /** A ticket's steps are entered from its own version, which never changes once adopted. */
  const definitionOf = (work: Work, step: Step) =>
    findStep(work.version.steps, step.stepDefinitionId)!.step;

  const nameOf = (work: Work, step: Step) => definitionOf(work, step).name;

  const stepIn = (work: Work, stepId: string) => stepInTicket(work.ticket, stepId);
  const putStep = (work: Work, step: Step) => {
    work.ticket = putTicketStep(work.ticket, step);
  };

  const save = (work: Work) => tickets.update(work.ticket);
  const workOf = Effect.fnUntraced(function* (ticket: Ticket) {
    const project = yield* found(projects.get(ticket.projectId));
    const version = yield* found(workflows.versions.get(ticket.workflowVersionId));
    return { project, version, ticket };
  });
  const adoptedOf = (project: Project) =>
    project.workflowVersionId === null
      ? Effect.succeed(null)
      : workflows.versions.get(project.workflowVersionId);
  /** A workflow always has a version: its first is made with it. */
  const versionsOf = (workflowId: string) => workflows.versions.listForWorkflow(workflowId);
  const latestOf = (workflowId: string) =>
    Effect.map(versionsOf(workflowId), (versions) => versions.at(-1)!);

  const loadTicket = (ticketId: string) =>
    found(tickets.get(ticketId)).pipe(Effect.flatMap(workOf));

  const loadStep = Effect.fnUntraced(function* (stepId: string) {
    const work = yield* found(tickets.getByStepId(stepId)).pipe(Effect.flatMap(workOf));
    const step = stepIn(work, stepId);
    if (step === null) return yield* new NotFound();
    return { work, step };
  });

  const accessOf = (work: Work, userId: string) =>
    Effect.map(memberOf(userId, work.project.id), (steps) =>
      ticketAccess(steps, work.version, work.ticket),
    );
  /** A step someone doesn't see is as good as missing, whatever they manage. */
  const requireSees = Effect.fnUntraced(function* (work: Work, step: Step, userId: string) {
    if (!canSeeStep(yield* accessOf(work, userId), work.ticket, step)) return yield* new NotFound();
  });

  const loadAutomationStep = Effect.fnUntraced(function* (origin: AutomationOrigin) {
    if (origin.trigger.type !== "step") return yield* new NotFound();
    const work = yield* loadTicket(origin.trigger.ticketId);
    const step = stepIn(work, origin.trigger.stepId);
    if (
      step === null ||
      !definitionOf(work, step).automationIds.includes(origin.trigger.automationId)
    )
      return yield* new NotFound();
    return { work, step };
  });
  const loadForCommand = Effect.fnUntraced(function* (actorId: string, stepId: string) {
    const loaded = yield* loadStep(stepId);
    yield* requireSees(loaded.work, loaded.step, actorId);
    yield* requireOpen(loaded.work);
    return loaded;
  });
  const requireActionable = (step: Step) =>
    isActionable(step)
      ? Effect.void
      : Effect.fail(new WorkflowRefused({ reason: "step_not_actionable" }));
  /** A done or cancelled ticket is closed for good: nothing changes it. */
  const requireOpen = (work: Work) =>
    work.ticket.status.type === "open"
      ? Effect.void
      : Effect.fail(new WorkflowRefused({ reason: "ticket_not_open" }));
  const requireWorkingStep = (work: Work, step: Step) =>
    Effect.andThen(requireOpen(work), requireActionable(step));

  const loadStepFor = Effect.fnUntraced(function* (caller: Caller, stepId: string) {
    if (typeof caller !== "string" && caller.origin.kind === "automation") {
      const { work, step } = yield* loadAutomationStep(caller.origin);
      if (step.id !== stepId) return yield* new NotFound();
      // The run acts for whoever started it, with the access they have now.
      yield* requireSees(work, step, caller.origin.trigger.effectiveUserId);
      yield* requireWorkingStep(work, step);
      return { work, step, actorId: caller.agentId };
    }
    const { work, step } = yield* loadStep(stepId);
    const actorId = yield* resolvePerson(caller, work.project.id);
    yield* requireSees(work, step, actorId);
    yield* requireOpen(work);
    return { work, step, actorId };
  });

  const requireReason = (reason: string) => {
    const trimmed = reason.trim();
    return trimmed
      ? Effect.succeed(trimmed)
      : Effect.fail(new WorkflowRefused({ reason: "reason_required" }));
  };

  /** Finds the project for someone who manages it. */
  const loadManaged = Effect.fnUntraced(function* (actorId: string, idOrSlug: string) {
    const project = yield* found(projects.getByIdOrSlug(idOrSlug));
    if (!canManageProject(yield* actorOf(actorId), project))
      return yield* new WorkflowRefused({ reason: "not_project_admin" });
    return project;
  });

  const pairWithWorkflows = Effect.fnUntraced(function* (list: ReadonlyArray<Project>) {
    const byId = new Map((yield* workflows.list).map((workflow) => [workflow.id, workflow]));
    return list.flatMap((project) => {
      const workflow = byId.get(project.workflowId);
      return workflow === undefined ? [] : [{ project, workflow }];
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
    return {
      projectName: work.project.name,
      ticketTitle: work.ticket.title,
      ticketDescription: work.ticket.description,
      stepName: nameOf(work, step),
      instructions: definition.instructions,
      parents: containing.toReversed().map((parent) => ({
        name: nameOf(work, parent),
        instructions: definitionOf(work, parent).instructions,
      })),
      inputs: yield* buildInputViews(work, step),
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
        `You contribute to ${subject} of "${brief.ticketTitle}" in the project "${brief.projectName}". The step is below as JSON: its instructions, the fields of earlier steps it reads as inputs, its own fields, its comments and its files. That is all you can see of this ticket.`,
        "Fill the step's fields with step_set_field, using each field's key and type below; a repeatable group's rowFields name the fields of its rows. Read the step again with step_get_step, report progress or results with step_comment, and attach files with step_attach. Each tool returns the actual operation result, or exactly why it refused. When your contribution is finished, end the conversation.",
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
      project: work.project,
      step,
      actorId,
    });
  });
  const isStepMember = (work: Work, step: Step, userId: string) =>
    Effect.map(memberOf(userId, work.project.id), (steps) =>
      steps.has(topLevelStep(work.ticket, step).stepDefinitionId),
    );
  /** The step goes to its default assignee, else to `inherited`: the first who is a member of it. */
  const enterStep = Effect.fnUntraced(function* (
    work: Work,
    definition: StepDefinition,
    parent: Step | null,
    inherited: string | null,
    actorId: string | null,
  ): Effect.fn.Return<Step> {
    const stepDefinitionId =
      parent === null ? definition.id : topLevelStep(work.ticket, parent).stepDefinitionId;
    const candidates = [work.project.defaultAssignees[definition.id], inherited].flatMap(
      (userId) => userId ?? [],
    );
    const assignee = yield* Effect.findFirst(candidates, (userId) =>
      Effect.map(memberOf(userId, work.project.id), (steps) => steps.has(stepDefinitionId)),
    );
    const step = Step.make({
      stepDefinitionId: definition.id,
      status: { type: "working", at: yield* DateTime.now },
      parentStepId: parent?.id ?? null,
      assignee: Option.getOrNull(assignee),
      values: {},
    });
    putStep(work, step);
    yield* notify({ kind: "to_do", to: step.assignee, project: work.project, step, actorId });
    for (const child of definition.subSteps) {
      yield* enterStep(work, child, step, step.assignee, actorId);
    }
    return step;
  });

  const resolveField = (work: Work, step: Step, path: string) => {
    const resolved = resolveFieldPath(definitionOf(work, step).fields, path);
    if (typeof resolved === "string")
      return Effect.fail(new WorkflowRefused({ reason: "invalid_field_value", detail: resolved }));
    const missing = resolved.rows.find(
      (row) => !rowIds(step.values[row.groupPath]).includes(row.rowId),
    );
    if (missing !== undefined) {
      const existing = rowIds(step.values[missing.groupPath]);
      return Effect.fail(
        new WorkflowRefused({
          reason: "invalid_field_value",
          detail: `${missing.groupPath} has no row ${missing.rowId}; its rows are ${existing.length === 0 ? "none yet" : existing.join(", ")}. Add a row by setting ${missing.groupPath} to its row ids, the new one included.`,
        }),
      );
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

  const buildStepFieldViews = (work: Work, step: Step) =>
    buildCurrentStepFieldViews(definitionOf(work, step).fields, "", step.values);
  /** The fields of earlier steps the step declares as inputs: all it gets of them. */
  const buildInputViews = (work: Work, step: Step) =>
    Effect.forEach(
      stepInputFields(work.version.steps, work.ticket, definitionOf(work, step)),
      ({ source, field }) => buildCurrentStepFieldViews([field], "", source.values),
    ).pipe(Effect.map((views) => views.flat()));

  const listProjects = Effect.fnUntraced(function* (actorId: string) {
    const actor = yield* actorOf(actorId);
    return yield* pairWithWorkflows(
      (yield* projects.list).filter((project) => canManageProject(actor, project)),
    );
  });

  const listStartableProjects = Effect.fnUntraced(function* (actorId: string) {
    return yield* Effect.filter(
      yield* projectAccess.list(actorId),
      Effect.fnUntraced(function* (project) {
        const steps = yield* memberOf(actorId, project.id);
        return ticketStartRefusal(steps, project, yield* adoptedOf(project)) === null;
      }),
    );
  });

  const getProject = Effect.fnUntraced(function* (actorId: string, idOrSlug: string) {
    const project = yield* loadManaged(actorId, idOrSlug);
    return {
      project,
      workflow: yield* found(workflows.get(project.workflowId)),
      adopted: yield* adoptedOf(project),
      latest: yield* latestOf(project.workflowId),
      members: yield* projects.members.listForProject(project.id),
      // Encoding keeps a ticket's id, title and status: those who manage read nothing else of it.
      openTickets: yield* tickets.listOpen(project.id),
      canCancelTickets: isProjectAdmin(yield* actorOf(actorId), project),
    };
  });

  const getProjectBoard = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"getProjectBoard">,
  ) {
    const project = yield* found(projects.getByIdOrSlug(input.idOrSlug));
    const steps = yield* memberOf(actorId, project.id);
    // Someone who is a member of no step has no board, whatever they manage.
    if (steps.size === 0) return yield* new NotFound();
    if (project.workflowVersionId === null)
      return yield* new WorkflowRefused({ reason: "not_adopted" });
    const open = (yield* tickets.listOpen(project.id)).filter((ticket) => {
      const current = currentStep(ticket);
      return current !== null && steps.has(current.stepDefinitionId);
    });
    const versionIds = new Set([
      project.workflowVersionId,
      ...open.map((ticket) => ticket.workflowVersionId),
    ]);
    const versions = (yield* versionsOf(project.workflowId)).filter(({ id }) => versionIds.has(id));
    const version = yield* found(
      Effect.succeed(
        versions.find(({ id }) => id === (input.versionId ?? project.workflowVersionId)) ?? null,
      ),
    );
    return {
      project,
      version,
      columns: version.steps.filter((step) => steps.has(step.id)),
      versions: versions.toReversed(),
      tickets: open.filter((ticket) => ticket.workflowVersionId === version.id).map(summaryOf),
      canStartTicket: ticketStartRefusal(steps, project, yield* adoptedOf(project)) === null,
    };
  });

  const refuse = (reason: WorkflowRefused["reason"]) => new WorkflowRefused({ reason });

  /** Finds the workflow for someone who edits it; an archived workflow no longer changes. */
  const loadEditable = Effect.fnUntraced(function* (actorId: string, workflowId: string) {
    const workflow = yield* found(workflows.get(workflowId));
    if (!canEditWorkflow(yield* actorOf(actorId), workflow))
      return yield* refuse("not_workflow_editor");
    if (workflow.isArchived) return yield* refuse("workflow_archived");
    return workflow;
  });

  /** Each automation the edits attach must be one `actorId` may attach to the workflow. */
  const requireAttachable = (
    actorId: string,
    workflow: Workflow,
    edits: ReadonlyArray<WorkflowEdit>,
  ) =>
    Effect.forEach(
      edits,
      Effect.fnUntraced(function* (edit) {
        if (edit.type !== "attach_automation") return;
        const automation = yield* automations.get(edit.automationId);
        const agent = automation === null ? null : yield* agents.get(automation.agentId);
        if (
          agent === null ||
          !canAttachAgent(agent, workflow, actorId, yield* capabilities.listForAgent(agent.id))
        )
          return yield* refuse("invalid_automations");
      }),
      { discard: true },
    );

  const createWorkflow = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"createWorkflow">,
  ) {
    const steps = applyWorkflowEdits([], input.edits ?? [], []);
    if (steps === null) return yield* refuse("invalid_edit");
    if (!hasValidInputs(steps)) return yield* refuse("invalid_input");
    const workflow: Workflow = {
      id: generateId(),
      name: input.name,
      creatorUserId: actorId,
      editorUserIds: [],
      isArchived: false,
    };
    yield* requireAttachable(actorId, workflow, input.edits ?? []);
    yield* workflows.save(workflow);
    yield* workflows.versions.save({
      id: generateId(),
      workflowId: workflow.id,
      number: 1,
      revision: 0,
      isFrozen: false,
      steps,
    });
    yield* record("workflows.createWorkflow", actorId, { workflowId: workflow.id });
    return { workflowId: workflow.id };
  }, transaction);

  const renameWorkflow = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"renameWorkflow">,
  ) {
    const workflow = yield* loadEditable(actorId, input.workflowId);
    yield* workflows.save({ ...workflow, name: input.name });
    yield* record("workflows.renameWorkflow", actorId, { workflowId: workflow.id });
  }, transaction);

  const setWorkflowEditors = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"setWorkflowEditors">,
  ) {
    const workflow = yield* loadEditable(actorId, input.workflowId);
    if (!canSetWorkflowEditors(yield* actorOf(actorId), workflow))
      return yield* refuse("not_workflow_editor");
    const editorUserIds = [...new Set(input.editorUserIds)];
    for (const id of editorUserIds) {
      if (!workflow.editorUserIds.includes(id)) yield* requireValidPerson(id);
    }
    yield* workflows.save({ ...workflow, editorUserIds });
    yield* record(
      "workflows.setWorkflowEditors",
      actorId,
      { workflowId: workflow.id },
      { editorUserIds },
    );
  }, transaction);

  const archiveWorkflow = Effect.fnUntraced(function* (actorId: string, workflowId: string) {
    const workflow = yield* loadEditable(actorId, workflowId);
    yield* workflows.save({ ...workflow, isArchived: true });
    yield* record("workflows.archiveWorkflow", actorId, { workflowId });
  }, transaction);

  /** Reading the newest version and writing its successor share the transaction with adoption. */
  const saveWorkflowDraft = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"saveWorkflowDraft">,
  ) {
    const read = yield* found(workflows.versions.get(input.versionId));
    const workflow = yield* loadEditable(actorId, read.workflowId);
    const versions = yield* versionsOf(workflow.id);
    const latest = versions.at(-1)!;
    if (latest.id !== read.id || latest.revision !== input.revision)
      return yield* refuse("stale_draft");
    const steps = applyWorkflowEdits(
      latest.steps,
      input.edits,
      versions.flatMap((version) => stepIds(version.steps)),
    );
    if (steps === null) return yield* refuse("invalid_edit");
    if (!hasValidInputs(steps)) return yield* refuse("invalid_input");
    yield* requireAttachable(actorId, workflow, input.edits);
    const saved: WorkflowVersion = latest.isFrozen
      ? {
          id: generateId(),
          workflowId: workflow.id,
          number: latest.number + 1,
          revision: 0,
          isFrozen: false,
          steps,
        }
      : { ...latest, revision: latest.revision + 1, steps };
    yield* workflows.versions.save(saved);
    yield* record(
      "workflows.saveWorkflowDraft",
      actorId,
      { workflowId: workflow.id },
      { versionId: saved.id, revision: saved.revision },
    );
  }, transaction);

  const createProject = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"createProject">,
  ) {
    const workflow = yield* found(workflows.get(input.workflowId));
    if (workflow.isArchived) {
      return yield* new WorkflowRefused({ reason: "workflow_archived" });
    }
    const project: Project = {
      id: generateId(),
      workflowId: workflow.id,
      workflowVersionId: null,
      name: input.name ?? workflow.name,
      adminUserIds: [actorId],
      defaultAssignees: {},
      slug: null,
      isArchived: false,
    };
    yield* projects.insert(project);
    yield* record("workflows.createProject", actorId, {
      workflowId: workflow.id,
      projectId: project.id,
    });
    return { projectId: project.id };
  }, transaction);

  const adoptWorkflowVersion = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"adoptWorkflowVersion">,
  ) {
    const project = yield* loadManaged(actorId, input.projectId);
    const version = yield* found(workflows.versions.get(input.versionId));
    if (version.workflowId !== project.workflowId) return yield* new NotFound();
    if (project.isArchived) return yield* refuse("project_archived");
    if ((yield* found(workflows.get(project.workflowId))).isArchived)
      return yield* refuse("workflow_archived");
    if (version.revision !== input.revision) return yield* refuse("stale_draft");
    if (version.steps.length === 0) return yield* refuse("no_steps");
    // Checked in the adoption's own transaction, so no step is adopted without someone to do it.
    const members = yield* projects.members.listForProject(project.id);
    for (const step of version.steps) {
      const active = yield* Effect.filter(
        members.filter((member) => member.stepId === step.id),
        (member) => isActivePerson(member.userId),
      );
      if (active.length === 0) return yield* refuse("step_without_members");
    }
    if (!version.isFrozen) yield* workflows.versions.save({ ...version, isFrozen: true });
    yield* projects.update({ ...project, workflowVersionId: version.id });
    yield* record(
      "workflows.adoptWorkflowVersion",
      actorId,
      { workflowId: project.workflowId, projectId: project.id },
      { versionId: version.id },
    );
    yield* tickets.publishChange(project.id);
  }, transaction);

  const updateProject = Effect.fnUntraced(function* (
    actorId: string,
    { projectId, ...changes }: Payload<"updateProject">,
  ) {
    const project = yield* loadManaged(actorId, projectId);
    for (const assignee of Object.values(changes.defaultAssignees ?? {}))
      yield* requireValidPerson(assignee);
    const adminUserIds = [...new Set(changes.adminUserIds ?? project.adminUserIds)];
    for (const id of adminUserIds) {
      if (!project.adminUserIds.includes(id)) yield* requireValidPerson(id);
    }
    if (lastAdminRefusal(yield* Effect.filter(adminUserIds, isActivePerson)) !== null) {
      return yield* new WorkflowRefused({ reason: "last_admin" });
    }
    yield* projects.update({
      ...project,
      ...changes,
      adminUserIds,
    });
    yield* record(
      "workflows.updateProject",
      actorId,
      { projectId: project.id },
      { changed: Object.keys(changes) },
    );
    yield* tickets.publishChange(project.id);
  }, transaction);

  /** A step of any version of the project's workflow: membership outlives the versions. */
  const loadMembership = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"addStepMember">,
  ) {
    const project = yield* loadManaged(actorId, input.projectId);
    const versions = yield* versionsOf(project.workflowId);
    if (!versions.some((version) => version.steps.some((step) => step.id === input.stepId)))
      return yield* new NotFound();
    // `loadManaged` also finds a project by its slug: from here on, its id.
    return { ...input, projectId: project.id };
  });

  const addStepMember = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"addStepMember">,
  ) {
    const member = yield* loadMembership(actorId, input);
    yield* requireValidPerson(member.userId);
    yield* projects.members.add(member);
    yield* record(
      "workflows.addStepMember",
      actorId,
      { projectId: member.projectId },
      { stepDefinitionId: member.stepId, userId: member.userId },
    );
    yield* tickets.publishChange(member.projectId);
  }, transaction);

  /** The steps of open tickets that keep `input.userId` a member of the step. */
  const stepAssignments = Effect.fnUntraced(function* (input: Payload<"removeStepMember">) {
    return (yield* tickets.listOpen(input.projectId)).flatMap((ticket) =>
      stepsAssignedUnder(ticket, input.stepId, input.userId).map((step) => ({ ticket, step })),
    );
  });

  const removeStepMember = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"removeStepMember">,
  ) {
    const member = yield* loadMembership(actorId, input);
    if ((yield* stepAssignments(member)).length > 0) return yield* refuse("member_assigned");
    yield* projects.members.remove(member);
    yield* record(
      "workflows.removeStepMember",
      actorId,
      { projectId: member.projectId },
      { stepDefinitionId: member.stepId, userId: member.userId },
    );
    yield* tickets.publishChange(member.projectId);
  }, transaction);

  const listStepAssignments = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"listStepAssignments">,
  ) {
    const member = yield* loadMembership(actorId, input);
    return yield* Effect.forEach(yield* stepAssignments(member), ({ ticket, step }) =>
      Effect.map(workOf(ticket), (work) => ({
        ticketTitle: ticket.title,
        stepId: step.id,
        stepName: nameOf(work, step),
      })),
    );
  });

  const archiveProject = Effect.fnUntraced(function* (actorId: string, projectId: string) {
    const project = yield* loadManaged(actorId, projectId);
    // Checked in the archive's own transaction, so an archived project never has an open ticket.
    if ((yield* tickets.listOpen(project.id)).length > 0) return yield* refuse("open_tickets");
    yield* projects.update({ ...project, isArchived: true });
    yield* record("workflows.archiveProject", actorId, { projectId: project.id });
    yield* tickets.publishChange(project.id);
  }, transaction);

  const startTicket = Effect.fnUntraced(function* (caller: Caller, input: Payload<"startTicket">) {
    const actorId = yield* resolvePerson(caller, input.projectId);
    const project = yield* found(projects.get(input.projectId));
    const version = yield* adoptedOf(project);
    const refusal = ticketStartRefusal(yield* memberOf(actorId, project.id), project, version);
    const first = version?.steps[0];
    if (refusal !== null || version === null || first === undefined)
      return yield* refuse(refusal ?? "not_adopted");
    const at = yield* DateTime.now;
    const work: Work = {
      project,
      version,
      ticket: {
        id: generateId(),
        projectId: project.id,
        workflowVersionId: version.id,
        title: input.title,
        description: (input.description ?? "").trim(),
        status: { type: "open" },
        steps: [],
        createdAt: at,
      },
    };
    yield* tickets.insert(work.ticket);
    const step = yield* enterStep(work, first, null, null, actorId);
    yield* save(work);
    yield* record("workflows.startTicket", caller, targetOf(work, step));
    return { ticketId: work.ticket.id, stepId: step.id };
  }, transaction);

  const cancelTicket = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"cancelTicket">,
  ) {
    const work = yield* loadTicket(input.ticketId);
    // Cancelling manages the ticket without reading it; no membership or other role allows it.
    if (!isProjectAdmin(yield* actorOf(actorId), work.project))
      return yield* refuse("not_project_admin");
    yield* requireOpen(work);
    const reason = yield* requireReason(input.reason);
    for (const step of work.ticket.steps) yield* stopStepRuns(work, step);
    work.ticket = {
      ...work.ticket,
      status: { type: "cancelled", reason },
    };
    yield* save(work);
    // Recorded on the step the ticket stopped in, whose history then ends with it.
    yield* record(
      "workflows.cancelTicket",
      actorId,
      targetOf(work, occupiedStep(work.ticket) ?? undefined),
    );
  }, transaction);

  /** One read of a step's view: an automation reads its own step with its starter's access. */
  const readStep = Effect.fnUntraced(function* (caller: Caller, stepId: string) {
    if (typeof caller !== "string" && caller.origin.kind === "automation") {
      const { work, step } = yield* loadAutomationStep(caller.origin);
      if (step.id !== stepId) return yield* new NotFound();
      return yield* getStep(caller.origin.trigger.effectiveUserId, work.ticket.id, stepId);
    }
    const { work } = yield* loadStep(stepId);
    return yield* getStep(yield* resolvePerson(caller, work.project.id), work.ticket.id, stepId);
  });

  const getStep = Effect.fnUntraced(function* (actorId: string, ticketId: string, stepId: string) {
    const work = yield* loadTicket(ticketId);
    const step = stepIn(work, stepId);
    const access = yield* accessOf(work, actorId);
    if (step === null || access === null || !canSeeStep(access, work.ticket, step))
      return yield* new NotFound();
    const parents = ancestorSteps(work.ticket, step).toReversed();
    const root = parents[0] ?? step;
    const isOpen = work.ticket.status.type === "open";
    return {
      ticket: work.ticket,
      projectName: work.project.name,
      // Someone who sees one step gets no other step, not even its name.
      otherSteps: yield* Effect.forEach(
        access.type === "all"
          ? work.ticket.steps.filter((other) => other.parentStepId === null)
          : [root],
        (other) =>
          Effect.gen(function* () {
            return {
              step: other,
              name: nameOf(work, other),
              fields: other.id === root.id ? [] : yield* buildStepFieldViews(work, other),
            };
          }),
      ),
      inputs: yield* buildInputViews(work, step),
      assignableUserIds: yield* Effect.filter(
        (yield* projects.members.listForProject(work.project.id))
          .filter((member) => member.stepId === root.stepDefinitionId)
          .map((member) => member.userId),
        isActivePerson,
      ),
      history: yield* commandLog.listForStep(work.ticket.id, step.id),
      canCancelTicket: isOpen && isProjectAdmin(yield* actorOf(actorId), work.project),
      step,
      definition: definitionOf(work, step),
      parents: parents.map((parent) => ({ id: parent.id, name: nameOf(work, parent) })),
      fields: yield* buildStepFieldViews(work, step),
      subSteps: childSteps(work.ticket, work.version.steps, step).map((child) => ({
        ...child,
        name: nameOf(work, child),
      })),
      comments: yield* tickets.comments(step.id),
      files: (yield* files.forStep(step.id)).filter((file) => file.fieldKey === null).map(toFile),
      automations: yield* Effect.gen(function* () {
        const attempts = yield* stepRuns(work, step);
        const isRunnable = isOpen && isActionable(step);
        const attached = definitionOf(work, step).automationIds;
        // An archived automation starts no new run.
        const live = yield* Effect.filter(attached, (id) =>
          Effect.map(automations.get(id), (automation) => automation !== null),
        );
        return attached.map((id) => {
          const canRun = isRunnable && live.includes(id);
          const runs = attempts
            .filter((run) => run.trigger.automationId === id)
            .map(({ trigger, startedAt, chatStatus }) => ({
              ranBy: trigger.effectiveUserId,
              startedAt,
              status:
                chatStatus === null
                  ? ("completed" as const)
                  : chatStatus === "interrupted"
                    ? ("stopped" as const)
                    : chatStatus,
            }))
            .toReversed();
          return {
            id,
            runs,
            runLabel: canRun
              ? runs.length === 0
                ? ("Run" as const)
                : ("Run again" as const)
              : null,
            canStop: canRun && runs[0]?.status === "running",
          };
        });
      }),
    };
  });

  const setStepField = Effect.fnUntraced(function* (
    caller: Caller,
    input: Payload<"setStepField">,
  ) {
    const { work, step } = yield* loadStepFor(caller, input.stepId);
    yield* requireWorkingStep(work, step);
    const field = yield* resolveField(work, step, input.fieldKey);
    const blank =
      (typeof input.value === "string" && input.value.trim() === "") ||
      (Array.isArray(input.value) && input.value.length === 0);
    const value = blank ? null : input.value;
    let values = step.values;
    const problem =
      field.type === "file"
        ? `${input.fieldKey} is a file field: attach a file with this field's key instead.`
        : value !== null || field.type === "group"
          ? fieldValueProblem(field, input.fieldKey, value ?? [])
          : null;
    if (problem !== null)
      return yield* new WorkflowRefused({ reason: "invalid_field_value", detail: problem });
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
    yield* record("workflows.setStepField", caller, targetOf(work, step), {
      fieldKey: input.fieldKey,
    });
  }, transaction);

  const markStepDone = Effect.fnUntraced(function* (actorId: string, stepId: string) {
    const { work, step } = yield* loadForCommand(actorId, stepId);
    yield* requireActionable(step);
    const refusal = stepCompletionRefusal(definitionOf(work, step), work.ticket, step);
    if (refusal !== null) return yield* new WorkflowRefused({ reason: refusal });
    const completed = completeTicketStep(
      work.ticket,
      work.version.steps,
      step,
      yield* DateTime.now,
    );
    // The next step is entered whole or not at all: nothing is completed when it can't start.
    const entryRefusal =
      completed.next === null
        ? null
        : stepEntryRefusal(work.version.steps, completed.ticket, completed.next);
    if (entryRefusal !== null) return yield* refuse(entryRefusal);
    yield* stopStepRuns(work, step);
    work.ticket = completed.ticket;
    if (completed.next !== null)
      yield* enterStep(work, completed.next, null, step.assignee, actorId);
    yield* save(work);
    yield* record("workflows.markStepDone", actorId, targetOf(work, step));
  }, transaction);

  const setStepAssignee = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"setStepAssignee">,
  ) {
    const { work, step } = yield* loadStep(input.stepId);
    // Those who manage the project reassign any step of an open ticket, completed ones too, so
    // that a member can leave; they need not see the step. Its members reassign it while it's live.
    if (!canManageProject(yield* actorOf(actorId), work.project)) {
      yield* requireSees(work, step, actorId);
      if (!isLive(step)) return yield* refuse("step_not_actionable");
    }
    yield* requireOpen(work);
    if (input.assignee !== null && !(yield* isStepMember(work, step, input.assignee)))
      return yield* refuse("not_step_member");
    if (input.assignee === step.assignee) return;
    const reassigned: Step = { ...step, assignee: input.assignee };
    putStep(work, reassigned);
    if (isLive(step))
      yield* notify({
        kind: "to_do",
        to: input.assignee,
        project: work.project,
        step: reassigned,
        actorId,
      });
    yield* save(work);
    yield* record("workflows.setStepAssignee", actorId, targetOf(work, step), {
      assignee: input.assignee,
    });
  }, transaction);

  const blockStep = Effect.fnUntraced(function* (actorId: string, input: Payload<"blockStep">) {
    const { work, step } = yield* loadForCommand(actorId, input.stepId);
    yield* requireActionable(step);
    const reason = yield* requireReason(input.reason);
    yield* stopStepRuns(work, step);
    putStep(work, { ...step, status: { type: "blocked", at: yield* DateTime.now, reason } });
    yield* save(work);
    yield* record("workflows.blockStep", actorId, targetOf(work, step));
  }, transaction);

  const unblockStep = Effect.fnUntraced(function* (actorId: string, stepId: string) {
    const { work, step } = yield* loadForCommand(actorId, stepId);
    if (step.status.type !== "blocked") {
      return yield* new WorkflowRefused({ reason: "step_not_actionable" });
    }
    putStep(work, { ...step, status: { type: "working", at: yield* DateTime.now } });
    yield* save(work);
    yield* record("workflows.unblockStep", actorId, targetOf(work, step));
  }, transaction);

  const commentOnStep = Effect.fnUntraced(function* (
    caller: Caller,
    input: Payload<"commentOnStep">,
  ) {
    const { work, step, actorId } = yield* loadStepFor(caller, input.stepId);
    const commentId = generateId();
    yield* tickets.insertComment(work.ticket.id, {
      id: commentId,
      author: actorId,
      body: input.body,
      createdAt: yield* DateTime.now,
      stepId: step.id,
    });
    yield* record("workflows.commentOnStep", caller, targetOf(work, step), { commentId });
  }, transaction);
  const attachStepFile = Effect.fnUntraced(function* (
    caller: Caller,
    input: Payload<"attachStepFile">,
  ) {
    const { work, step, actorId } = yield* loadStepFor(caller, input.stepId);
    const fieldKey = input.fieldKey ?? null;
    if (fieldKey !== null) {
      yield* requireWorkingStep(work, step);
      const field = yield* resolveField(work, step, fieldKey);
      if (field.type !== "file") {
        return yield* new WorkflowRefused({
          reason: "invalid_field_value",
          detail: `${fieldKey} is a ${field.type} field, not a file field: set it with its value instead.`,
        });
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
    yield* record("workflows.attachStepFile", caller, targetOf(work, step), {
      attachmentId: claimed.id,
      fieldKey,
    });
    if (fieldKey === null) return yield* tickets.publishChange(work.ticket.id);
    putStep(work, { ...step, values: { ...step.values, [fieldKey]: claimed.id } });
    yield* save(work);
  }, transaction);

  const removeStepFile = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"removeStepFile">,
  ) {
    const { work, step } = yield* loadForCommand(actorId, input.stepId);
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
    yield* record("workflows.removeStepFile", actorId, targetOf(work, step), {
      attachmentId: file.id,
    });
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
          projectName: work.project.name,
          stepName: nameOf(work, step),
          parentNames: ancestorSteps(work.ticket, step)
            .toReversed()
            .map((parent) => nameOf(work, parent)),
        });
      }
    }
    return assignments.toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.step.status.at) - DateTime.toEpochMillis(right.step.status.at),
    );
  });

  const describe = Effect.fnUntraced(function* (rows: ReadonlyArray<Notification>) {
    const views: Array<NotificationView> = [];
    for (const notification of rows) {
      const project = yield* projects.get(notification.projectId);
      if (project === null) continue;
      const ticket =
        notification.stepId === null ? null : yield* tickets.getByStepId(notification.stepId);
      const step = ticket?.steps.find((candidate) => candidate.id === notification.stepId);
      const version =
        ticket === null ? null : yield* workflows.versions.get(ticket.workflowVersionId);
      views.push({
        ...notification,
        projectName: project.name,
        ticketTitle: ticket?.title ?? null,
        stepName:
          step === undefined || version === null
            ? null
            : (findStep(version.steps, step.stepDefinitionId)?.step.name ?? null),
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
    const all = yield* projects.list;
    for (const project of all) {
      if (!project.adminUserIds.includes(userId)) continue;
      if (lastAdminRefusal(yield* activeAdminIds(project)) !== null)
        return yield* new UserRefused({ reason: "last_project_admin" });
    }
    for (const project of all) {
      if (!project.isArchived && Object.values(project.defaultAssignees).includes(userId))
        yield* tellAdmins(project);
    }
  });

  /** Whoever runs a step's automation must be able to use its agent. */
  const requireStepAutomation = Effect.fnUntraced(function* (id: AutomationId, userId: string) {
    const automation = yield* automations.get(id);
    const agent = automation === null ? null : yield* agents.get(automation.agentId);
    if (
      automation === null ||
      agent === null ||
      !canWorkSteps(agent, yield* capabilities.listForAgent(agent.id)) ||
      !canUse(agent, userId)
    )
      return yield* refuse("invalid_automations");
    return automation;
  });
  const loadAutomation = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"runStepAutomation">,
  ) {
    const loaded = yield* loadForCommand(actorId, input.stepId);
    yield* requireActionable(loaded.step);
    if (!definitionOf(loaded.work, loaded.step).automationIds.includes(input.automationId))
      return yield* new NotFound();
    return loaded;
  });
  const runStepAutomation = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"runStepAutomation">,
  ) {
    const { work, step } = yield* loadAutomation(actorId, input);
    const automation = yield* requireStepAutomation(input.automationId, actorId);
    yield* stopStepRuns(work, step, (id) => id === automation.id);
    yield* chats.startAutomation(
      {
        type: "step",
        ticketId: work.ticket.id,
        stepId: step.id,
        automationId: automation.id,
        effectiveUserId: actorId,
      },
      automation.agentId,
      {
        title: `${work.ticket.title} · ${nameOf(work, step)}`.slice(0, 200).trim(),
        input: yield* buildAutomationInput(work, step, automation),
      },
    );
    yield* record("workflows.runStepAutomation", actorId, targetOf(work, step), {
      automationId: automation.id,
    });
  }, transaction);
  const stopStepAutomation = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"stopStepAutomation">,
  ) {
    const { work, step } = yield* loadAutomation(actorId, input);
    for (const chatId of yield* stopStepRuns(work, step, (id) => id === input.automationId))
      yield* automationEnded(chatId, actorId);
    yield* record("workflows.stopStepAutomation", actorId, targetOf(work, step), {
      automationId: input.automationId,
    });
  }, transaction);
  /** A step's inputs name other steps and their fields, which its members don't get to know. */
  const withoutInputs = (step: StepDefinition): StepDefinition =>
    new StepDefinition({ ...step, inputs: [], subSteps: step.subSteps.map(withoutInputs) });
  const getProjectWorkflow = Effect.fnUntraced(function* (caller: Caller, projectId: string) {
    const { project, steps } = yield* loadProject(caller, projectId);
    const adopted = yield* found(adoptedOf(project));
    return {
      projectId: project.id,
      name: project.name,
      steps: adopted.steps.filter((step) => steps.has(step.id)).map(withoutInputs),
    };
  });
  /** A ticket as `access` shows it: without the steps it hides. */
  const visibleTicket = (ticket: Ticket, access: NonNullable<TicketAccess>): Ticket => ({
    ...ticket,
    steps: ticket.steps.filter((step) => canSeeStep(access, ticket, step)),
  });
  const listTickets = Effect.fnUntraced(function* (caller: Caller, input: Payload<"listTickets">) {
    const { project, steps } = yield* loadProject(caller, input.projectId);
    const versions = yield* versionsOf(project.workflowId);
    const visible = (yield* tickets.listForProject(project.id, input.query ?? "")).flatMap(
      (ticket) => {
        const version = versions.find(({ id }) => id === ticket.workflowVersionId);
        const access = version === undefined ? null : ticketAccess(steps, version, ticket);
        return access === null ? [] : [visibleTicket(ticket, access)];
      },
    );
    return { total: visible.length, tickets: visible.slice(0, 100) };
  });
  const getTicket = Effect.fnUntraced(function* (caller: Caller, input: Payload<"getTicket">) {
    const work = yield* loadTicket(input.ticketId);
    const access = yield* accessOf(work, yield* resolvePerson(caller, work.project.id));
    if (access === null) return yield* new NotFound();
    return visibleTicket(work.ticket, access);
  });
  /**
   * Whether `userId` reads a step's file: they see its step, or see a step that declares the field
   * it fills as an input.
   */
  const canReadStepFile = Effect.fnUntraced(function* (userId: string, file: Attachment) {
    const loaded = file.stepId === null ? null : yield* Effect.option(loadStep(file.stepId));
    if (loaded === null || Option.isNone(loaded)) return false;
    const { work, step } = loaded.value;
    const access = yield* accessOf(work, userId);
    if (canSeeStep(access, work.ticket, step)) return true;
    const isInput = isSameInput({
      stepId: step.stepDefinitionId,
      fieldId: file.fieldKey?.split(".")[0] ?? "",
    });
    return work.ticket.steps.some(
      (reader) =>
        canSeeStep(access, work.ticket, reader) && definitionOf(work, reader).inputs.some(isInput),
    );
  });
  yield* chats.onEnd((chatId) => automationEnded(chatId, null));

  return {
    getProjectWorkflow,
    listTickets,
    getTicket,
    canReadStepFile,
    memberDeactivated,
    runStepAutomation,
    stopStepAutomation,
    listWorkflows: Effect.flatMap(workflows.list, (list) =>
      Effect.forEach(list, (workflow) =>
        Effect.map(latestOf(workflow.id), (version) => ({ workflow, version })),
      ),
    ),
    getWorkflow: (actorId: string, workflowId: string) =>
      Effect.gen(function* () {
        const workflow = yield* found(workflows.get(workflowId));
        const actor = yield* actorOf(actorId);
        return {
          workflow,
          version: yield* latestOf(workflowId),
          canEdit: canEditWorkflow(actor, workflow),
          canSetEditors: canSetWorkflowEditors(actor, workflow),
        };
      }),
    listProjects,
    listBoards: projectAccess.list,
    listStartableProjects,
    getProject,
    getProjectBoard,
    createWorkflow,
    renameWorkflow,
    setWorkflowEditors,
    archiveWorkflow,
    saveWorkflowDraft,
    createProject,
    adoptWorkflowVersion,
    updateProject,
    addStepMember,
    removeStepMember,
    listStepAssignments,
    archiveProject,
    startTicket,
    cancelTicket,
    readStep,
    watchStep: (actorId: string, stepId: string) =>
      Stream.unwrap(
        Effect.map(found(tickets.getByStepId(stepId)), (ticket) =>
          tickets.watch(ticket, getStep(actorId, ticket.id, stepId)),
        ),
      ).pipe(Stream.changesWith(sameStepView)),
    setStepField,
    markStepDone,
    setStepAssignee,
    blockStep,
    unblockStep,
    commentOnStep,
    attachStepFile,
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
