import { Authorization, CurrentActor, CurrentUser } from "@t45/contracts/Authorization";
import { AccessDenied } from "@t45/contracts/resources/errors";
import { Chats } from "@t45/contracts/resources/Chats";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ChatService } from "./ChatService.ts";

export const layer = Chats.middleware(Authorization).toLayer(
  Effect.gen(function* () {
    const chats = yield* ChatService;
    const asMember =
      <I, A, E>(
        call: (input: I, member: Effect.Success<typeof CurrentUser>) => Effect.Effect<A, E>,
      ) =>
      (input: I) =>
        Effect.flatMap(CurrentUser, (member) => call(input, member));

    return Chats.of({
      "chats.report": ({ message }) =>
        Effect.gen(function* () {
          const actor = yield* CurrentActor;
          if (!("chatId" in actor))
            return yield* new AccessDenied({
              message: "Only a running agent can report progress.",
            });
          yield* chats.report(actor.chatId, message);
        }),
      "chats.listTargets": () => Effect.flatMap(CurrentUser, chats.listTargets),
      "chats.watchList": () =>
        Stream.unwrap(Effect.map(CurrentUser, (member) => chats.subscribe(member))),
      "chats.watch": (input) =>
        Stream.unwrap(Effect.map(CurrentUser, (member) => chats.open(input, member))),
      "chats.getHistory": asMember(chats.history),
      "chats.getMessage": asMember(chats.message),
      "chats.send": asMember(chats.send),
      "chats.cancel": asMember(chats.cancel),
      "chats.answer": asMember(chats.answer),
      "chats.dismiss": asMember(chats.dismiss),
      "chats.stop": asMember(chats.stop),
      "chats.rename": asMember(chats.rename),
      "chats.delete": asMember(chats.delete),
    });
  }),
);
