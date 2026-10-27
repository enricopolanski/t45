/*
 * The avatars of users and of the organization. A row keeps its initial's color and, once one is
 * uploaded, its PNG image; its avatar is that image, at its route, or else the initial.
 */
import { type Avatar, InvalidAvatar, PNG_DATA_URL } from "@t45/contracts/models/Avatar";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";
import type * as SqlClient from "effect/sql/SqlClient";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A saved avatar's new image, from a PNG data URL and checked by its bytes; null keeps it. */
export const avatarUpload = (avatar: Avatar) => {
  if (avatar.kind === "initial" || !avatar.url.startsWith("data:")) return Effect.succeed(null);
  const content = avatar.url.startsWith(PNG_DATA_URL)
    ? Result.getOrNull(Base64.decode(avatar.url.slice(PNG_DATA_URL.length)))
    : null;
  return content !== null && PNG_SIGNATURE.every((byte, index) => content[index] === byte)
    ? Effect.succeed(content)
    : Effect.fail(new InvalidAvatar());
};

/** The row's avatar as JSON: its image at `path`, versioned by the row's last change. */
export const avatarJson = (path: string) => `CASE WHEN avatar_image IS NULL
    THEN json_object('kind', 'initial', 'color', avatar_color)
    ELSE json_object('kind', 'image', 'url', ${path} || '?v=' || updated_at) END`;

/** Sets the row's avatar: an initial clears its image; an image keeps it unless `upload` replaces it. */
export const setAvatar = (sql: SqlClient.SqlClient, avatar: Avatar, upload: Uint8Array | null) =>
  avatar.kind === "initial"
    ? sql`avatar_color = ${avatar.color}, avatar_image = NULL`
    : sql`avatar_image = ${upload ?? sql`avatar_image`}`;
