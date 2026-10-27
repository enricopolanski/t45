import type { UpdateOrganizationRequest } from "@t45/contracts/resources/Organization";

import { api } from "../rpc/api";
import { mutate, useLoaded } from "./query";
import { apiQuery, useApiQuery } from "./rpc";

const organization = apiQuery("organization.get")(undefined);

export const useOrganization = () => useLoaded(organization);

/** The organization, or null until it loads: the app's chrome shows T45 meanwhile. */
export const useOrganizationIfLoaded = () => useApiQuery(organization).data;

/** Saves the organization's name and avatar and reloads it everywhere it shows. */
export const updateOrganization = (request: UpdateOrganizationRequest) =>
  mutate(api("organization.update", request), organization, "Couldn't update the organization");
