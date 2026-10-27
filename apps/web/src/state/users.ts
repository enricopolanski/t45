import type { Role, User } from "@t45/contracts/models/User";

import { api } from "../rpc/api";
import { mutate, useLoaded } from "./query";
import { apiQuery } from "./rpc";

export const usersList = apiQuery("users.list")(undefined);
const profile = apiQuery("users.getProfile")(undefined);

const byState = (users: ReadonlyArray<User>) => ({
  pending: users.filter((user) => user.state === "pending"),
  active: users.filter((user) => user.state === "active"),
  deactivated: users.filter((user) => user.state === "deactivated"),
});

export const useUsers = () => byState(useLoaded(usersList));

export const ROLE_LABELS: Record<Role, string> = {
  member: "Member",
  admin: "Admin",
};
export const useProfile = () => useLoaded(profile);

const act = (request: Promise<unknown>) => mutate(request, usersList, "Couldn't update the member");

export const userActions = {
  approve: (userId: User["id"], role: Role) => act(api("users.approve", { userId, role })),
  decline: (userId: User["id"]) => act(api("users.decline", { userId })),
  changeRole: (userId: User["id"], role: Role) => act(api("users.changeRole", { userId, role })),
  deactivate: (userId: User["id"]) => act(api("users.deactivate", { userId })),
  reactivate: (userId: User["id"]) => act(api("users.reactivate", { userId })),
};
