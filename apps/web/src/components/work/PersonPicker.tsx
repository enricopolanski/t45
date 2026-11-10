import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useWorkDirectory } from "./useWorkDirectory";
import { actorName, assignablePeople } from "./workLogic";

const NONE = "none";

interface PersonPickerProps {
  readonly value: string | null;
  readonly onChange: (ref: string) => void;
  readonly noneLabel?: string;
  readonly onClear?: () => void;
  readonly placeholder: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly "aria-label"?: string;
}

/**
 * Picks a person who can be given work. With `noneLabel`, the first choice is nobody in
 * particular (such as inheriting from the step before), which calls `onClear`.
 */
export function PersonPicker({
  value,
  onChange,
  noneLabel,
  onClear,
  placeholder,
  disabled,
  ...rest
}: PersonPickerProps) {
  const directory = useWorkDirectory();
  const actors = assignablePeople(directory);
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
