/** The item's description, shared by its steps. */
export function ItemDescription({ description }: { readonly description: string }) {
  if (!description) return null;
  return (
    <section aria-label="Description" className="flex flex-col gap-2.5">
      <h3 className="text-sm font-semibold">Description</h3>
      <p className="text-sm whitespace-pre-wrap">{description}</p>
    </section>
  );
}
