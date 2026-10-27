import { ChevronDownIcon } from "lucide-react";

import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { ActorAvatar, ActorName } from "./ActorAvatar";
import { useWorkDirectory } from "./useWorkDirectory";
import { actorName, assignableActors } from "./workLogic";

type Actor = ReturnType<typeof assignableActors>[number];

/**
 * The step's assignee in its details, like a ticket's: clicking the name opens a searchable list
 * of the people who can take the step, less whoever has it now. Picking one reassigns
 * at once.
 */
export function AssigneePicker({
  current,
  disabled,
  onPick,
}: {
  readonly current: string | null;
  readonly disabled: boolean;
  readonly onPick: (ref: string) => void;
}) {
  const directory = useWorkDirectory();
  const actors = assignableActors(directory, "person").filter((actor) => actor.id !== current);
  return (
    <Combobox<Actor>
      items={actors}
      itemToStringLabel={(actor) => actor.label}
      autoHighlight
      value={null}
      onValueChange={(actor) => {
        if (actor !== null) onPick(actor.id);
      }}
    >
      <ComboboxTrigger
        disabled={disabled}
        aria-label={`Assignee: ${actorName(directory, current)}. Change`}
        render={
          <button
            type="button"
            className="-mx-1.5 flex max-w-full items-center gap-1 rounded-md px-1.5 text-left hover:bg-muted disabled:opacity-64"
          />
        }
      >
        <ActorName actor={current} />
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </ComboboxTrigger>
      <ComboboxPopup aria-label="Assign to" className="flex w-72 flex-col">
        <ComboboxSearchInput placeholder="Search people" />
        <ComboboxEmpty>Nobody matches.</ComboboxEmpty>
        <ComboboxList>
          {(actor: Actor) => (
            <ComboboxItem key={actor.id} value={actor}>
              <ActorAvatar actor={actor.id} />
              <span className="min-w-0 flex-1 truncate">{actor.label}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
