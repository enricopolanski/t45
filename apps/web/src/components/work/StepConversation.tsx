import type { AttachmentId } from "@t45/contracts/models/Attachment";
import type { StepView } from "@t45/contracts/resources/Workflows";
import * as DateTime from "effect/DateTime";
import { ArrowDownIcon, ArrowUpIcon, FileSpreadsheetIcon, FileTextIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useSubmit } from "../../hooks/useSubmit";
import { attachmentUrl } from "../../lib/attachmentUrl";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ActorName } from "./ActorAvatar";
import { FilePickButton } from "./StepFields";
import { useWorkDirectory } from "./useWorkDirectory";
import { actorName, plural } from "./workLogic";

/** "13 Nov 2026": the day a file was added, in the viewer's time zone. */
const addedDay = (instant: DateTime.Utc) =>
  DateTime.toDateUtc(instant).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const headerCell = "bg-muted px-3 py-2 text-left text-xs font-medium text-foreground/80";
const bodyCell = "h-10 border-t border-l border-l-border/60 px-3";

/** The step's files, near the top: what the step is worked from, newest first unless flipped. */
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
  const [isNewestFirst, setIsNewestFirst] = useState(true);
  const files = view.files.toSorted((one, other) => {
    const age = DateTime.toEpochMillis(other.createdAt) - DateTime.toEpochMillis(one.createdAt);
    return isNewestFirst ? age : -age;
  });
  return (
    <section aria-label="Files" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm/6 font-medium">Files</h2>
        {files.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            {plural(files.length, "file", "files")}
          </span>
        ) : null}
        {canWrite ? (
          <div className="ms-auto flex">
            <FilePickButton
              aria-label="Attach a file"
              label="Attach"
              disabled={busy}
              onPick={onAttach}
            />
          </div>
        ) : null}
      </div>
      {files.length === 0 ? (
        <p className="text-sm text-muted-foreground">No files.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full min-w-xl table-fixed border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <th scope="col" className={cn(headerCell, "w-[52%] ps-4")}>
                  Name
                </th>
                <th
                  scope="col"
                  aria-sort={isNewestFirst ? "descending" : "ascending"}
                  className={cn(headerCell, "w-[20%] border-l border-border/60")}
                >
                  <button
                    type="button"
                    aria-label={`Date added, ${isNewestFirst ? "newest" : "oldest"} first. Change sort order`}
                    className="inline-flex cursor-pointer items-center gap-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setIsNewestFirst(!isNewestFirst)}
                  >
                    Date added
                    {isNewestFirst ? (
                      <ArrowDownIcon className="size-3" />
                    ) : (
                      <ArrowUpIcon className="size-3" />
                    )}
                  </button>
                </th>
                <th scope="col" className={cn(headerCell, "border-l border-border/60")}>
                  Added by
                </th>
                {canWrite ? (
                  <th scope="col" className={cn(headerCell, "w-12 border-l border-border/60")}>
                    <span className="sr-only">Remove</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.id}>
                  <td className="h-10 border-t ps-4 pe-3">
                    <a
                      href={attachmentUrl(file)}
                      download={file.name}
                      className="flex min-w-0 items-center gap-2.5 text-primary hover:underline"
                    >
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent text-muted-foreground">
                        {/\.(csv|xlsx?|ods)$/i.test(file.name) ? (
                          <FileSpreadsheetIcon className="size-3.5" />
                        ) : (
                          <FileTextIcon className="size-3.5" />
                        )}
                      </span>
                      <span className="truncate">{file.name}</span>
                    </a>
                  </td>
                  <td className={cn(bodyCell, "truncate text-foreground/80")}>
                    {addedDay(file.createdAt)}
                  </td>
                  <td className={bodyCell}>
                    <ActorName actor={file.uploader} />
                  </td>
                  {canWrite ? (
                    <td className={cn(bodyCell, "px-0 text-center")}>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Remove ${file.name}`}
                        disabled={busy}
                        onClick={() => onRemove(file.id)}
                      >
                        <XIcon />
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The step's comments: a failed agent's reason is a comment too. */
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
