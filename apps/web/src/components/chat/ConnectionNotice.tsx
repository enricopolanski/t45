import { useAtomValue } from "@effect/atom-react";
import { WifiOffIcon } from "lucide-react";

import { useDelayedTrue } from "../../hooks/useDelayedTrue";
import { reachableAtom } from "../../rpc/api";
import { ComposerBanner } from "./ComposerBanner";

export function ConnectionNotice() {
  const unreachable = !useAtomValue(reachableAtom);
  if (!useDelayedTrue(unreachable, 2_000)) return null;
  return (
    <ComposerBanner.Root
      role="alert"
      variant="warning"
      density="comfortable"
      data-chat-composer-collapsed-controls="true"
    >
      <ComposerBanner.Row>
        <ComposerBanner.Icon className="h-(--composer-banner-icon-column) self-start">
          <WifiOffIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="whitespace-nowrap">
          <span className="min-w-0 truncate font-medium leading-7 sm:leading-6">
            Server is reconnecting
          </span>
        </ComposerBanner.Content>
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  );
}
