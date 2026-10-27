import type { Avatar, AvatarColor, User } from "@t45/contracts/models/User";

/** How this user's avatar is served by the application. */
export const getAvatar = (user: User): Avatar =>
  user.avatarContentType === null
    ? { kind: "initial", color: user.avatarColor }
    : {
        kind: "image",
        url: `/api/avatars/${encodeURIComponent(user.id)}`,
      };

/** The look of each letter-avatar color. */
export const AVATAR_COLOR_CLASSES: Record<AvatarColor, string> = {
  slate: "bg-slate-500",
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  green: "bg-green-600",
  teal: "bg-teal-600",
  sky: "bg-sky-500",
  blue: "bg-blue-600",
  violet: "bg-violet-600",
  pink: "bg-pink-500",
};

const SIZE_CLASSES = {
  xs: "size-6 text-2xs",
  sm: "size-8 text-xs",
  lg: "size-20 text-3xl",
} as const;

/**
 * A user as others see them: their image, or the first letter of their name on a color, and a "?"
 * on slate while they are unknown. The profile passes a name and avatar to preview them instead.
 */
export function UserAvatar({
  user,
  name = user?.displayName ?? "",
  avatar = user === undefined ? { kind: "initial", color: "slate" } : getAvatar(user),
  size = "sm",
}: {
  readonly user?: User | undefined;
  readonly name?: string;
  readonly avatar?: Avatar;
  readonly size?: keyof typeof SIZE_CLASSES;
}) {
  const sizeClass = SIZE_CLASSES[size];
  if (avatar.kind === "image") {
    return (
      <img src={avatar.url} alt="" className={`${sizeClass} shrink-0 rounded-full object-cover`} />
    );
  }
  return (
    <span
      aria-hidden
      className={`${sizeClass} ${AVATAR_COLOR_CLASSES[avatar.color]} flex shrink-0 items-center justify-center rounded-full font-semibold text-white`}
    >
      {(name.trim().charAt(0) || "?").toUpperCase()}
    </span>
  );
}
