import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { XIcon } from "lucide-react";

export function ChatBanner({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  return (
    <div className="error-glass absolute top-3 left-1/2 z-20 flex w-max max-w-[min(48rem,calc(100%-2rem))] -translate-x-1/2 items-start gap-2 rounded-xl border border-destructive/32 p-3.5">
      <ErrorText text={error} />
      {/* Taller than a text line: the negative margins center it on the first line. */}
      <Button
        variant="ghost"
        size="icon-xs"
        className="-my-1 sm:-my-0.5"
        aria-label="Dismiss error"
        onClick={onDismiss}
      >
        <XIcon />
      </Button>
    </div>
  );
}
