import { apiQuery } from "./rpc";

export const chatTargets = apiQuery("chats.listTargets")(undefined);
