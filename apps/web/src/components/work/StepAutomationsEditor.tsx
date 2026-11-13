import { Link } from "@tanstack/react-router";
import { stepAutomationList } from "../../state/agents";
import { useApiQuery } from "../../state/rpc";
import { useIsAdmin } from "../../state/session";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ErrorText } from "../ui/error-text";

/** A workflow step's automations, attached and detached in the workflow's step editor. */
export function StepAutomationsEditor({
  automationIds,
  disabled = false,
  onChange,
}: {
  readonly automationIds: ReadonlyArray<string>;
  readonly disabled?: boolean;
  readonly onChange: (ids: ReadonlyArray<string>) => void;
}) {
  const query = useApiQuery(stepAutomationList);
  const isAdmin = useIsAdmin();
  const available = (query.data ?? []).filter(
    (automation) => !automationIds.includes(automation.id),
  );
  return (
    <div className="flex flex-col gap-3">
      {query.error && <ErrorText text={query.error} />}
      {automationIds.map((id) => {
        const automation = query.data?.find((automation) => automation.id === id);
        return (
          <div key={id} className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
            <p className="font-medium">{automation?.title ?? "Unavailable automation"}</p>
            <p className="whitespace-pre-wrap text-muted-foreground">{automation?.prompt}</p>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => onChange(automationIds.filter((other) => other !== id))}
            >
              Remove
            </Button>
          </div>
        );
      })}
      <Select
        value={null}
        disabled={disabled || available.length === 0}
        onValueChange={(value) => {
          if (typeof value === "string") onChange([...automationIds, value]);
        }}
      >
        <SelectTrigger aria-label="Add automation">
          <SelectValue placeholder="Add automation" />
        </SelectTrigger>
        <SelectPopup>
          {available.map((automation) => (
            <SelectItem key={automation.id} value={automation.id}>
              {automation.title}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {isAdmin && (
        <Link to="/settings/automations" className="text-sm text-muted-foreground underline">
          Manage automations
        </Link>
      )}
    </div>
  );
}
