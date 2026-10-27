import { BotIcon } from "lucide-react";

import { UserAvatar } from "../people/UserAvatar";
import { useWorkDirectory } from "./useWorkDirectory";
import { actorName } from "./workLogic";

/** A small round avatar for whoever has work: a person's initials, a robot for an agent. */
export function ActorAvatar({ actor }: { readonly actor: string | null }) {
  const directory = useWorkDirectory();
  if (directory.agents.some((agent) => agent.id === actor)) {
    return (
      <span
        aria-label={`${actorName(directory, actor)}, an agent`}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-info/12 text-info"
      >
        <BotIcon className="size-3.5" />
      </span>
    );
  }
  return <UserAvatar user={directory.people.find((person) => person.id === actor)} size="xs" />;
}

/** An avatar and the name beside it, truncating the name when space runs out. */
export function ActorName({
  actor,
  name,
}: {
  readonly actor: string | null;
  readonly name?: string;
}) {
  const directory = useWorkDirectory();
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ActorAvatar actor={actor} />
      <span className="min-w-0 truncate">{name ?? actorName(directory, actor)}</span>
    </span>
  );
}
