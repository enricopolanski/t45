import * as Schema from "effect/Schema";

import { Avatar } from "./Avatar.ts";
import { TrimmedNonEmptyString } from "./primitives.ts";

/**
 * The deployment's one organization: the deployment is the tenant. It always exists, and its first
 * admin names it on first sign-in. Its avatar is its logo.
 */
export class Organization extends Schema.Opaque<Organization>()(
  Schema.Struct({
    name: Schema.NullOr(TrimmedNonEmptyString),
    avatar: Avatar,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
  }),
) {}
