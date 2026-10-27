import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { ErrorDetailText } from "../ui/error-detail-text";
import { CircleAlertIcon, XIcon } from "lucide-react";

export function ChatBanner({ error, onDismiss }: { error: string | null; onDismiss: () => void }) {
  if (!error) return null;
  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert
        variant="error"
        glass
        icon={<CircleAlertIcon />}
        action={
          <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
            <XIcon />
          </Button>
        }
      >
        <ErrorDetailText text={error} />
      </Alert>
    </div>
  );
}
