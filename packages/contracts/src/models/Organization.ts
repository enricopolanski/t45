import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./primitives.ts";

/**
 * The deployment's one organization: the deployment is the tenant. It always exists, and its first
 * admin names it on first sign-in.
 */
export class Organization extends Schema.Opaque<Organization>()(
  Schema.Struct({
    name: Schema.NullOr(TrimmedNonEmptyString),
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
) {}
