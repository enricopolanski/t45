import type { AttachmentId } from "@t45/contracts/models/Attachment";
import type { StepView } from "@t45/contracts/resources/Workflows";
import { XIcon } from "lucide-react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useSubmit } from "../../hooks/useSubmit";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { AttachmentLink, FilePickButton } from "./StepFields";
import { useWorkDirectory } from "./useWorkDirectory";
import { actorName } from "./workLogic";

/** The step's files, near the top: what the step is worked from. */
export function StepFiles({
  view,
  canWrite,
  busy,
  onAttach,
  onRemove,
}: {
  readonly view: StepView;
  readonly canWrite: boolean;
  readonly busy: boolean;
  readonly onAttach: (file: File) => void;
  readonly onRemove: (attachmentId: AttachmentId) => void;
}) {
  return (
    <section aria-label="Files" className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Files</h2>
        {canWrite ? (
          <FilePickButton
            aria-label="Attach a file"
            label="Attach"
            disabled={busy}
            onPick={onAttach}
          />
        ) : null}
      </div>
      {view.files.length === 0 ? (
        <p className="text-sm text-muted-foreground">No files.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {view.files.map((attachment) => (
            <li key={attachment.id} className="flex items-center gap-2">
              <AttachmentLink attachment={attachment} />
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${attachment.name}`}
                disabled={busy}
                onClick={() => onRemove(attachment.id)}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The step's comments: a rejection reason is a comment too. */
export function StepComments({
  view,
  canWrite,
  busy,
  onComment,
}: {
  readonly view: StepView;
  readonly canWrite: boolean;
  readonly busy: boolean;
  readonly onComment: (body: string) => Promise<boolean>;
}) {
  const directory = useWorkDirectory();
  const now = useNowMinute();
  const { pending, onSubmit } = useSubmit(async (fields, form) => {
    if (await onComment(String(fields.get("body")).trim())) form.reset();
  });
  return (
    <section aria-label="Comments" className="flex flex-col gap-2.5">
      <h2 className="text-sm font-semibold">Comments</h2>
      {view.comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {view.comments.map((comment) => (
            <li
              key={comment.id}
              className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2"
            >
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {actorName(directory, comment.author)}
                </span>
                <span>{formatRelativeTimeLabel(comment.createdAt, now)}</span>
              </div>
              <p className="text-sm whitespace-pre-wrap">{comment.body}</p>
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <form className="flex flex-col items-end gap-2" onSubmit={onSubmit}>
          <Textarea name="body" required aria-label="New comment" placeholder="Write a comment" />
          <Button type="submit" size="sm" variant="outline" disabled={busy || pending}>
            Comment
          </Button>
        </form>
      ) : null}
    </section>
  );
}
