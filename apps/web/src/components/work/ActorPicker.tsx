import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useWorkDirectory } from "./useWorkDirectory";
import { actorName, assignableActors } from "./workLogic";

const NONE = "none";

interface ActorPickerProps {
  readonly value: string | null;
  readonly onChange: (ref: string) => void;
  readonly noneLabel?: string;
  readonly onClear?: () => void;
  readonly kind: "person" | "agent";
  readonly placeholder: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly "aria-label"?: string;
}

/**
 * Picks a person or agent who can be given work. With `noneLabel`, the first choice is nobody in
 * particular (such as inheriting from the step before), which calls `onClear`.
 */
export function ActorPicker({
  value,
  onChange,
  noneLabel,
  onClear,
  kind,
  placeholder,
  disabled,
  ...rest
}: ActorPickerProps) {
  const directory = useWorkDirectory();
  const actors = assignableActors(directory, kind);
  return (
    <Select
      value={value === null ? (noneLabel === undefined ? null : NONE) : value}
      onValueChange={(key) => {
        if (key === NONE) {
          onClear?.();
          return;
        }
        const actor = actors.find((candidate) => candidate.id === key);
        if (actor) onChange(actor.id);
      }}
      disabled={disabled}
    >
      <SelectTrigger {...rest}>
        <SelectValue placeholder={placeholder}>
          {(key: string) =>
            key === NONE
              ? noneLabel
              : (actors.find((candidate) => candidate.id === key)?.label ??
                (value !== null && value === key
                  ? `${actorName(directory, value)} (can't take work)`
                  : placeholder))
          }
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {noneLabel !== undefined ? <SelectItem value={NONE}>{noneLabel}</SelectItem> : null}
        {actors.map((actor) => (
          <SelectItem key={actor.id} value={actor.id}>
            {actor.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** An ActorPicker of people that answers with a user id: a responsible, or a workflow's admin. */
export function PersonPicker({
  value,
  onChange,
  ...rest
}: Omit<ActorPickerProps, "kind" | "value" | "onChange"> & {
  readonly value: string | null;
  readonly onChange: (userId: string) => void;
}) {
  return <ActorPicker {...rest} kind="person" value={value} onChange={onChange} />;
}
