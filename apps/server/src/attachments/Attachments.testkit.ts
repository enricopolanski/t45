import * as UserRepository from "../org/UserRepository.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WorkflowVersion } from "@t45/contracts/models/Workflow";
import { generateId } from "@t45/contracts/models/primitives";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ChatRepository from "../chats/ChatRepository.ts";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as TicketRepository from "../workflows/TicketRepository.ts";
import * as WorkflowRepository from "../workflows/WorkflowRepository.ts";
import * as ProjectRepository from "../workflows/ProjectRepository.ts";
import * as AttachmentRepository from "./AttachmentRepository.ts";

export const layer = Layer.mergeAll(
  UserRepository.layer,
  AttachmentRepository.layer,
  ChatRepository.layer,
  WorkflowRepository.layer,
  ProjectRepository.layer,
  TicketRepository.layer,
).pipe(
  Layer.provideMerge(Sqlite.testLayer),
  Layer.provideMerge(ServerConfig.testLayer("t3-attachments-")),
  Layer.provideMerge(NodeServices.layer),
);

const at = DateTime.makeUnsafe("2026-10-23T09:00:00.000Z");
const steps = Schema.decodeUnknownSync(WorkflowVersion.fields.steps)([
  { id: "collect", name: "Collect", instructions: "", fields: [], subSteps: [] },
]);

/** A ticket in the step "collect", with `assignee` as that step's member and assignee. */
export const seedStep = (ticketId: string, assignee: string) =>
  Effect.gen(function* () {
    const workflowId = `workflow-${ticketId}`;
    const workflowVersionId = `version-${ticketId}`;
    const projectId = `project-${ticketId}`;
    const stepId = generateId();
    const workflows = yield* WorkflowRepository.WorkflowRepository;
    yield* workflows.save({
      id: workflowId,
      name: "Taxes",
      creatorUserId: assignee,
      editorUserIds: [],
      isArchived: false,
    });
    yield* workflows.versions.save({
      id: workflowVersionId,
      workflowId,
      number: 1,
      revision: 0,
      isFrozen: true,
      steps,
    });
    const projects = yield* ProjectRepository.ProjectRepository;
    yield* projects.insert({
      id: projectId,
      workflowId,
      workflowVersionId,
      name: "Taxes",
      adminUserIds: [assignee],
      defaultAssignees: {},
      slug: null,
      isArchived: false,
    });
    yield* projects.members.add({ projectId, stepId: "collect", userId: assignee });
    yield* (yield* TicketRepository.TicketRepository).insert({
      id: ticketId,
      projectId,
      workflowVersionId,
      title: "Return",
      description: "",
      status: { type: "open" },
      steps: [
        {
          id: stepId,
          stepDefinitionId: "collect",
          parentStepId: null,
          status: { type: "working", at },
          assignee,
          values: {},
        },
      ],
      createdAt: at,
    });
    return { stepId };
  });
