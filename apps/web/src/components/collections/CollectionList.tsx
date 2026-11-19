import { useTranslation } from "~/i18n/locale";
import { Link } from "@tanstack/react-router";

import { api } from "../../rpc/api";
import { useIsAdmin } from "../../state/session";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { WorkFrame } from "../work/WorkFrame";
import { useWorkflowData } from "../workflows/useWorkflowData";

const loadCollections = () => api("collections.list", undefined);

/** The collections the member uses; admins see and define every one. */
export function CollectionList() {
  const t = useTranslation();
  const isAdmin = useIsAdmin();
  const { detail: collections, error } = useWorkflowData(loadCollections);
  return (
    <WorkFrame
      title={t("Collections")}
      actions={
        isAdmin ? (
          <Button size="sm" render={<Link to="/settings/collections/new" />}>
            {t("New collection")}
          </Button>
        ) : null
      }
    >
      <p className="text-sm text-muted-foreground">
        {t(
          "Collections keep data that people and agents reuse across tasks. A record's primary key identifies it within its collection.",
        )}
      </p>
      <section aria-label={t("Collections")} className="flex flex-col gap-3">
        {error && <ErrorText text={error} />}
        {collections !== null && collections.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {isAdmin ? t("No collections yet.") : t("No collection is shared with you yet.")}
          </p>
        ) : null}
        {collections?.map((collection) => (
          <div
            key={collection.id}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
          >
            <Link
              to="/settings/collections/$collectionId"
              params={{ collectionId: collection.id }}
              className="min-w-0 flex-1"
            >
              <p className="truncate text-sm font-medium">{collection.title}</p>
              <p className="text-xs text-muted-foreground">
                {t(
                  collection.fields.length === 1 ? "{0} field" : "{0} fields",
                  collection.fields.length,
                )}{" "}
                {t("· keyed by")}{" "}
                {
                  collection.fields.find((field) => field.id === collection.primaryKeyFieldId)
                    ?.label
                }
              </p>
            </Link>
            {isAdmin ? (
              <Button
                size="sm"
                variant="ghost"
                render={
                  <Link
                    to="/settings/collections/$collectionId/edit"
                    params={{ collectionId: collection.id }}
                  />
                }
              >
                {t("Edit")}
              </Button>
            ) : null}
          </div>
        ))}
      </section>
    </WorkFrame>
  );
}
