import { useLoaded } from "./query";
import { apiQuery } from "./rpc";

const organization = apiQuery("organization.get")(undefined);

export const useOrganization = () => useLoaded(organization);
