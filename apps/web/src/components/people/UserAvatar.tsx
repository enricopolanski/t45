import type { Avatar, AvatarColor } from "@t45/contracts/models/Avatar";
import type { User } from "@t45/contracts/models/User";

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

const initialOf = (name: string) => (name.trim().charAt(0) || "?").toUpperCase();

/**
 * A user as others see them: their image, or the first letter of their name on a color, and a "?"
 * on slate while they are unknown. Editors pass a name and avatar to preview them instead.
 */
export function UserAvatar({
  user,
  name = user?.displayName ?? "",
  avatar = user?.avatar ?? { kind: "initial", color: "slate" },
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
      {initialOf(name)}
    </span>
  );
}

/**
 * The organization's avatar: its whole logo at the width `className` sets, as tall as its
 * proportions make it, or else its initial on a square of that width.
 */
export function OrganizationAvatar({
  name,
  avatar,
  className,
}: {
  readonly name: string;
  readonly avatar: Avatar;
  readonly className: string;
}) {
  if (avatar.kind === "image") {
    return <img src={avatar.url} alt="" className={`${className} h-auto shrink-0`} />;
  }
  return (
    <span
      aria-hidden
      className={`${className} ${AVATAR_COLOR_CLASSES[avatar.color]} flex aspect-square shrink-0 items-center justify-center rounded-sm font-semibold text-white`}
    >
      {initialOf(name)}
    </span>
  );
}
