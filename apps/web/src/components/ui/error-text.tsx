import { cn } from "~/lib/utils";

/** A `span`, since inside markdown a `p` would take the paragraph margins. */
function ErrorText({ text, className, id }: { text: string; className?: string; id?: string }) {
  return (
    <span
      role="alert"
      id={id}
      className={cn(
        "block min-w-0 whitespace-pre-wrap text-sm text-destructive-foreground wrap-anywhere",
        className,
      )}
      data-slot="error-text"
    >
      {text}
    </span>
  );
}

export { ErrorText };
