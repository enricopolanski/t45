import * as UserRepository from "../org/UserRepository.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { generateId } from "@t45/contracts/models/primitives";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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

export const seedStep = (ticketId: string, assignee: string) =>
  Effect.gen(function* () {
    const workflowId = `workflow-${ticketId}`;
    const projectId = `project-${ticketId}`;
    const stepId = generateId();
    yield* (yield* WorkflowRepository.WorkflowRepository).insert({
      id: workflowId,
      name: "Taxes",
      steps: [],
      isArchived: false,
    });
    yield* (yield* ProjectRepository.ProjectRepository).insert({
      id: projectId,
      workflowId,
      name: "Taxes",
      responsible: assignee,
      adminUserIds: [assignee],
      defaultAssignments: {},
      slug: null,
      isPublic: false,
      isArchived: false,
    });
    yield* (yield* TicketRepository.TicketRepository).insert({
      id: ticketId,
      projectId,
      title: "Return",
      description: "",
      dueDate: null,
      status: { type: "open" },
      steps: [
        {
          id: stepId,
          stepDefinitionId: "collect",
          parentStepId: null,
          status: { type: "working", at },
          assignee,
          values: {},
          automationIds: [],
        },
      ],
      createdAt: at,
    });
    return { stepId };
  });
