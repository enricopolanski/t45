import type { ComponentProps, ReactNode } from "react";
import { PageContent } from "../PageContent";
import { Section } from "../Section";

/** A section of settings rows, separated by rules inside a card. */
export function SettingsSection({
  children,
  ...props
}: Omit<ComponentProps<typeof Section>, "card">) {
  return (
    <Section {...props}>
      <div className="card divide-y divide-border">{children}</div>
    </Section>
  );
}

/** A section's text when it has no rows, aligned with row titles. */
export function SettingsEmpty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">{children}</p>;
}

/**
 * Keep descriptions short enough for one line where possible. Allow wrapping
 * for clarity or narrow screens instead of truncating or forcing no-wrap.
 *
 * Control sizing across settings follows two tiers so rows share a baseline:
 * - `control` slot and section `action`s: `size="sm"` (Button, Select, Input) or `icon-sm`;
 *   section actions are `variant="outline"`.
 * - Buttons inside list items, cards, toolbars: `xs` / `icon-xs`.
 */
export function SettingsRow({
  title,
  description,
  status,
  control,
}: {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className="@container/settings-row px-3 py-3 sm:px-4">
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="min-h-5 text-sm font-medium text-foreground">{title}</h3>
          {description ? (
            <p className="max-w-xl text-xs leading-normal text-muted-foreground/80">
              {description}
            </p>
          ) : null}
          {status ? <div className="pt-0.5 text-xs text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full min-w-0 shrink-0 items-center gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end">
            {control}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SettingsPageContainer({ children }: { children: ReactNode }) {
  return (
    <div className="topbar-scroll-fade scrollbar-gutter-both flex-1 overflow-y-auto">
      <PageContent>{children}</PageContent>
    </div>
  );
}
