// @effect-diagnostics nodeBuiltinImport:off - Hashes the input and program behind each result.
import * as NodeCrypto from "node:crypto";
import { ATTACHMENT_MAX_FILE_BYTES } from "@t45/contracts/models/Attachment";
import { canUse } from "@t45/contracts/models/Agent";
import { type Automation, AutomationId } from "@t45/contracts/models/Automation";
import { recordKeys } from "@t45/contracts/models/Field";
import { listFieldFiles, resolveRecordDisplay } from "@t45/contracts/models/Layout";
import {
  applyScriptResultValues,
  buildScriptResult,
  getScriptOutputFields,
  isScriptOutputField,
  readScriptCalculator,
  readScriptedReview,
  readScriptExport,
  readScriptResultValues,
  type StepCalculator,
} from "@t45/contracts/models/StepCalculator";
import {
  currentStep,
  findStep,
  ownFields,
  getProposalSourceKeys,
  isSameInput,
  putTicketStep,
  stepNodes,
  type StepDefinition,
  type Step,
  type Ticket,
  type Workflow,
} from "@t45/contracts/models/Workflow";
import type { CalculatorOption } from "@t45/contracts/resources/Workflows";
import {
  ExecutionFailed,
  type ScriptFileRequest,
  type ScriptRequest,
} from "@t45/contracts/resources/Runner";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { AgentRepository } from "../agents/AgentRepository.ts";
import {
  AttachmentRepository,
  attachmentIsInlineImage,
  isAttachmentId,
} from "../attachments/AttachmentRepository.ts";
import { AutomationRepository } from "../automations/AutomationRepository.ts";
import { CapabilityRepository } from "../capabilities/CapabilityRepository.ts";
import { CollectionRecordRepository } from "../collections/CollectionRecordRepository.ts";
import { CollectionRepository } from "../collections/CollectionRepository.ts";
import { CollectionService } from "../collections/CollectionService.ts";
import { RunnerService } from "../runner/RunnerService.ts";
import { TicketRepository } from "./TicketRepository.ts";
import { WorkflowRepository } from "./WorkflowRepository.ts";

export const SCRIPT_RESULT_KEY = "$calculation";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

type CalculatorInput = StepCalculator["inputs"][string];

const getInputField = (steps: ReadonlyArray<StepDefinition>, input: CalculatorInput) => {
  const source = findStep(steps, input.stepId)?.step;
  return source && ownFields(source).find(({ id }) => id === input.fieldId);
};

const hasRecordInputs = (binding: StepCalculator) =>
  Object.values(binding.inputs).some(({ records }) => records !== undefined);

