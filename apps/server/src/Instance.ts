import * as Layer from "effect/Layer";

import * as AppRpc from "./AppRpc.ts";
import * as BuiltIns from "./BuiltIns.ts";
import * as AgentRepository from "./agents/AgentRepository.ts";
import * as SkillRepository from "./agents/SkillRepository.ts";
import * as AttachmentRepository from "./attachments/AttachmentRepository.ts";
import * as AttachmentsHttp from "./attachments/http.ts";
import * as Authentication from "./auth/Authentication.ts";
import * as AuthHttp from "./auth/http.ts";
import * as AutomationRepository from "./automations/AutomationRepository.ts";
import * as CapabilityRepository from "./capabilities/CapabilityRepository.ts";
import * as ChatRepository from "./chats/ChatRepository.ts";
import { ChatService } from "./chats/ChatService.ts";
import * as CollectionRecordRepository from "./collections/CollectionRecordRepository.ts";
import * as CollectionRepository from "./collections/CollectionRepository.ts";
import * as CollectionService from "./collections/CollectionService.ts";
import * as HttpServer from "./http.ts";
import * as OrgHttp from "./org/http.ts";
import * as OrganizationRepository from "./org/OrganizationRepository.ts";
import * as UserRepository from "./org/UserRepository.ts";
import { UserService } from "./org/UserService.ts";
import * as CommandLogRepository from "./persistence/CommandLogRepository.ts";
import { RunnerService } from "./runner/RunnerService.ts";
import * as NotificationRepository from "./workflows/NotificationRepository.ts";
import * as TicketRepository from "./workflows/TicketRepository.ts";
import * as WorkflowRepository from "./workflows/WorkflowRepository.ts";
import * as ProjectRepository from "./workflows/ProjectRepository.ts";
import * as WorkflowService from "./workflows/WorkflowService.ts";

const Store = BuiltIns.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      UserRepository.layer,
      ChatRepository.layer,
      AttachmentRepository.layer,
      AgentRepository.layer,
      SkillRepository.layer,
      CapabilityRepository.layer,
    ),
  ),
);

const WorkflowRepositories = Layer.mergeAll(
  WorkflowRepository.layer,
  ProjectRepository.layer,
  TicketRepository.layer,
  NotificationRepository.layer,
  CommandLogRepository.layer,
);

const ChatServices = ChatService.layer.pipe(
  Layer.provideMerge(RunnerService.layer),
  Layer.provideMerge(WorkflowRepositories),
  Layer.provideMerge(Store),
);

const Org = OrganizationRepository.layer.pipe(Layer.provideMerge(ChatServices));

const Collections = CollectionService.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(CollectionRepository.layer, CollectionRecordRepository.layer)),
);

/**
 * The services one T45 instance owns: session state, execution state and background jobs, on the
 * database (`SqlClient`) and files its platform provides. Each instance builds its own.
 */
export const Dependencies = Layer.effect(UserService, UserService.make).pipe(
  Layer.provide(Authentication.layer),
  Layer.provideMerge(WorkflowService.layer),
  Layer.provideMerge(Collections),
  Layer.provideMerge(AutomationRepository.layer),
  Layer.provideMerge(Org),
);

/** The API every platform serves for an instance, behind the same-origin guard. */
export const ApiRoutes = Layer.mergeAll(
  AuthHttp.layer,
  OrgHttp.layer,
  AttachmentsHttp.layer,
  AppRpc.layer,
  HttpServer.sameOrigin,
);
