import { Spinner } from "~/components/ui/spinner";

import { ComposerBanner } from "./ComposerBanner";

/** Says the chat's messages are loading, until its first snapshot. */
export function ComposerLoadingBanner() {
  return (
    <ComposerBanner.Root>
      <ComposerBanner.Row>
        <ComposerBanner.Icon>
          <Spinner />
        </ComposerBanner.Icon>
        <ComposerBanner.Content>
          <span className="shrink-0 whitespace-nowrap text-muted-foreground" role="status">
            Loading messages…
          </span>
        </ComposerBanner.Content>
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  );
}
