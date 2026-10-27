import { type ComposerCommandItem } from "../../composerPrompt";
import { keepComposerFocus } from "./composerLayout";
import { ScrollArea } from "../ui/scroll-area";

/** The option's element id, which the editor names as its active descendant. */
export const composerSuggestionOptionId = (listId: string, command: string) =>
  `${listId}-${command}`;

export function ComposerCommandMenu(props: {
  listId: string;
  items: ComposerCommandItem[];
  activeCommand: ComposerCommandItem["command"] | null;
  onHighlight: (command: ComposerCommandItem["command"]) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  return (
    <div className="composer-drawer absolute inset-x-(--chat-composer-drawer-inset) -bottom-(--chat-composer-attachment-overlap) z-20 flex flex-col overflow-hidden pb-(--chat-composer-attachment-overlap) **:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:my-4">
      {props.items.length > 0 ? (
        <ScrollArea scrollbarGutter scrollFade>
          <div id={props.listId} role="listbox" aria-label="Commands" className="max-h-72 p-2">
            {props.items.map((item) => (
              <div
                key={item.command}
                id={composerSuggestionOptionId(props.listId, item.command)}
                role="option"
                aria-selected={props.activeCommand === item.command}
                className="flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-base aria-selected:bg-accent aria-selected:text-accent-foreground sm:min-h-7 sm:text-sm"
                onMouseMove={() => {
                  if (props.activeCommand !== item.command) props.onHighlight(item.command);
                }}
                onMouseDown={keepComposerFocus}
                onClick={() => props.onSelect(item)}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="min-w-0 max-w-[45%] shrink-0 truncate font-sans text-xs font-medium">
                    /{item.command}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left text-secondary-label text-xs">
                    {item.description}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </ScrollArea>
      ) : (
        <div className="px-5 pt-3.5 pb-7">
          <p className="text-secondary-label text-xs">No matching command.</p>
        </div>
      )}
    </div>
  );
}
