// @effect-diagnostics nodeBuiltinImport:off - Hashes the input and program behind each result.
import * as NodeCrypto from "node:crypto";
import { canUse } from "@t45/contracts/models/Agent";
import { type Automation, AutomationId } from "@t45/contracts/models/Automation";
import { type FieldValues } from "@t45/contracts/models/Field";
import { readScriptCalculator } from "@t45/contracts/models/StepCalculator";
import type { StepResultValue } from "@t45/contracts/models/StepResultHistory";
import {
  currentStep,
  findStep,
  isSameInput,
  putTicketStep,
  stepNodes,
  type StepDefinition,
  type Ticket,
  type Workflow,
} from "@t45/contracts/models/Workflow";
import type { CalculatorOption } from "@t45/contracts/resources/Workflows";
import { ExecutionFailed, type ScriptRequest } from "@t45/contracts/resources/Runner";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { AgentRepository } from "../agents/AgentRepository.ts";
import { AutomationRepository } from "../automations/AutomationRepository.ts";
import { RunnerService } from "../runner/RunnerService.ts";
import { TicketRepository } from "./TicketRepository.ts";
import { WorkflowRepository } from "./WorkflowRepository.ts";

export const SCRIPT_RESULT_KEY = "$calculation";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

export const makeScriptCalculations = Effect.gen(function* () {
  const agents = yield* AgentRepository;
  const automations = yield* AutomationRepository;
  const runner = yield* RunnerService;
  const sql = yield* SqlClient.SqlClient;
  const tickets = yield* TicketRepository;
  const workflows = yield* WorkflowRepository;
  const scope = yield* Effect.scope;

  const getProgram = Effect.fnUntraced(function* (automation: Automation, workflow: Workflow) {
    const agent = yield* agents.get(automation.agentId);
    if (agent?.status !== "active" || !canUse(agent, workflow.creatorUserId)) return null;
    const calculator = readScriptCalculator(agent.files);
    return calculator === null ? null : { calculator, agent };
  });

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
                    },
                  ],
            ),
          ),
        ),
      ),
      Effect.map((list) => list.flat()),
    );

  const validate = Effect.fnUntraced(function* (
    steps: ReadonlyArray<StepDefinition>,
    workflow: Workflow,
  ) {
    for (const { step, parentId } of stepNodes(steps)) {
      const binding = step.calculator;
      if (binding === undefined) continue;
      if (binding.kind !== "script") return false;
      const source = steps[steps.findIndex(({ id }) => id === step.id) - 1];
      if (parentId !== null || source?.id !== binding.sourceStepId) return false;
      const automation = yield* automations.get(AutomationId.make(binding.id));
      const program = automation === null ? null : yield* getProgram(automation, workflow);
      if (program === null) return false;
      const { inputs, outputs } = program.calculator;
      if (
        Object.keys(binding.inputs).length !== inputs.length ||
        !inputs.every(
          (name) =>
            Object.hasOwn(binding.inputs, name) &&
            step.inputs.some(isSameInput(binding.inputs[name]!)),
        ) ||
        Object.keys(binding.outputs).length !== outputs.length ||
        new Set(Object.values(binding.outputs)).size !== outputs.length ||
        binding.previewColumns?.some(({ id }) => !Object.values(binding.outputs).includes(id)) ||
        !outputs.every((name) =>
          step.fields.some(
            (field) => field.id === binding.outputs[name] && field.type === "number",
          ),
        )
      )
        return false;
    }
    return true;
  });

  const readRequest = Effect.fnUntraced(function* (ticket: Ticket, destination: StepDefinition) {
    const binding = destination.calculator;
    if (binding?.kind !== "script") return null;
    const version = yield* workflows.versions.get(ticket.workflowVersionId);
    if (version === null) return null;
    const workflow = yield* workflows.get(version.workflowId);
    const automation = yield* automations.get(AutomationId.make(binding.id));
    const program =
      workflow === null || automation === null ? null : yield* getProgram(automation, workflow);
    if (program === null) return null;
    const { entrypoint, inputs, outputs } = program.calculator;
    if (
      inputs.length !== Object.keys(binding.inputs).length ||
      !inputs.every((name) => Object.hasOwn(binding.inputs, name)) ||
      outputs.length !== Object.keys(binding.outputs).length ||
      !outputs.every((name) => Object.hasOwn(binding.outputs, name))
    )
      return null;
    const sources = Object.entries(binding.inputs).map(([name, input]) => {
      const source = ticket.steps.find(({ stepDefinitionId }) => stepDefinitionId === input.stepId);
      const field = findStep(version.steps, input.stepId)?.step.fields.find(
        ({ id }) => id === input.fieldId,
      );
      return { name, label: field?.label ?? name, value: source?.values[input.fieldId] ?? null };
    });
    const request: ScriptRequest = {
      entrypoint,
      files: program.agent.files,
      inputs: Object.fromEntries(sources.map(({ name, value }) => [name, value])),
    };
    const revision = NodeCrypto.createHash("sha256")
      .update(encodeJson([request, binding.outputs]))
      .digest("base64url");
    return { request, revision, sources, outputs: binding.outputs };
  });

  const latest = (ticketId: string, destinationId: string) =>
    tickets.resultHistory
      .list(ticketId, destinationId, SCRIPT_RESULT_KEY, 1)
      .pipe(Effect.map(([entry]) => entry));

  const valuesOf = (results: ReadonlyArray<StepResultValue>): FieldValues =>
    Object.fromEntries(results.map(({ id, value }) => [id, value]));

  const read = Effect.fnUntraced(function* (ticket: Ticket, destination: StepDefinition) {
    const request = yield* readRequest(ticket, destination);
    if (request === null) return null;
    const result = yield* latest(ticket.id, destination.id);
    return result?.snapshot.inputRevision === request.revision ? result : null;
  });
  const readValues = (ticket: Ticket, destination: StepDefinition) =>
    read(ticket, destination).pipe(
      Effect.map((result) => (result === null ? null : valuesOf(result.snapshot.results))),
    );

  const calculate = Effect.fnUntraced(function* (ticket: Ticket, destination: StepDefinition) {
    const input = yield* readRequest(ticket, destination);
    if (input === null) return;
    const previous = yield* latest(ticket.id, destination.id);
    if (previous?.snapshot.inputRevision === input.revision) return;
    const outputs = yield* runner.runScript(input.request);
    const mappings = Object.entries(input.outputs);
    if (
      Object.keys(outputs).length !== mappings.length ||
      !mappings.every(([name]) => Object.hasOwn(outputs, name))
    )
      return yield* new ExecutionFailed({
        reason: "The calculation must return every configured output.",
      });
    const results = mappings.map(([name, id]) => ({
      type: "number" as const,
      id,
      value: outputs[name]!,
    }));
    yield* tickets.transaction(
      Effect.gen(function* () {
        const fresh = yield* tickets.get(ticket.id);
        if (fresh?.status.type !== "open") return;
        const active = currentStep(fresh);
        if (
          active === null ||
          ![destination.id, destination.calculator?.sourceStepId].includes(active.stepDefinitionId)
        )
          return;
        const current = yield* readRequest(fresh, destination);
        if (current?.revision !== input.revision) return;
        yield* tickets.resultHistory.append(fresh.id, destination.id, [
          {
            key: SCRIPT_RESULT_KEY,
            snapshot: {
              inputRevision: input.revision,
              results,
              sources: input.sources.map(({ name, label, value }) => ({
                id: name,
                title: label,
                values:
                  typeof value === "number"
                    ? [{ id: name, type: "number", value }]
                    : [{ id: name, type: "text", value: encodeJson(value) }],
              })),
            },
          },
        ]);
        if (active.stepDefinitionId === destination.id)
          yield* tickets.update(
            putTicketStep(fresh, { ...active, values: { ...active.values, ...valuesOf(results) } }),
          );
        else yield* tickets.publishChange(fresh.id);
      }),
    );
  });

  const refresh = Effect.fnUntraced(function* (ticketId: string) {
    const ticket = yield* tickets.get(ticketId);
    if (ticket?.status.type !== "open") return;
    const version = yield* workflows.versions.get(ticket.workflowVersionId);
    if (version === null) return;
    const activeId = currentStep(ticket)?.stepDefinitionId;
    for (const destination of version.steps) {
      if (
        destination.calculator?.kind !== "script" ||
        (destination.id !== activeId && destination.calculator.sourceStepId !== activeId)
      )
        continue;
      const fresh = yield* tickets.get(ticketId);
      if (fresh?.status.type === "open") yield* calculate(fresh, destination);
    }
  });

  const jobs = new Map<string, { pending: boolean }>();
  const schedule = (ticketId: string, steps: ReadonlyArray<StepDefinition>) =>
    steps.some(({ calculator }) => calculator?.kind === "script")
      ? sql.afterCommit(
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
        )
      : Effect.void;

  return { options, validate, read, readValues, schedule };
});
