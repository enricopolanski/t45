import type { AttachmentId } from "@t45/contracts/models/Attachment";
import type { StepView } from "@t45/contracts/resources/Workflows";
import * as DateTime from "effect/DateTime";
import { ArrowDownIcon, ArrowUpIcon, PaperclipIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useSubmit } from "../../hooks/useSubmit";
import { attachmentUrl } from "../../lib/attachmentUrl";
import { cn } from "../../lib/utils";
import { makeFileDropHandlers } from "../chat/fileDrop";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { MarkdownText } from "../markdown/MarkdownText";
import { Textarea } from "../ui/textarea";
import { ActorName } from "./ActorAvatar";
import { useWorkDirectory } from "./useWorkDirectory";
import { actorName, plural } from "./workLogic";

/** "13 Nov 2026": the day a file was added, in the viewer's time zone. */
const addedDay = (instant: DateTime.Utc) =>
  DateTime.toDateUtc(instant).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const headerCell = "bg-muted px-3 py-2 text-left text-xs font-medium text-muted-foreground";
const bodyCell = "h-12 border-t px-3";

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
  readonly onAttach: (files: ReadonlyArray<File>) => void;
  readonly onRemove: (attachmentId: AttachmentId) => void;
}) {
  const [isNewestFirst, setIsNewestFirst] = useState(true);
  const [isDragActive, setIsDragActive] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const files = view.files.toSorted((one, other) => {
    const age = DateTime.toEpochMillis(other.createdAt) - DateTime.toEpochMillis(one.createdAt);
    return isNewestFirst ? age : -age;
  });
  const isEmpty = files.length === 0;
  return (
    <section
      aria-label="Files"
      className={cn("card flex flex-col gap-3 p-4", isDragActive && "border-primary bg-primary/4")}
      {...(canWrite
        ? makeFileDropHandlers({ setDragActive: setIsDragActive, addFiles: onAttach })
        : {})}
    >
      <div className="flex items-center gap-2.5">
        <h2 className="text-sm font-semibold">Files</h2>
        {isEmpty ? null : <Badge variant="info">{plural(files.length, "file", "files")}</Badge>}
        {canWrite ? (
          <Button
            size="sm"
            variant="outline"
            className="ms-auto"
            aria-label="Attach a file"
            disabled={busy}
            onClick={() => picker.current?.click()}
          >
            <PaperclipIcon aria-hidden />
            Attach
          </Button>
        ) : null}
      </div>
      {isEmpty ? null : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-xl table-fixed border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <th scope="col" className={cn(headerCell, "w-[52%] ps-4")}>
                  Name
                </th>
                <th
                  scope="col"
                  aria-sort={isNewestFirst ? "descending" : "ascending"}
                  className={cn(headerCell, "w-[20%]")}
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
                <th scope="col" className={headerCell}>
                  Added by
                </th>
                {canWrite ? (
                  <th scope="col" className={cn(headerCell, "w-12")}>
                    <span className="sr-only">Remove</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.id}>
                  <td className="h-12 border-t ps-4 pe-3">
                    <a
                      href={attachmentUrl(file)}
                      download={file.name}
                      className="flex min-w-0 items-center gap-2.5 font-semibold text-primary hover:underline"
                    >
                      <span
                        aria-hidden
                        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-3xs font-bold tracking-wide text-muted-foreground"
                      >
                        {/\.(\w{1,4})$/.exec(file.name)?.[1]?.toUpperCase() ?? "FILE"}
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
      {canWrite ? (
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const picked = [...(event.target.files ?? [])];
            event.target.value = "";
            if (picked.length > 0) onAttach(picked);
          }}
        />
      ) : null}
      {isEmpty ? (
        <p className="rounded-lg border border-dashed bg-muted/50 px-4 py-3.5 text-center text-sm text-muted-foreground">
          {canWrite ? "No files yet. Attach them with the button, or drop them here." : "No files."}
        </p>
      ) : canWrite ? (
        <p className="text-xs text-muted-foreground">
          You can also drop files here to attach them.
        </p>
      ) : null}
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
              <MarkdownText text={comment.body} />
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <form className="flex flex-col items-end gap-2" onSubmit={onSubmit}>
          <Textarea
            name="body"
            required
            aria-label="New comment"
            placeholder="Write a comment (Markdown supported)"
          />
          <Button type="submit" size="sm" variant="outline" disabled={busy || pending}>
            Comment
          </Button>
        </form>
      ) : null}
    </section>
  );
}
