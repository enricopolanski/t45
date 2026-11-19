import { useTranslation } from "~/i18n/locale";
/** The item's description, shared by its steps. */
export function ItemDescription({ description }: { readonly description: string }) {
  const t = useTranslation();
  if (!description) return null;
  return (
    <section
      aria-label={t("Description")}
      className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4"
    >
      <h3 className="text-sm font-semibold">{t("Description")}</h3>
      <p className="text-sm whitespace-pre-wrap">{description}</p>
    </section>
  );
}
