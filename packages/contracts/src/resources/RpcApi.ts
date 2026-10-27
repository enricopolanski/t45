import { Agents } from "./Agents.ts";
import { Assignments } from "./Assignments.ts";
import { Authorization } from "../Authorization.ts";
import { Chats } from "./Chats.ts";
import { Notifications } from "./Notifications.ts";
import { Organization } from "./Organization.ts";
import { Runner } from "./Runner.ts";
import { Automations } from "./Automations.ts";
import { Skills } from "./Skills.ts";
import { Users } from "./Users.ts";
import { Workflows } from "./Workflows.ts";

export const RpcApi = Skills.merge(
  Agents,
  Users,
  Organization,
  Chats,
  Automations,
  Runner,
  Workflows,
  Assignments,
  Notifications,
).middleware(Authorization);
