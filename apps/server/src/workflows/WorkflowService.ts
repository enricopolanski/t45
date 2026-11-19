import { type Automation, AutomationId } from "@t45/contracts/models/Automation";
import { AutomationRepository } from "../automations/AutomationRepository.ts";
import type { CurrentActor } from "@t45/contracts/Authorization";
import { ChatService } from "../chats/ChatService.ts";
import * as ProjectAssistant from "./ProjectAssistant.ts";
import type { Workflows } from "@t45/contracts/resources/Workflows";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import { ChatRepository } from "../chats/ChatRepository.ts";
import { ChatEvents } from "../chats/ChatEvents.ts";
import type { ChatId, Refusal as ChatRefusal } from "@t45/contracts/models/Chat";
import { type AutomationOrigin, effectiveUserIdOf } from "@t45/contracts/models/ChatOrigin";
import { canUse } from "@t45/contracts/models/Agent";
import { canWorkSteps } from "@t45/contracts/models/Workflow";
import type { Attachment, AttachmentId } from "@t45/contracts/models/Attachment";
import type { CollectionRecord } from "@t45/contracts/models/Collection";
import {
  type Notification,
  NotificationId,
  type NotificationKind,
} from "@t45/contracts/models/Notification";
import { generateId } from "@t45/contracts/models/primitives";
import { Refused as UserRefused } from "@t45/contracts/models/User";
import {
  type AutomationSkipReason,
  automationTriggerOf,
  stepInTicket,
  childSteps,
  ancestorSteps,
  putTicketStep,
  completeTicketStep,
  currentStep,
  ticketStartRefusal,
  applyWorkflowEdits,
  changedLayouts,
  isLayoutChangeOnly,
  setLayouts,
  canAttachAgent,
  canEditWorkflow,
  canSetWorkflowEditors,
  stepIds,
  type WorkflowActor,
  findStep,
  isActionable,
  isLive,
  canManageProject,
  isProjectAdmin,
  ticketAccess,
  canSeeStep,
  canReadStepHistory,
  isPreviousStep,
  topLevelStep,
  stepsAssignedUnder,
  stepInputFields,
  stepEntryRefusal,
  hasValidInputs,
  isSameInput,
  occupiedStep,
  stepCompletionRefusal,
  lastAdminRefusal,
  approvedValue,
  isReviewedField,
  proposalRefusal,
  recordReviewsOf,
  withEditedStepValues,
  confirmRecordEntry as withConfirmedRecordEntry,
  Step,
  StepDefinition,
  type Ticket,
  type Project,
  type Workflow,
  type TicketAccess,
  type WorkflowEdit,
  type WorkflowVersion,
  Refused as WorkflowRefused,
} from "@t45/contracts/models/Workflow";
import {
  defaultValues,
  type Field,
  type FieldValues,
  fieldValueProblem,
  fileKeys,
  groupRows,
  missingRow,
  resolveFieldPath,
  recordKeys,
  rowIds,
} from "@t45/contracts/models/Field";
import type { AssignmentView } from "@t45/contracts/resources/Assignments";
import { buildFieldViews } from "@t45/core/fieldViews";
import { NotFound } from "@t45/contracts/resources/errors";
import type { NotificationView } from "@t45/contracts/resources/Notifications";
import type {
  FieldView,
  StepFieldSelection,
  StepSnapshot,
  TicketSummaryView,
} from "@t45/contracts/resources/Workflows";
import { StepView } from "@t45/contracts/resources/Workflows";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";

import { AgentRepository } from "../agents/AgentRepository.ts";
import { CapabilityRepository } from "../capabilities/CapabilityRepository.ts";
import { AttachmentRepository, isAttachmentId } from "../attachments/AttachmentRepository.ts";
import { CollectionRecordRepository } from "../collections/CollectionRecordRepository.ts";
import { CollectionRepository } from "../collections/CollectionRepository.ts";
import { CollectionService } from "../collections/CollectionService.ts";
import { type CommandLogEntry, CommandLogRepository } from "../persistence/CommandLogRepository.ts";
import { UserRepository } from "../org/UserRepository.ts";
import { NotificationRepository } from "./NotificationRepository.ts";
import { TicketRepository } from "./TicketRepository.ts";
import { WorkflowRepository } from "./WorkflowRepository.ts";
import { ProjectRepository } from "./ProjectRepository.ts";

