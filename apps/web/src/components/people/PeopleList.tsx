import { ROLE_LABELS, useUsers } from "../../state/users";
import { UserAvatar } from "./UserAvatar";

/** Everyone in the organization who has access, by name, with their role. */
export function PeopleList() {
  const people = useUsers().active.toSorted((left, right) =>
    left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" }),
  );
  return (
    <section aria-label="People" className="flex flex-col gap-2">
      {people.map((person) => (
        <div key={person.id} className="card flex items-center justify-between gap-3 px-4 py-3">
          <span className="flex min-w-0 items-center gap-3">
            <UserAvatar user={person} />
            <span className="truncate text-sm font-medium">{person.displayName}</span>
          </span>
          <span className="text-xs text-muted-foreground">{ROLE_LABELS[person.role]}</span>
        </div>
      ))}
    </section>
  );
}
