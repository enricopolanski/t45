import { agentsList } from "../../state/agents";
import { useApiQuery } from "../../state/rpc";
import { usersList } from "../../state/users";
import type { WorkDirectory } from "./workLogic";

export function useWorkDirectory(): WorkDirectory {
  return {
    people: useApiQuery(usersList).data ?? [],
    agents: useApiQuery(agentsList).data ?? [],
  };
}