type Caller = string | Extract<CurrentActor["Service"], { agentId: string }>;
type WorkflowRpc = RpcGroup.Rpcs<typeof Workflows>;
type Payload<Tag extends string> = Rpc.Payload<Rpc.ExtractTag<WorkflowRpc, `workflows.${Tag}`>>;

const toFile = ({ id, name, uploader, createdAt }: Attachment) => ({
  id,
  name,
  uploader,
  createdAt,
});

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
const encodeCompactJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
/** Why a chat refuses to start a step's automation; it refuses a new automation chat for nothing else. */
const SKIP_REASON_OF_CHAT_REFUSAL: Partial<Record<ChatRefusal, AutomationSkipReason>> = {
  agent_unavailable: "automation_unavailable",
  input_too_long: "step_too_large",
  too_many_files: "step_too_large",
  images_too_large: "step_too_large",
  file_unavailable: "file_unavailable",
};
const isAutomationId = Schema.is(AutomationId);

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
  const collections = yield* CollectionRepository;
  const collectionRecords = yield* CollectionRecordRepository;
  const collectionAccess = yield* CollectionService;
  /** A record with the files its values hold. */
  const recordView = (record: CollectionRecord, fields: ReadonlyArray<Field>) =>
    Effect.map(
      files.forIds(
        fileKeys(fields, record.values)
          .map((key) => record.values[key])
          .filter(isAttachmentId),
      ),
      (held) => ({
        ...record,
        files: held
          .filter((file) => file.collectionId === record.collectionId)
          .map(({ id, name }) => ({ id, name })),
      }),
    );
  /** The views of `fields` with the records their records fields link, as long as those exist. */
  const linkRecords = (
    fields: ReadonlyArray<Field>,
    views: ReadonlyArray<FieldView>,
  ): Effect.Effect<Array<FieldView>> =>
    Effect.forEach(views, (view, at) =>
      Effect.gen(function* () {
        const field = fields[at];
        if (field?.type === "group")
          return {
            ...view,
            rows: yield* Effect.forEach(view.rows, (row) =>
              Effect.map(linkRecords(field.fields, row.fields), (linked) => ({
                ...row,
                fields: linked,
              })),
            ),
          };
        if (field?.type !== "records") return view;
        const collection = yield* collections.get(field.collectionId);
        if (collection === null) return view;
        const linked = yield* Effect.forEach(recordKeys(view.value), (key) =>
          collectionRecords.get(collection.id, key),
        );
        return {
          ...view,
          collection: Struct.pick(collection, [
            "id",
            "title",
            "fields",
            "primaryKeyFieldId",
            "columnOrder",
            "layout",
          ]),
          records: yield* Effect.forEach(
            linked.filter((record) => record !== null),
            (record) => recordView(record, collection.fields),
          ),
        };
      }),
    );
  /** The fields with their values, the files those values hold and the records they link. */
  const buildCurrentStepFieldViews = (fields: ReadonlyArray<Field>, values: Step["values"]) =>
    files.forIds(Object.values(values).filter(isAttachmentId)).pipe(
      Effect.flatMap((held) =>
        linkRecords(
          fields,
          buildFieldViews(fields, values, (id) => held.find((file) => file.id === id) ?? null),
        ),
      ),
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
      inputs: (yield* buildInputs(work, step)).inputs,
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

  const describeField = ({ id: key, label, type }: Field) => ({ key, label, type });
  const listAutomationFields = (work: Work, step: Step) => ({
    inputs: stepInputFields(work.version.steps, work.ticket, definitionOf(work, step)).map(
      ({ source, field }) => ({ ...describeField(field), sourceStepId: source.stepDefinitionId }),
    ),
    fields: definitionOf(work, step).fields.map((field) => ({
      ...describeField(field),
      ...(isReviewedField(field) ? { isReviewed: true } : {}),
    })),
  });

  const buildAutomationInput = Effect.fnUntraced(function* (
    work: Work,
    step: Step,
    automation: Automation,
  ) {
    if (automation.stepContext === "on_demand") {
      const definition = definitionOf(work, step);
      return {
        text: [
          `You are working on "${definition.name}" of "${work.ticket.title}" in "${work.project.name}".`,
          automation.prompt,
          "Use step_get_fields to read the input and output values you need. The list below identifies the input and output fields available to you. Use step_propose_value for reviewed fields and step_set_field for other fields.",
          encodeCompactJson(listAutomationFields(work, step)),
        ]
          .filter(Boolean)
          .join("\n\n"),
        attachments: [],
      };
    }
    const brief = yield* buildAutomationContext(work, step);
    const instructions = brief.instructions.trim();
    const subject =
      brief.parents.length === 0
        ? `the step "${brief.stepName}"`
        : `the sub-step "${brief.stepName}" of ${brief.parents.map((parent) => `"${parent.name}"`).join(" › ")}`;
    return {
      text: [
        `You contribute to ${subject} of "${brief.ticketTitle}" in the project "${brief.projectName}". The step is below as JSON: its instructions, the fields of earlier steps it reads as inputs, its own fields, its comments and its files. That is all you can see of this ticket.`,
        "Fill the step's fields with step_set_field, using each field's key and type below; a repeatable group's rowFields name the fields of its rows; a records field shows its collection and the records it links, and takes the keys of all the records it links, so save a new record with the collection tools before you add its key. Read the step again with step_get_step, report progress with progress_report, share results with step_comment, and attach files with step_attach. Each tool returns the actual operation result, or exactly why it refused. When your contribution is finished, end the conversation.",
        "Step comments and text fields marked isMarkdown are rendered as Markdown. Use short paragraphs separated by blank lines, lists for separate points, and labelled links for sources. Use actual newline characters in the saved text, not literal backslash-n sequences. Send Markdown directly, without an enclosing code fence; keep plain text in fields not marked isMarkdown.",
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
  /** Starts the automation on the step in a new chat; execution begins once the caller commits. */
  const startStepRun = Effect.fnUntraced(function* (
    work: Work,
    step: Step,
    automation: Automation,
    trigger: { readonly effectiveUserId: string; readonly isAutomatic: boolean },
  ) {
    yield* chats.startAutomation(
      {
        type: "step",
        ticketId: work.ticket.id,
        stepId: step.id,
        automationId: automation.id,
        ...trigger,
      },
      automation.agentId,
      {
        title: `${work.ticket.title} · ${nameOf(work, step)}`.slice(0, 200).trim(),
        input: yield* buildAutomationInput(work, step, automation),
      },
    );
  });
  /**
   * Starts the automations the project runs when a ticket enters the step, with its assignee's
   * permissions. Each that can't start leaves the step entered and keeps why on the step; it runs
   * in the same transaction as the entry, so the step's runs start once, with it.
   */
  const startEntryAutomations = Effect.fnUntraced(function* (work: Work, step: Step) {
    const at = yield* DateTime.now;
    const skipped = yield* Effect.forEach(
      definitionOf(work, step).automationIds.filter(
        (id) => automationTriggerOf(work.project, step.stepDefinitionId, id) === "step_entry",
      ),
      (automationId) =>
        Effect.gen(function* () {
          if (step.assignee === null) return "no_assignee" as const;
          const automation = yield* Effect.option(
            requireStepAutomation(automationId, step.assignee),
          );
          if (Option.isNone(automation)) return "automation_unavailable" as const;
          yield* startStepRun(work, step, automation.value, {
            effectiveUserId: step.assignee,
            isAutomatic: true,
          });
          yield* record("workflows.runStepAutomation", step.assignee, targetOf(work, step), {
            automationId,
            isAutomatic: true,
          });
          return null;
        }).pipe(
          Effect.catchTags({
            ChatRefused: (refused) => {
              const reason = SKIP_REASON_OF_CHAT_REFUSAL[refused.reason];
              return reason === undefined ? Effect.die(refused) : Effect.succeed(reason);
            },
          }),
          // A new chat's id is never taken.
          Effect.orDie,
          Effect.map((reason) => (reason === null ? null : { automationId, reason, at })),
        ),
    );
    const skippedAutomations = skipped.filter((entry) => entry !== null);
    if (skippedAutomations.length > 0) putStep(work, { ...step, skippedAutomations });
  });
  /** Starts the entry automations of the step and of the sub-steps entered with it, parents first. */
  const startEnteredAutomations = (work: Work, step: Step) =>
    Effect.forEach(
      work.ticket.steps.filter((entered) => topLevelStep(work.ticket, entered).id === step.id),
      (entered) => startEntryAutomations(work, entered),
      { discard: true },
    );
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
      values: defaultValues(definition.fields),
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
    const missing = missingRow(resolved.rows, step.values);
    if (missing !== null) {
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
    buildCurrentStepFieldViews(definitionOf(work, step).fields, step.values);

  /** A field's data without the options and layout used to display it in the app. */
  const readFieldValue = (
    field: Field,
    values: FieldValues,
    path: string,
    selection?: StepFieldSelection,
  ): Effect.Effect<Schema.Json> =>
    Effect.gen(function* () {
      const value = values[path] ?? null;
      if (field.type === "group") {
        const rows = yield* Effect.forEach(groupRows(field, value), (id) => {
          const prefix = id === null ? path : `${path}.${id}`;
          return Effect.forEach(field.fields, (child) =>
            Effect.map(
              readFieldValue(child, values, `${prefix}.${child.id}`),
              (value) => [child.id, value] as const,
            ),
          ).pipe(Effect.map((entries) => ({ id, values: Object.fromEntries(entries) })));
        });
        return { fields: field.fields.map(describeField), rows };
      }
      if (field.type === "records") {
        const requested = selection?.recordKeys;
        const columns = selection?.recordFields;
        const keys = recordKeys(value).filter(
          (key) => requested === undefined || requested.includes(key),
        );
        const records = yield* Effect.forEach(keys, (key) => {
          if (columns?.length === 0) return Effect.succeed({ key, values: {} });
          return Effect.map(collectionRecords.get(field.collectionId, key), (record) => {
            if (record === null) return null;
            return {
              key,
              values:
                columns === undefined
                  ? record.values
                  : Object.fromEntries(
                      Object.entries(record.values).filter(([path]) =>
                        columns.some((column) => path === column || path.startsWith(`${column}.`)),
                      ),
                    ),
            };
          });
        });
        return {
          collectionId: field.collectionId,
          records: records.filter((record) => record !== null),
        };
      }
      return value;
    });

  /** The fields of earlier steps the step declares as inputs: all it gets of them. */
  const buildInputs = (work: Work, step: Step, includeReviews = false) =>
    Effect.gen(function* () {
      const inputs = stepInputFields(work.version.steps, work.ticket, definitionOf(work, step));
      const bySource = new Map<Step, Array<Field>>();
      for (const { source, field } of inputs)
        bySource.set(source, [...(bySource.get(source) ?? []), field]);
      // Resolve links only among the fields the receiving step is allowed to read.
      const views = new Map(
        yield* Effect.forEach([...bySource], ([source, fields]) =>
          Effect.map(
            buildCurrentStepFieldViews(fields, source.values),
            (shown) => [source.id, new Map(shown.map((field) => [field.key, field]))] as const,
          ),
        ),
      );
      const shown = inputs.flatMap(({ source, field }) => {
        const view = views.get(source.id)?.get(field.id);
        return view === undefined ? [] : [{ source, field, view }];
      });
      const inputViews = shown.map(({ view }) => view);
      if (!includeReviews) return { inputs: inputViews };
      const inputRecordReviews = [...bySource].flatMap(([source, fields]) => {
        const indexOf = (id: string) =>
          shown.findIndex((input) => input.source.id === source.id && input.field.id === id);
        return recordReviewsOf(fields, source).flatMap((review) => {
          const recordsIndex = indexOf(review.recordsFieldId);
          const groupIndex = indexOf(review.groupFieldId);
          if (recordsIndex < 0 || groupIndex < 0) return [];
          return [
            {
              recordsIndex,
              groupIndex,
              recordKeyFieldId: review.recordKeyFieldId,
              entries: review.entries,
            },
          ];
        });
      });
      return { inputs: inputViews, inputRecordReviews };
    });

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
    const saved: WorkflowVersion =
      latest.isFrozen && !isLayoutChangeOnly(latest.steps, steps)
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
    // Tickets show a group the way it is laid out now, whatever version they started on.
    const layouts = changedLayouts(latest.steps, steps);
    if (layouts.size > 0) {
      for (const version of versions) {
        if (version.id !== saved.id)
          yield* workflows.versions.save({ ...version, steps: setLayouts(version.steps, layouts) });
      }
      yield* tickets.publishChange();
    }
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
    if (changes.stepHistoryAccess !== undefined) {
      const versions = yield* versionsOf(project.workflowId);
      if (
        changes.stepHistoryAccess.some(
          (entry) => !versions.some(({ steps }) => isPreviousStep(steps, entry)),
        )
      )
        return yield* refuse("invalid_step_history");
    }
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
    // Logged first, so the step's history starts with the ticket's creation.
    yield* record("workflows.startTicket", caller, targetOf(work, step));
    yield* startEnteredAutomations(work, step);
    yield* save(work);
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
    const reason = input.reason?.trim();
    for (const step of work.ticket.steps) yield* stopStepRuns(work, step);
    work.ticket = {
      ...work.ticket,
      status: reason ? { type: "cancelled", reason } : { type: "cancelled" },
    };
    yield* save(work);
    // Recorded on the step the ticket stopped in, whose history then ends with it.
    yield* record(
      "workflows.cancelTicket",
      actorId,
      targetOf(work, occupiedStep(work.ticket) ?? undefined),
    );
  }, transaction);

  /** An automation reads its own step with the access of the person it runs for. */
  const loadStepReader = Effect.fnUntraced(function* (caller: Caller, stepId: string) {
    if (typeof caller !== "string" && caller.origin.kind === "automation") {
      const { work, step } = yield* loadAutomationStep(caller.origin);
      if (step.id !== stepId) return yield* new NotFound();
      return { work, step, actorId: caller.origin.trigger.effectiveUserId };
    }
    const { work, step } = yield* loadStep(stepId);
    return { work, step, actorId: yield* resolvePerson(caller, work.project.id) };
  });

  const readStep = Effect.fnUntraced(function* (caller: Caller, stepId: string) {
    const { work, actorId } = yield* loadStepReader(caller, stepId);
    return yield* getStep(actorId, work.ticket.id, stepId);
  });

  const readStepFields = Effect.fnUntraced(function* (
    caller: Caller,
    query: Payload<"getStepFields">,
  ) {
    const { work, step, actorId } = yield* loadStepReader(caller, query.stepId);
    yield* requireSees(work, step, actorId);
    const definition = definitionOf(work, step);
    const inputs = yield* Effect.forEach(
      stepInputFields(work.version.steps, work.ticket, definition),
      ({ source, field }) => {
        const selection = query.inputs?.find(
          ({ key, sourceStepId }) =>
            key === field.id &&
            (sourceStepId === undefined || sourceStepId === source.stepDefinitionId),
        );
        return selection === undefined
          ? Effect.succeed(null)
          : Effect.map(readFieldValue(field, source.values, field.id, selection), (value) => ({
              ...describeField(field),
              sourceStepId: source.stepDefinitionId,
              value,
            }));
      },
    );
    const fields = yield* Effect.forEach(definition.fields, (field) => {
      const selection = query.fields?.find(({ key }) => key === field.id);
      return selection === undefined
        ? Effect.succeed(null)
        : Effect.map(readFieldValue(field, step.values, field.id, selection), (value) => ({
            ...describeField(field),
            value,
          }));
    });
    const selected = fields.filter((field) => field !== null);
    return {
      inputs: inputs.filter((input) => input !== null),
      fields: selected,
      proposals: (step.proposals ?? []).flatMap(({ fieldKey, value, isDiscarded }) =>
        selected.some(({ key }) => key === fieldKey || fieldKey.startsWith(`${key}.`))
          ? [{ fieldKey, value, isDiscarded }]
          : [],
      ),
    };
  });

  const stepContents = Effect.fnUntraced(function* (work: Work, step: Step, forPage: boolean) {
    const definition = definitionOf(work, step);
    return {
      definition,
      assignee: step.assignee,
      ...(yield* buildInputs(work, step, forPage)),
      fields: yield* buildStepFieldViews(work, step),
      recordReviews: recordReviewsOf(definition.fields, step),
      subSteps: childSteps(work.ticket, work.version.steps, step).map((child) => ({
        ...child,
        name: nameOf(work, child),
      })),
      comments: yield* tickets.comments(step.id),
      files: (yield* files.forStep(step.id)).filter((file) => file.fieldKey === null).map(toFile),
    } satisfies StepSnapshot;
  });

  const canBrowseHistory = (work: Work, access: TicketAccess, step: Step) =>
    canReadStepHistory(access, work.project, work.version, work.ticket, step);

  const getStep = Effect.fnUntraced(function* (
    actorId: string,
    ticketId: string,
    stepId: string,
    forPage = false,
  ) {
    const work = yield* loadTicket(ticketId);
    const step = stepIn(work, stepId);
    const access = yield* accessOf(work, actorId);
    if (step === null || access === null) return yield* new NotFound();
    const canSee = canSeeStep(access, work.ticket, step);
    if (!canSee && !(forPage && canBrowseHistory(work, access, step))) return yield* new NotFound();
    const parents = ancestorSteps(work.ticket, step).toReversed();
    const root = parents[0] ?? step;
    const isOpen = work.ticket.status.type === "open";
    const isCompleted = forPage && step.status.type === "completed";
    const snapshot = isCompleted ? yield* tickets.completedSteps.get(step.id) : null;
    const { assignee, ...contents } = snapshot ?? (yield* stepContents(work, step, forPage));
    const stepNavigation = work.ticket.steps
      .filter(
        (other) =>
          other.parentStepId === null &&
          (canSeeStep(access, work.ticket, other) || canBrowseHistory(work, access, other)),
      )
      .map((other) => ({ id: other.id, name: nameOf(work, other), status: other.status.type }));
    const history = yield* commandLog.listForStep(work.ticket.id, step.id);
    const historyAutomations = yield* automations.listByIds([
      ...new Set(
        history.flatMap(({ details }) =>
          isAutomationId(details.automationId) ? [details.automationId] : [],
        ),
      ),
    ]);
    return {
      ...contents,
      ticket: work.ticket,
      projectName: work.project.name,
      ...(forPage ? { stepNavigation } : {}),
      ...(isCompleted
        ? { completedStep: snapshot === null ? ("legacy" as const) : ("snapshot" as const) }
        : {}),
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
      assignableUserIds: isCompleted
        ? []
        : yield* Effect.filter(
            (yield* projects.members.listForProject(work.project.id))
              .filter((member) => member.stepId === root.stepDefinitionId)
              .map((member) => member.userId),
            isActivePerson,
          ),
      history: history.map(({ details, ...entry }) => {
        const automation = historyAutomations.find(({ id }) => id === details.automationId);
        return {
          ...entry,
          fieldKey: typeof details.fieldKey === "string" ? details.fieldKey : null,
          isAutomatic: details.isAutomatic === true,
          automation:
            automation === undefined ? null : { id: automation.id, title: automation.title },
        };
      }),
      canCancelTicket:
        !isCompleted && isOpen && isProjectAdmin(yield* actorOf(actorId), work.project),
      step: { ...step, assignee },
      parents: parents.map((parent) => ({ id: parent.id, name: nameOf(work, parent) })),
      proposals: isCompleted
        ? []
        : yield* Effect.forEach(step.proposals ?? [], (proposal) =>
            Effect.gen(function* () {
              const resolved = resolveFieldPath(definitionOf(work, step).fields, proposal.fieldKey);
              if (
                typeof resolved === "string" ||
                resolved.field.type !== "records" ||
                typeof proposal.value !== "string"
              )
                return { ...proposal, record: null };
              const collection = yield* collections.get(resolved.field.collectionId);
              const record =
                collection === null
                  ? null
                  : yield* collectionRecords.get(collection.id, proposal.value);
              return {
                ...proposal,
                record:
                  record === null || collection === null
                    ? null
                    : yield* recordView(record, collection.fields),
              };
            }),
          ),
      automations: !canSee
        ? []
        : yield* Effect.gen(function* () {
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
                .map(({ trigger, ...run }) => ({
                  ...run,
                  ranBy: trigger.effectiveUserId,
                  isAutomatic: trigger.type === "step" && trigger.isAutomatic,
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

  /** Refused unless the collection `field` links holds each of `keys`, and `caller` reads it. */
  const requireRecords = Effect.fnUntraced(function* (
    caller: Caller,
    field: Extract<Field, { type: "records" }>,
    keys: ReadonlyArray<string>,
  ) {
    yield* collectionAccess.requireReadable(caller, field.collectionId);
    for (const key of keys) {
      if ((yield* collectionRecords.get(field.collectionId, key)) === null)
        return yield* new WorkflowRefused({
          reason: "invalid_field_value",
          detail: `Collection ${field.collectionId} has no record ${key}: save it with the collection tools first.`,
        });
    }
  });

  /** Puts `value` in the field at `fieldKey` of `step`, once it fits; `save` keeps it. */
  const writeField = Effect.fnUntraced(function* (
    caller: Caller,
    work: Work,
    step: Step,
    field: Field,
    fieldKey: string,
    input: Schema.Json,
  ) {
    const blank =
      (typeof input === "string" && input.trim() === "") ||
      (Array.isArray(input) && input.length === 0);
    const value = blank ? null : input;
    let values = step.values;
    const problem =
      field.type === "file"
        ? `${fieldKey} is a file field: attach a file with this field's key instead.`
        : value !== null || field.type === "group"
          ? fieldValueProblem(field, fieldKey, value ?? [])
          : null;
    if (problem !== null)
      return yield* new WorkflowRefused({ reason: "invalid_field_value", detail: problem });
    if (field.type === "records") yield* requireRecords(caller, field, recordKeys(value));
    if (field.type === "group") {
      const before = rowIds(step.values[fieldKey]);
      const added = rowIds(value).filter((rowId) => !before.includes(rowId));
      values = {
        ...(yield* withoutRemovedRows(step, fieldKey, rowIds(value))),
        ...Object.fromEntries(
          added.flatMap((rowId) =>
            Object.entries(defaultValues(field.fields, `${fieldKey}.${rowId}`)),
          ),
        ),
      };
    }
    const others = Object.fromEntries(Object.entries(values).filter(([key]) => key !== fieldKey));
    putStep(
      work,
      withEditedStepValues(
        definitionOf(work, step).fields,
        step,
        value === null ? others : { ...others, [fieldKey]: value },
      ),
    );
  });

  const setStepField = Effect.fnUntraced(function* (
    caller: Caller,
    input: Payload<"setStepField">,
  ) {
    const { work, step } = yield* loadStepFor(caller, input.stepId);
    yield* requireWorkingStep(work, step);
    const field = yield* resolveField(work, step, input.fieldKey);
    if (typeof caller !== "string" && isReviewedField(field))
      return yield* new WorkflowRefused({ reason: "field_reviewed" });
    yield* writeField(caller, work, step, field, input.fieldKey, input.value);
    yield* save(work);
    yield* record("workflows.setStepField", caller, targetOf(work, step), {
      fieldKey: input.fieldKey,
    });
  }, transaction);

  const proposeStepField = Effect.fnUntraced(function* (
    caller: Caller,
    input: Payload<"proposeStepField">,
  ) {
    const { work, step, actorId } = yield* loadStepFor(caller, input.stepId);
    yield* requireWorkingStep(work, step);
    const field = yield* resolveField(work, step, input.fieldKey);
    const refusal = proposalRefusal(step, field, input.fieldKey, input.value);
    if (refusal !== null)
      return yield* new WorkflowRefused({ reason: "invalid_proposal", detail: refusal });
    if (field.type === "records") yield* requireRecords(caller, field, [input.value as string]);
    else {
      const problem = fieldValueProblem(field, input.fieldKey, input.value);
      if (problem !== null)
        return yield* new WorkflowRefused({ reason: "invalid_field_value", detail: problem });
    }
    const { stepId: _, ...proposed } = input;
    putStep(work, {
      ...step,
      proposals: [
        ...(step.proposals ?? []),
        {
          ...proposed,
          id: generateId(),
          author: typeof caller === "string" ? actorId : caller.agentId,
          isDiscarded: false,
          createdAt: yield* DateTime.now,
        },
      ],
    });
    yield* save(work);
    yield* record("workflows.proposeStepField", caller, targetOf(work, step), {
      fieldKey: input.fieldKey,
    });
  }, transaction);

  /** A member's open proposal on a step they work on, and the field it is for. */
  const loadProposal = Effect.fnUntraced(function* (actorId: string, stepId: string, id: string) {
    const { work, step } = yield* loadForCommand(actorId, stepId);
    yield* requireActionable(step);
    const proposal = step.proposals?.find((each) => each.id === id && !each.isDiscarded);
    if (proposal === undefined) return yield* new NotFound();
    const field = yield* resolveField(work, step, proposal.fieldKey);
    return { work, step, proposal, field };
  });

  const approveProposal = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"approveProposal">,
  ) {
    const { work, step, proposal, field } = yield* loadProposal(
      actorId,
      input.stepId,
      input.proposalId,
    );
    const value = approvedValue(field, step.values[proposal.fieldKey], proposal);
    const rest = step.proposals!.filter((each) => each.id !== proposal.id);
    yield* writeField(actorId, work, { ...step, proposals: rest }, field, proposal.fieldKey, value);
    yield* save(work);
    yield* record("workflows.approveProposal", actorId, targetOf(work, step), {
      fieldKey: proposal.fieldKey,
    });
  }, transaction);

  const discardProposal = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"discardProposal">,
  ) {
    const { work, step, proposal } = yield* loadProposal(actorId, input.stepId, input.proposalId);
    putStep(work, {
      ...step,
      proposals: step.proposals!.map((each) =>
        each.id === proposal.id ? { ...each, isDiscarded: true } : each,
      ),
    });
    yield* save(work);
    yield* record("workflows.discardProposal", actorId, targetOf(work, step), {
      fieldKey: proposal.fieldKey,
    });
  }, transaction);

  const confirmRecordEntry = Effect.fnUntraced(function* (
    actorId: string,
    input: Payload<"confirmRecordEntry">,
  ) {
    const { work, step } = yield* loadForCommand(actorId, input.stepId);
    yield* requireActionable(step);
    const reviewed = withConfirmedRecordEntry(definitionOf(work, step).fields, step, input);
    if (typeof reviewed === "string")
      return yield* new WorkflowRefused({ reason: "invalid_record_review", detail: reviewed });
    putStep(work, reviewed);
    yield* save(work);
    yield* record("workflows.confirmRecordEntry", actorId, targetOf(work, step), {
      fieldKey: `${input.groupFieldId}.${input.rowId}`,
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
    const snapshot = yield* stepContents(work, step, true);
    const linkedFileIds = (fields: ReadonlyArray<FieldView>): ReadonlyArray<AttachmentId> =>
      fields.flatMap((field) => [
        ...field.records.flatMap((record) => record.files.map(({ id }) => id)),
        ...field.rows.flatMap((row) => linkedFileIds(row.fields)),
      ]);
    const fields = [...snapshot.fields, ...snapshot.inputs];
    const attachments = new Set([
      ...snapshot.files.map(({ id }) => id),
      ...buildFieldFileIds(fields).filter(isAttachmentId),
      ...linkedFileIds(fields),
    ]);
    yield* tickets.completedSteps.save(work.ticket.id, step.id, snapshot, [...attachments]);
    work.ticket = completed.ticket;
    if (completed.next !== null)
      yield* startEnteredAutomations(
        work,
        yield* enterStep(work, completed.next, null, step.assignee, actorId),
      );
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
    yield* startStepRun(work, step, automation, { effectiveUserId: actorId, isAutomatic: false });
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
    if (canBrowseHistory(work, access, step) && !(yield* tickets.completedSteps.has(step.id)))
      return true;
    const isInput = isSameInput({
      stepId: step.stepDefinitionId,
      fieldId: file.fieldKey?.split(".")[0] ?? "",
    });
    return work.ticket.steps.some(
      (reader) =>
        canSeeStep(access, work.ticket, reader) && definitionOf(work, reader).inputs.some(isInput),
    );
  });
  const completedStepFileAccess = Effect.fnUntraced(function* (userId: string, id: AttachmentId) {
    const holders = yield* tickets.completedSteps.holdingFile(id);
    if (holders.length === 0) return null;
    for (const holder of holders) {
      const work = yield* loadTicket(holder.ticketId).pipe(Effect.option);
      if (Option.isNone(work)) continue;
      const step = stepIn(work.value, holder.stepId);
      if (step === null) continue;
      const access = yield* accessOf(work.value, userId);
      if (canSeeStep(access, work.value.ticket, step) || canBrowseHistory(work.value, access, step))
        return true;
    }
    return false;
  });
  yield* chats.onEnd((chatId) => automationEnded(chatId, null));

  return {
    getProjectWorkflow,
    listTickets,
    getTicket,
    canReadStepFile,
    completedStepFileAccess,
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
    readStepFields,
    watchStep: (actorId: string, stepId: string) =>
      Stream.unwrap(
        Effect.map(found(tickets.getByStepId(stepId)), (ticket) =>
          tickets.watch(ticket, getStep(actorId, ticket.id, stepId, true)),
        ),
      ).pipe(Stream.changesWith(sameStepView)),
    setStepField,
    proposeStepField,
    approveProposal,
    confirmRecordEntry,
    discardProposal,
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