export const makeScriptCalculations = Effect.gen(function* () {
  const agents = yield* AgentRepository;
  const files = yield* AttachmentRepository;
  const automations = yield* AutomationRepository;
  const capabilities = yield* CapabilityRepository;
  const collectionAccess = yield* CollectionService;
  const collections = yield* CollectionRepository;
  const records = yield* CollectionRecordRepository;
  const runner = yield* RunnerService;
  const sql = yield* SqlClient.SqlClient;
  const tickets = yield* TicketRepository;
  const workflows = yield* WorkflowRepository;
  const scope = yield* Effect.scope;

  const getProgramAgent = Effect.fnUntraced(function* (automation: Automation, workflow: Workflow) {
    const agent = yield* agents.get(automation.agentId);
    return agent?.status === "active" && canUse(agent, workflow.creatorUserId) ? agent : null;
  });

  const getProgram = Effect.fnUntraced(function* (automation: Automation, workflow: Workflow) {
    const agent = yield* getProgramAgent(automation, workflow);
    if (agent === null) return null;
    const calculator = readScriptCalculator(agent.files);
    return calculator === null ? null : { calculator, agent };
  });

  const getExportProgram = Effect.fnUntraced(function* (
    workflow: Workflow,
    binding: StepCalculator,
  ) {
    const id = binding.exportAutomationId ?? (binding.kind === "script" ? binding.id : undefined);
    if (id === undefined) return null;
    const automation = yield* automations.get(AutomationId.make(id));
    const agent = automation === null ? null : yield* getProgramAgent(automation, workflow);
    if (agent === null) return null;
    const config = readScriptExport(agent.files);
    return config !== null &&
      (config.capabilities ?? []).every((capability) => agent.capabilities.includes(capability))
      ? { config, agent }
      : null;
  });

  const canAttachExport = (workflow: Workflow, binding: StepCalculator, actorId: string) =>
    getExportProgram(workflow, binding).pipe(
      Effect.map((program) => program !== null && canUse(program.agent, actorId)),
    );

  const options = (
    workflow: Workflow,
    actorId: string,
  ): Effect.Effect<ReadonlyArray<CalculatorOption>> =>
    automations.list.pipe(
      Effect.flatMap((list) =>
        Effect.forEach(list, (automation) =>
          getProgram(automation, workflow).pipe(
            Effect.map((program) =>
              program === null || !canUse(program.agent, actorId)
                ? []
                : [
                    {
                      id: automation.id,
                      title: automation.title,
                      inputs: program.calculator.inputs,
                      outputs: program.calculator.outputs,
                      ...(program.calculator.review === true ? { review: true as const } : {}),
                      ...(program.calculator.export === undefined
                        ? {}
                        : { hasExport: true as const }),
                    },
                  ],
            ),
          ),
        ),
      ),
      Effect.map((list) => list.flat()),
    );

  const canReadRecordInputs = Effect.fnUntraced(function* (
    actorId: string,
    steps: ReadonlyArray<StepDefinition>,
    binding: StepCalculator,
  ) {
    for (const input of Object.values(binding.inputs)) {
      if (input.records === undefined) continue;
      const field = getInputField(steps, input);
      if (field?.type !== "records" || (input.records.includeProposals && !field.isReviewed))
        return false;
      const collection = yield* collectionAccess
        .requireReadable(actorId, field.collectionId)
        .pipe(Effect.catchTags({ NotFound: () => Effect.succeed(null) }));
      if (
        collection === null ||
        !input.records.fields.every((id) => collection.fields.some((field) => field.id === id))
      )
        return false;
    }
    return true;
  });

  const validate = Effect.fnUntraced(function* (
    steps: ReadonlyArray<StepDefinition>,
    workflow: Workflow,
  ) {
    for (const { step, parentId } of stepNodes(steps)) {
      const binding = step.calculator;
      if (binding === undefined) continue;
      if (
        binding.exportTemplateId !== undefined &&
        (yield* getExportProgram(workflow, binding)) === null
      )
        return false;
      if (binding.kind !== "script") continue;
      const source = steps[steps.findIndex(({ id }) => id === step.id) - 1];
      if (parentId !== null || source?.id !== binding.sourceStepId) return false;
      const automation = yield* automations.get(AutomationId.make(binding.id));
      const program = automation === null ? null : yield* getProgram(automation, workflow);
      if (program === null) return false;
      const { inputs, outputs } = program.calculator;
      if (
        program.calculator.review !== binding.review ||
        (binding.review && Object.hasOwn(binding.inputs, "$review")) ||
        !(yield* canReadRecordInputs(workflow.creatorUserId, steps, binding)) ||
        Object.keys(binding.inputs).length !== inputs.length ||
        !inputs.every(
          (name) =>
            Object.hasOwn(binding.inputs, name) &&
            step.inputs.some(isSameInput(binding.inputs[name]!)),
        ) ||
        Object.keys(binding.outputs).length !== outputs.length ||
        new Set(Object.values(binding.outputs)).size !== outputs.length ||
        (!binding.review &&
          binding.previewColumns?.some(({ id }) => !Object.values(binding.outputs).includes(id))) ||
        !outputs.every((name) =>
          step.fields.some(
            (field) => field.id === binding.outputs[name] && isScriptOutputField(field),
          ),
        )
      )
        return false;
    }
    return true;
  });

  const readRecordInput = Effect.fnUntraced(function* (
    collectionId: string,
    fieldId: string,
    source: Step | undefined,
    selection: NonNullable<CalculatorInput["records"]>,
    interests: Map<string, Set<string>>,
  ) {
    const linked = recordKeys(source?.values[fieldId]);
    const pending = new Map(
      (selection.includeProposals ? (source?.proposals ?? []) : []).flatMap((proposal) =>
        proposal.fieldKey === fieldId && !proposal.isDiscarded && typeof proposal.value === "string"
          ? [[proposal.value, proposal] as const]
          : [],
      ),
    );
    const associations = source?.recordAssociations?.[fieldId] ?? {};
    const keys = [...new Set([...linked, ...pending.keys()])];
    const linkedKeys = new Set(linked);
    interests.set(collectionId, new Set([...(interests.get(collectionId) ?? []), ...keys]));
    const byKey = new Map(
      (yield* records.listByKeys(collectionId, keys)).map((record) => [record.key, record]),
    );
    const fields = new Set(selection.fields);
    const filters = source?.proposalFilters?.filter(({ fieldKey }) => fieldKey === fieldId) ?? [];
    return keys.flatMap((key) => {
      const record = byKey.get(key);
      if (record === undefined) return [];
      const proposal = linkedKeys.has(key) ? undefined : pending.get(key);
      return [
        {
          key,
          values: Object.fromEntries(
            Object.entries(record.values).filter(([path]) => fields.has(path.split(".", 1)[0]!)),
          ),
          status: proposal === undefined ? "linked" : "proposed",
          sourceRecordKeys:
            proposal === undefined
              ? Object.hasOwn(associations, key)
                ? associations[key]!
                : []
              : getProposalSourceKeys(proposal),
          ...(proposal === undefined
            ? {}
            : {
                proposalId: proposal.id,
                proposalFilters: filters.flatMap(({ driftSummary, items }) => {
                  const item = items.find(({ proposalId }) => proposalId === proposal.id);
                  return item === undefined ? [] : [{ summary: driftSummary, reason: item.reason }];
                }),
              }),
        },
      ];
    });
  });

  const readRequest = Effect.fnUntraced(function* (ticket: Ticket, destination: StepDefinition) {
    const binding = destination.calculator;
    if (binding?.kind !== "script") return null;
    const version = yield* workflows.versions.get(ticket.workflowVersionId);
    if (version === null) return null;
    const workflow = yield* workflows.get(version.workflowId);
    const automation = yield* automations.get(AutomationId.make(binding.id));
    if (workflow === null || automation === null) return null;
    const program = yield* getProgram(automation, workflow);
    if (program === null) return null;
    const { entrypoint, inputs, outputs, review } = program.calculator;
    if (
      review !== binding.review ||
      inputs.length !== Object.keys(binding.inputs).length ||
      !inputs.every((name) => Object.hasOwn(binding.inputs, name)) ||
      outputs.length !== Object.keys(binding.outputs).length ||
      !outputs.every((name) => Object.hasOwn(binding.outputs, name))
    )
      return null;
    if (!(yield* canReadRecordInputs(workflow.creatorUserId, version.steps, binding))) return null;
    const interests = new Map<string, Set<string>>();
    const sources = yield* Effect.forEach(
      Object.entries(binding.inputs),
      Effect.fnUntraced(function* ([name, input]) {
        const source = ticket.steps.find(
          ({ stepDefinitionId }) => stepDefinitionId === input.stepId,
        );
        const field = getInputField(version.steps, input);
        if (field?.type === "records" && input.records !== undefined) {
          const rows = yield* readRecordInput(
            field.collectionId,
            field.id,
            source,
            input.records,
            interests,
          );
          return {
            name,
            label: field.label,
            value: rows,
            historyValue: rows.map(({ key, status }) => ({ key, status })),
          };
        }
        const value = source?.values[input.fieldId] ?? null;
        return { name, label: field?.label ?? name, value, historyValue: value };
      }),
    );
    const active = currentStep(ticket);
    const isPreview = active?.stepDefinitionId !== destination.id;
    const request: ScriptRequest = {
      entrypoint,
      files: program.agent.files,
      inputs: {
        ...Object.fromEntries(sources.map(({ name, value }) => [name, value])),
        ...(review
          ? {
              $review: {
                isPreview,
                edits: { rows: isPreview ? {} : (active?.calculation?.rows ?? {}) },
                labels: binding.labels ?? {},
              },
            }
          : {}),
      },
    };
    const groupFields = getScriptOutputFields(binding, destination.fields).flatMap((field) =>
      field.type === "group"
        ? [{ id: field.id, columns: field.fields.map(({ id, type }) => ({ id, type })) }]
        : [],
    );
    const revision = NodeCrypto.createHash("sha256")
      .update(
        encodeJson(
          groupFields.length === 0
            ? [request, binding.outputs]
            : [request, binding.outputs, groupFields],
        ),
      )
      .digest("base64url");
    return { request, revision, sources, binding, interests, isPreview };
  });

  const latest = (ticketId: string, destinationId: string) =>
    tickets.resultHistory
      .list(ticketId, destinationId, SCRIPT_RESULT_KEY, 1)
      .pipe(Effect.map(([entry]) => entry));

  const read = Effect.fnUntraced(function* (ticket: Ticket, destination: StepDefinition) {
    const request = yield* readRequest(ticket, destination);
    if (request === null) return null;
    const result = yield* latest(ticket.id, destination.id);
    return result?.snapshot.inputRevision === request.revision ? result : null;
  });
  const readValues = (ticket: Ticket, destination: StepDefinition) =>
    read(ticket, destination).pipe(
      Effect.map((result) => (result === null ? null : readScriptResultValues(result.snapshot))),
    );

  const readExport = Effect.fnUntraced(function* (
    ticket: Ticket,
    destination: StepDefinition,
    step: Step,
  ) {
    const binding = destination.calculator;
    const templateId = binding?.exportTemplateId;
    if (binding === undefined || templateId === undefined) return null;
    const version = yield* workflows.versions.get(ticket.workflowVersionId);
    const workflow = version === null ? null : yield* workflows.get(version.workflowId);
    if (workflow === null) return null;
    const program = yield* getExportProgram(workflow, binding);
    if (program === null) return null;
    const input = yield* readRequest(ticket, destination);
    const result = input === null ? undefined : yield* latest(ticket.id, destination.id);
    if (input === null || result?.snapshot.inputRevision !== input.revision) return null;
    const template = yield* files.getForWorkflow(templateId, workflow.id);
    if (template === null) return null;
    const { config, agent } = program;
    const bundles = [];
    for (const id of config.capabilities ?? []) {
      const capability = yield* capabilities.get(id);
      if (capability?.files === undefined) return null;
      bundles.push(capability.files);
    }
    const request: Omit<ScriptFileRequest, "template"> = {
      entrypoint: config.entrypoint,
      files: agent.files,
      capabilityFiles: bundles,
      inputs: {
        title: ticket.title,
        inputs: input.request.inputs,
        results: readScriptResultValues(result.snapshot),
        ...(result.snapshot.data === undefined ? {} : { data: result.snapshot.data }),
        fields: step.values,
      },
    };
    const revision = NodeCrypto.createHash("sha256")
      .update(encodeJson([request, templateId]))
      .digest("base64url");
    return { config, templateId, request, revision };
  });

  const exportFile = Effect.fnUntraced(function* (
    input: NonNullable<Effect.Success<ReturnType<typeof readExport>>>,
  ) {
    const file = yield* files.read(input.templateId);
    if (file === null || file.sizeBytes === 0 || file.sizeBytes > ATTACHMENT_MAX_FILE_BYTES)
      return yield* new ExecutionFailed({ reason: "The export template is unavailable." });
    const template = yield* Stream.mkUint8Array(file.stream);
    return yield* runner.runScriptForFile({ ...input.request, template });
  });

  const exportView = Effect.fnUntraced(function* (workflow: Workflow, destination: StepDefinition) {
    const binding = destination.calculator;
    if (binding?.exportTemplateId === undefined) return undefined;
    const config = (yield* getExportProgram(workflow, binding))?.config;
    return config === undefined
      ? undefined
      : config.label === undefined
        ? {}
        : { label: config.label };
  });

  const calculate = Effect.fnUntraced(function* (ticket: Ticket, destination: StepDefinition) {
    const binding = destination.calculator;
    if (binding?.kind !== "script") return;
    const input = yield* tickets.transaction(
      Effect.gen(function* () {
        const fresh = yield* tickets.get(ticket.id);
        if (fresh?.status.type !== "open") return null;
        const active = currentStep(fresh);
        if (
          active === null ||
          ![destination.id, binding.sourceStepId].includes(active.stepDefinitionId)
        )
          return null;
        const prepared = yield* readRequest(fresh, destination);
        if (hasRecordInputs(binding))
          yield* tickets.resultHistory.setInputs(
            fresh.id,
            prepared?.interests ?? new Map(),
            destination.id,
          );
        return prepared;
      }),
    );
    if (input === null) return;
    const previous = yield* latest(ticket.id, destination.id);
    if (previous?.snapshot.inputRevision === input.revision) return;
    const output = yield* runner.runScript(input.request);
    const report = input.binding.review ? readScriptedReview(output) : null;
    if (input.binding.review && (input.isPreview ? report?.preview : report?.review) === undefined)
      return yield* new ExecutionFailed({
        reason: "The calculation must return its configured review or preview.",
      });
    const result = buildScriptResult(input.binding, destination.fields, report?.outputs ?? output);
    if (typeof result === "string") return yield* new ExecutionFailed({ reason: result });
    yield* tickets.transaction(
      Effect.gen(function* () {
        const fresh = yield* tickets.get(ticket.id);
        if (fresh?.status.type !== "open") return;
        const active = currentStep(fresh);
        if (
          active === null ||
          ![destination.id, binding.sourceStepId].includes(active.stepDefinitionId)
        )
          return;
        const current = yield* readRequest(fresh, destination);
        if (current?.revision !== input.revision) return;
        const snapshot = {
          ...result,
          ...(report?.review === undefined ? {} : { review: report.review }),
          ...(report?.preview === undefined ? {} : { preview: report.preview }),
          ...(report?.data === undefined ? {} : { data: report.data }),
          inputRevision: input.revision,
          sources: input.sources.map(({ name, label, historyValue: value }) => ({
            id: name,
            title: label,
            values:
              typeof value === "number"
                ? [{ id: name, type: "number" as const, value }]
                : [{ id: name, type: "text" as const, value: encodeJson(value) }],
          })),
        };
        yield* tickets.resultHistory.append(fresh.id, destination.id, [
          { key: SCRIPT_RESULT_KEY, snapshot },
          ...(input.isPreview
            ? (report?.preview?.rows ?? []).map(({ key, history }) => ({ key, snapshot: history }))
            : []),
        ]);
        if (active.stepDefinitionId === destination.id)
          yield* tickets.update(
            putTicketStep(fresh, {
              ...active,
              values: applyScriptResultValues(active.values, readScriptResultValues(snapshot)),
            }),
          );
        else yield* tickets.publishChange(fresh.id);
      }),
    );
  });

  const refresh = Effect.fnUntraced(function* (ticketId: string) {
    const ticket = yield* tickets.get(ticketId);
    if (ticket === null) return;
    const version = yield* workflows.versions.get(ticket.workflowVersionId);
    if (version === null) return;
    const activeId =
      ticket.status.type === "open" ? currentStep(ticket)?.stepDefinitionId : undefined;
    for (const destination of version.steps) {
      if (destination.calculator?.kind !== "script") continue;
      if (destination.id === activeId || destination.calculator.sourceStepId === activeId)
        yield* calculate(ticket, destination);
      else if (hasRecordInputs(destination.calculator))
        yield* tickets.transaction(
          tickets.resultHistory.setInputs(ticketId, new Map(), destination.id),
        );
    }
  });

  const jobs = new Map<string, { pending: boolean }>();
  const scheduleTicket = (ticketId: string) =>
    sql.afterCommit(
      Effect.gen(function* () {
        const running = jobs.get(ticketId);
        if (running !== undefined) {
          running.pending = true;
          return;
        }
        const job = { pending: true };
        jobs.set(ticketId, job);
        yield* Effect.forkIn(
          Effect.gen(function* () {
            while (job.pending) {
              job.pending = false;
              yield* refresh(ticketId).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Calculation failed", { ticketId, error }),
                ),
              );
            }
            jobs.delete(ticketId);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (jobs.get(ticketId) === job) jobs.delete(ticketId);
              }),
            ),
          ),
          scope,
        );
      }),
    );
  const schedule = (ticketId: string, steps: ReadonlyArray<StepDefinition>) =>
    steps.some(({ calculator }) => calculator?.kind === "script")
      ? scheduleTicket(ticketId)
      : Effect.void;

  const changes = yield* Queue.unbounded<readonly [collectionId: string, key: string]>();
  yield* records.observeChanges((collectionId, key) => {
    Queue.offerUnsafe(changes, [collectionId, key]);
  });
  yield* Queue.takeBetween(changes, 1, 128).pipe(
    Effect.flatMap(tickets.resultHistory.calculationsForRecords),
    Effect.flatMap((matching) =>
      Effect.forEach(matching, ({ id }) => scheduleTicket(id), { discard: true }),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

  const readPreview = Effect.fnUntraced(function* (ticket: Ticket, destination: StepDefinition) {
    const binding = destination.calculator;
    if (!binding?.review) return null;
    const result = yield* read(ticket, destination);
    const preview = result?.snapshot.preview;
    if (preview === undefined) {
      yield* scheduleTicket(ticket.id);
      return null;
    }
    const version = yield* workflows.versions.get(ticket.workflowVersionId);
    if (version === null) return null;
    const images = yield* Effect.forEach(
      Object.entries(binding.inputs),
      Effect.fnUntraced(function* ([name, input]) {
        const keys = preview.rows
          .filter(({ thumbnailInput }) => thumbnailInput === name)
          .map(({ key }) => key);
        const field = getInputField(version.steps, input);
        if (input.records === undefined || field?.type !== "records" || keys.length === 0)
          return [];
        const source = ticket.steps.find(
          ({ stepDefinitionId }) => stepDefinitionId === input.stepId,
        );
        const linked = new Set(recordKeys(source?.values[input.fieldId]));
        const collection = yield* collections.get(field.collectionId);
        const image = collection === null ? undefined : resolveRecordDisplay(collection).image;
        if (!image) return [];
        const rows = yield* records.listByKeys(
          field.collectionId,
          keys.filter((key) => linked.has(key)),
        );
        const ids = rows.map(({ key, values }) => ({
          key,
          ids: listFieldFiles(image, values).filter(isAttachmentId),
        }));
        const held = new Map(
          (yield* files.forIds([...new Set(ids.flatMap(({ ids }) => ids))]))
            .filter(
              ({ id, collectionId }) =>
                collectionId === field.collectionId && attachmentIsInlineImage(id),
            )
            .map(({ id, name }) => [id, { id, name }]),
        );
        return ids.flatMap(({ key, ids }) => {
          const image = ids.map((id) => held.get(id)).find((value) => value !== undefined);
          return image === undefined ? [] : [[JSON.stringify([name, key]), image] as const];
        });
      }),
    );
    const thumbnails = new Map(images.flat());
    const history = yield* tickets.resultHistory.latestIds(ticket.id, destination.id);
    return {
      columns: binding.previewColumns ?? preview.columns,
      rows: preview.rows.map(({ key, label, cells, thumbnailInput }) => {
        const thumbnail = thumbnails.get(JSON.stringify([thumbnailInput, key]));
        return {
          key,
          label,
          cells,
          ...(thumbnail === undefined ? {} : { thumbnail }),
          ...(history[key] === undefined ? {} : { historyId: history[key] }),
        };
      }),
    };
  });

  const readReview = Effect.fnUntraced(function* (
    ticket: Ticket,
    destination: StepDefinition,
    step: Step,
  ) {
    const current = yield* read(ticket, destination);
    const result = current ?? (yield* latest(ticket.id, destination.id));
    if (current === null) yield* scheduleTicket(ticket.id);
    const review = result?.snapshot.review;
    const revision = result?.snapshot.inputRevision;
    return review === undefined || revision === undefined
      ? null
      : {
          ...review,
          revision,
          isPending: current === null,
          isApproved:
            current !== null &&
            review.canApprove &&
            step.calculation?.approvedRevision === revision,
        };
  });

  const readPreviewChanges = Effect.fnUntraced(function* (
    ticket: Ticket,
    destination: StepDefinition,
  ) {
    const result = yield* read(ticket, destination);
    if (result === null) yield* scheduleTicket(ticket.id);
    return result?.snapshot.preview?.changes;
  });

  return {
    options,
    validate,
    canReadRecordInputs,
    canAttachExport,
    read,
    readValues,
    readPreview,
    readReview,
    readPreviewChanges,
    readExport,
    exportFile,
    exportView,
    schedule,
  };
});
