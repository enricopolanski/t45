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
import * as WorkflowDefinitionRepository from "../workflows/WorkflowDefinitionRepository.ts";
import * as WorkflowRepository from "../workflows/WorkflowRepository.ts";
import * as AttachmentRepository from "./AttachmentRepository.ts";

export const layer = Layer.mergeAll(
  UserRepository.layer,
  AttachmentRepository.layer,
  ChatRepository.layer,
  WorkflowDefinitionRepository.layer,
  WorkflowRepository.layer,
  TicketRepository.layer,
).pipe(
  Layer.provideMerge(Sqlite.layerTest),
  Layer.provideMerge(ServerConfig.layerTest({ prefix: "t3-attachments-" })),
  Layer.provideMerge(NodeServices.layer),
);

const at = DateTime.makeUnsafe("2026-10-23T09:00:00.000Z");

export const seedStep = (ticketId: string, assignee: string) =>
  Effect.gen(function* () {
    const definitionId = `definition-${ticketId}`;
    const workflowId = `workflow-${ticketId}`;
    const stepId = generateId();
    yield* (yield* WorkflowDefinitionRepository.WorkflowDefinitionRepository).insert({
      id: definitionId,
      name: "Taxes",
      steps: [],
      isArchived: false,
    });
    yield* (yield* WorkflowRepository.WorkflowRepository).insert({
      id: workflowId,
      definitionId,
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
      workflowId,
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
          responsible: assignee,
          values: {},
          automations: [],
        },
      ],
      createdAt: at,
    });
    return { stepId };
  });
