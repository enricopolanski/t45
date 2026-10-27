import * as Schema from "effect/Schema";

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {}) {}

export class AccessDenied extends Schema.TaggedError<AccessDenied>()("AccessDenied", {
  message: Schema.String,
}) {}
