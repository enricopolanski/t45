import { Authorization, CurrentUser } from "@t45/contracts/Authorization";
import { Chats } from "@t45/contracts/resources/Chats";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ChatService } from "./ChatService.ts";
import { TaskService } from "../tasks/TaskService.ts";
import { WorkflowService } from "../workflows/WorkflowService.ts";
import * as SqlClient from "effect/sql/SqlClient";

export const layer = Chats.middleware(Authorization).toLayer(
  Effect.gen(function* () {
    const chats = yield* ChatService;
    const tasks = yield* TaskService;
    const workflows = yield* WorkflowService;
    const sql = yield* SqlClient.SqlClient;
    const asMember =
      <I, A, E>(call: (input: I, member: CurrentUser["Service"]) => Effect.Effect<A, E>) =>
      (input: I) =>
        Effect.flatMap(CurrentUser, (member) => call(input, member));

    return Chats.of({
      "chats.watchList": () =>
        Stream.unwrap(Effect.map(CurrentUser, (member) => chats.subscribe(member))),
      "chats.watch": (input) =>
        Stream.unwrap(Effect.map(CurrentUser, (member) => chats.open(input, member))),
      "chats.getHistory": asMember(chats.history),
      "chats.getMessage": asMember(chats.message),
      "chats.send": asMember(tasks.send),
      "chats.cancel": asMember(chats.cancel),
      "chats.answer": asMember(chats.answer),
      "chats.dismiss": asMember(chats.dismiss),
      "chats.stop": asMember(chats.stop),
      "chats.rename": asMember(chats.rename),
      "chats.delete": asMember((input, member) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* chats.delete(input, member);
              const changed = yield* tasks.settle(input.chatId, {
                type: "failed",
                reason: "The task's chat was deleted.",
              });
              if (changed !== null) yield* workflows.taskChanged(changed);
            }),
          )
          .pipe(Effect.catchTags({ SqlError: Effect.die })),
      ),
    });
  }),
);
