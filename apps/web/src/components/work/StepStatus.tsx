import type { StepView } from "@t45/contracts/resources/Workflows";
import { ChevronDownIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { api } from "../../rpc/api";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ReasonDialog } from "./ReasonDialog";
import { type StepAct, type StepActions, stepStatus } from "./workLogic";

const REASONS = {
  block: {
    title: "Block this step",
    placeholder: "What it's waiting for",
    confirmLabel: "Block",
    send: (view: StepView, reason: string) =>
      api("workflows.blockStep", { stepId: view.step.id, reason }),
  },
  reject: {
    title: "Request changes",
    placeholder: "What needs fixing",
    confirmLabel: "Request changes",
    send: (view: StepView, reason: string) =>
      api("workflows.rejectStep", { stepId: view.step.id, reason }),
  },
  cancel: {
    title: "Cancel this item",
    placeholder: "Why it stops here",
    confirmLabel: "Cancel item",
    send: (view: StepView, reason: string) =>
      api("workflows.cancelTicket", { ticketId: view.ticket.id, reason }),
  },
};

/**
 * The open step's status, like a ticket's: a button naming where it stands that opens the moves
 * the viewer can make from there. Those who oversee the workflow also cancel the item there, and
 * reopen it once cancelled. Without a move to make, the status shows as a badge.
 */
export function StepStatus({
  view,
  actions,
  busy,
  act,
  onMarkDone,
}: {
  readonly view: StepView;
  readonly actions: StepActions;
  readonly busy: boolean;
  readonly act: StepAct;
  readonly onMarkDone: () => void;
}) {
  const stepId = view.step.id;
  const { ticket: item } = view;
  const status =
    item.status.type === "cancelled"
      ? ({ label: "Cancelled", variant: "error" } as const)
      : item.status.type === "done"
        ? ({ label: "Done", variant: "success" } as const)
        : stepStatus(view.step);
  const [asking, setAsking] = useState({ reason: "block" as keyof typeof REASONS, open: false });
  const ask = (reason: keyof typeof REASONS) => setAsking({ reason, open: true });
  const groups = [
    [
      actions.canMarkDone && (
        <MenuItem key="done" onClick={onMarkDone}>
          Mark done
        </MenuItem>
      ),
      actions.canApprove && (
        <MenuItem
          key="approve"
          onClick={() => void act(() => api("workflows.approveStep", { stepId }))}
        >
          Approve
        </MenuItem>
      ),
    ],
    [
      actions.canBlock && (
        <MenuItem key="block" onClick={() => ask("block")}>
          Block
        </MenuItem>
      ),
      actions.canUnblock && (
        <MenuItem
          key="unblock"
          onClick={() => void act(() => api("workflows.unblockStep", { stepId }))}
        >
          Unblock
        </MenuItem>
      ),
    ],
    [
      actions.canReject && (
        <MenuItem key="reject" onClick={() => ask("reject")}>
          Request changes
        </MenuItem>
      ),
    ],
    [
      actions.canCancelTicket && (
        <MenuItem key="cancel" variant="destructive" onClick={() => ask("cancel")}>
          Cancel item
        </MenuItem>
      ),
      actions.canReopenTicket && (
        <MenuItem
          key="reopen"
          onClick={() => void act(() => api("workflows.reopenTicket", { ticketId: item.id }))}
        >
          Reopen item
        </MenuItem>
      ),
    ],
  ]
    .map((group) => group.filter((entry) => entry !== false))
    .filter((group) => group.length > 0);
  if (groups.length === 0) {
    return (
      <div>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>
    );
  }
  const reason = REASONS[asking.reason];
  return (
    <div>
      <Menu>
        <MenuTrigger
          disabled={busy}
          aria-label={`Status: ${status.label}. Change`}
          render={<Button size="sm" />}
        >
          {status.label}
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="start">
          {groups.map((group) => (
            <Fragment key={group[0]?.key}>
              {group === groups[0] ? null : <MenuSeparator />}
              {group}
            </Fragment>
          ))}
        </MenuPopup>
      </Menu>
      <ReasonDialog
        key={asking.reason}
        open={asking.open}
        onOpenChange={(open) => setAsking({ ...asking, open })}
        title={reason.title}
        placeholder={reason.placeholder}
        confirmLabel={reason.confirmLabel}
        onConfirm={(text) => act(() => reason.send(view, text), true)}
      />
    </div>
  );
}
