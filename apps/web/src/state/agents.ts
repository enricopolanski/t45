import { useAtomValue } from "@effect/atom-react";
import { NotFound } from "@t45/contracts/resources/errors";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import { describeFailure } from "../lib/failures";
import { type ApiInput, api, atomRuntime, call } from "../rpc/api";
import { appAtomRegistry } from "./atomRegistry";
import { LoadFailed, mutate, useLoaded } from "./query";
import { apiQuery } from "./rpc";

export const agentsList = apiQuery("agents.list")(undefined);
const skillsList = apiQuery("skills.list")(undefined);

const agentForm = Atom.family((agentId: string | null) =>
  atomRuntime.atom((get) =>
    Effect.all(
      {
        agent: agentId === null ? Effect.succeed(null) : call("agents.get", { agentId }),
        skills: get.resultOnce(skillsList),
        models: call("agents.listModels", undefined),
      },
      { concurrency: "unbounded" },
    ),
  ),
);

export const useAgents = () => useLoaded(agentsList);
export const useSkills = () => useLoaded(skillsList);
export const useSkill = (skillId: string) => {
  const skill = useSkills().find((entry) => entry.id === skillId);
  const refreshing = useAtomValue(skillsList).waiting;
  if (skill === undefined && !refreshing) {
    throw new LoadFailed(describeFailure(new NotFound()), () =>
      appAtomRegistry.refresh(skillsList),
    );
  }
  return skill;
};
export const useAgentForm = (agentId: string | null) => useLoaded(agentForm(agentId));

export const agentActions = {
  archive: (agentId: string) =>
    mutate(api("agents.archive", { agentId }), agentsList, "Couldn't archive the agent"),
  restore: (agentId: string) =>
    mutate(api("agents.restore", { agentId }), agentsList, "Couldn't restore the agent"),
};

export const saveAgent = (agentId: string | null, draft: ApiInput<"agents.create">) =>
  (agentId === null
    ? api("agents.create", draft)
    : api("agents.update", { agentId, ...draft })
  ).then(() => appAtomRegistry.refresh(agentsList));

export const saveSkill = (skillId: string | null, draft: ApiInput<"skills.create">) =>
  (skillId === null
    ? api("skills.create", draft)
    : api("skills.update", { skillId, ...draft })
  ).then(() => appAtomRegistry.refresh(skillsList));

export const deleteSkill = (skillId: string) =>
  api("skills.delete", { skillId }).then(() => appAtomRegistry.refresh(skillsList));
