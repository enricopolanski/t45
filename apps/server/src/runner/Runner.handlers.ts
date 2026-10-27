import { ChatId, titleOf } from "@t45/contracts/models/Chat";
import { Authorization, CurrentUser } from "@t45/contracts/Authorization";
import { Runner, type RunnerStatus } from "@t45/contracts/resources/Runner";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AgentRepository } from "../agents/AgentRepository.ts";
import { ChatService } from "../chats/ChatService.ts";
import { RunnerService } from "./RunnerService.ts";

const isChatId = Schema.is(ChatId);

export const layer = Runner.middleware(Authorization).toLayer(
  Effect.gen(function* () {
    const runner = yield* RunnerService;
    const chats = yield* ChatService;
    const agents = yield* AgentRepository;

    return Runner.of({
      "runner.get": () =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          const inventory = yield* runner.inventory;
          const agentNames = new Map((yield* agents.list).map((agent) => [agent.id, agent.name]));
          const chatOf = Effect.fnUntraced(function* (vmId: string) {
            if (!isChatId(vmId)) return null;
            const chat = yield* chats.access(currentUser, vmId);
            if (chat === null) return null;
            return {
              id: chat.id,
              title: titleOf(chat),
              agentName: agentNames.get(chat.agentId) ?? null,
            };
          });
          const vms = yield* Effect.forEach(inventory.vms, (vm) =>
            chatOf(vm.vmId).pipe(Effect.map((chat) => ({ ...vm, chat }))),
          );
          return { ...inventory, vms } satisfies RunnerStatus;
        }).pipe(
          Effect.catchTags({
            RunnerUnavailableError: (error) =>
              Effect.succeed({
                isAvailable: false,
                reason: error.message,
                vms: [],
              } satisfies RunnerStatus),
          }),
        ),
    });
  }),
);
