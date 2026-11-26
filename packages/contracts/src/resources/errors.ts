import * as Schema from "effect/Schema";

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {}) {}
