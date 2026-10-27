import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./primitives.ts";

export const AVATAR_COLORS = [
  "slate",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "sky",
  "blue",
  "violet",
  "pink",
] as const;
export const AvatarColor = Schema.Literals(AVATAR_COLORS);
export type AvatarColor = typeof AvatarColor.Type;

const MAX_AVATAR_BYTES = 512 * 1024;
export const PNG_DATA_URL = "data:image/png;base64,";

/**
 * A user's or the organization's avatar: an image, or an initial on a color. A save sends a new
 * image as a PNG data URL; any other URL keeps the stored image.
 */
export const Avatar = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("initial"), color: AvatarColor }),
  Schema.Struct({
    kind: Schema.Literal("image"),
    url: TrimmedNonEmptyString.check(
      Schema.isMaxLength(PNG_DATA_URL.length + Math.ceil(MAX_AVATAR_BYTES / 3) * 4),
    ),
  }),
]);
export type Avatar = typeof Avatar.Type;

export class InvalidAvatar extends Schema.TaggedError<InvalidAvatar>()("InvalidAvatar", {}) {
  override get message(): string {
    return "Choose a PNG, JPEG, or WebP image no larger than 512 KiB.";
  }
}
