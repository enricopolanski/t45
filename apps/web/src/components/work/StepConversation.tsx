import { useTranslation } from "~/i18n/locale";
import type { StepView } from "@t45/contracts/resources/Workflows";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useSubmit } from "../../hooks/useSubmit";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { MarkdownText } from "../markdown/MarkdownText";
import { Textarea } from "../ui/textarea";
import { useWorkDirectory } from "./useWorkDirectory";
import { actorName } from "./workLogic";

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
  const t = useTranslation();
  const directory = useWorkDirectory();
  const now = useNowMinute();
  const { pending, onSubmit } = useSubmit(async (fields, form) => {
    if (await onComment(String(fields.get("body")).trim())) form.reset();
  });
  return (
    <section aria-label={t("Comments")} className="flex flex-col gap-2.5">
      <h2 className="text-sm font-semibold">{t("Comments")}</h2>
      {view.comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("No comments yet.")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {view.comments.map((comment) => (
            <li key={comment.id} className="card flex flex-col gap-2 px-5 py-4">
              <p className="text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">
                  {actorName(directory, comment.author)}
                </span>
                {" · "}
                {formatRelativeTimeLabel(comment.createdAt, now)}
              </p>
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
            aria-label={t("New comment")}
            placeholder={t("Write a comment (Markdown supported)")}
          />
          <Button type="submit" size="sm" variant="outline" disabled={busy || pending}>
            {t("Comment")}
          </Button>
        </form>
      ) : null}
    </section>
  );
}
