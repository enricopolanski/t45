# Workflows

The model and its rules are specified in [`workflows.feature`](../planning/workflows/workflows.feature). This page holds what the source doesn't make obvious.

## One service, four repositories

Everything workflows do lives in [`WorkflowService.ts`](../../apps/server/src/workflows/WorkflowService.ts), which supplies TaskService with its step hooks and `UserService` with its deactivation handler; the `Workflows`, `Assignments` and `Notifications` handlers only pass the current user to it. Storage is four repositories, one per aggregate: definitions, workflows (with their admins and default assignments as JSON), tickets (with their steps and each step's values as JSON, plus step comments) and notifications. Every command is one transaction, `TicketRepository.transaction`, which also takes in the notifications and Task commands; a command loads its ticket, changes it in memory and saves it whole at the end.

## People are resolved on entry

A ticket's step snapshots its automation entries and takes its human assignee and responsible when the ticket enters it, and keeps them: later changes to the workflow's default assignments only reach steps entered afterwards. The assignee is the step's default one, else whoever held the previous step (the parent, for a sub-step); the responsible is the step's default one, else the workflow's, so a step's responsible is never empty once entered. Anyone who can no longer take work (a deactivated person) is replaced on entry, and again whenever a step goes back to work: reject and reopen. A gone assignee falls to the step's responsible, a gone step responsible to the workflow's, and a gone workflow responsible to the workflow's longest-serving active admin, the first active one in `adminUserIds`. A workflow always has one: its last active admin can't be removed, and can't be deactivated until it has another. Warnings that a workflow names someone gone go to its active admins. Completed steps keep the person who did them on record.

## Organization admins are admins of every workflow

A workflow's listed admins are equal, and the last active one can't be removed. The organization's admins pass every admin check without being listed; there is no transfer. A definition is changed only by the admins of every workflow that runs it, since its steps move all of their tickets.

Whoever is involved in a ticket may do anything with it: those who hold one of its steps, and those who oversee the workflow (its admins and its responsible, `oversees`). Only a step's responsible approves or rejects it. A public workflow's board and tickets are readable by every member, who can't change them. Boards are otherwise for those who oversee the workflow, and changing it stays with its admins. The Workflows list carries `canManage` so the responsible gets the board without Edit.

## Deactivation hands work on in the same transaction

`UserService` requires `WorkflowService`'s deactivation handler when it is constructed and runs it inside the deactivation's transaction, after the member's state changes, so a refusal or a failing handler keeps the member active. The handler only hands work to people, so it never hands a step to an agent.

## Values are stored per field, by path

A step's `values` are keyed by field path: the field ids from the step down, joined by dots, with a row id after each repeatable group (`variants.row-1a2b.width`). A repeatable group's own key holds its row ids in order; saving fewer ids clears the values and files of the rows left out. A file field's value is its attachment's id. Dots never appear in ids, so a path splits back into its ids unambiguously.

## Step files are attachments

A step's files live in the [one attachment store](./providers.md#attachments), held by the step (`step_id`, and `field_key` when the file is a field's value). A file is uploaded as any attachment is and then attached by id, which gives the step the actor's own pending upload and refuses any other, so an id never moves a file someone else holds. Replacing or removing a file, saving fewer group rows and saving steps without its field take the file off its step: a chat it was sent to keeps it, and a file no chat holds is deleted. A file held by a step is readable by whoever may read its ticket.

## Refusals belong to the models, verdicts to the views

Every workflow RPC fails with `Workflow.Refused` or `NotFound` ([`resources/Workflows.ts`](../../packages/contracts/src/resources/Workflows.ts)), and each refusal carries its own message, which the web shows as it is. A ticket the current user can't read answers `NotFound`, not a refusal, to every read and command on it and its steps, so these never tell anyone that it exists; the other checks (an open ticket, the step's status) refuse. Storage failures are defects and fail only the call that hit them. Commands answer nothing but what the web opens next (`workflows.createDefinition`'s `definitionId`, `workflows.createInstance`'s `workflowId`, `workflows.startTicket`'s `stepId`), and the web reads the view again after each.

Rules about one value are schema checks on the models (distinct field and step ids, a select's options), so a malformed definition never decodes. The verdicts a page shows travel in the views, such as `canOpenBoard`; the command guards stay the authority.

## Changing a definition moves open work atomically

A definition has one set of steps, with no drafts or versions: the editor's unsaved state is the draft, and `updateDefinition` replaces the steps whole. Saving moves every open ticket of every workflow running the definition onto the new steps in the same transaction, including the values and files of fields that are gone, step status changes, notifications, and Task commands, whose workers wake after commit. Stable step and field ids connect existing work to the new steps, so removing or moving a step an open ticket is in or has entered refuses the whole save; fields added to steps a ticket already completed stay empty.

Done and cancelled tickets keep their steps as they were. Step names aren't stored, so a step the definition no longer has shows under the workflow's name, and a field it no longer has keeps its value but isn't shown, having no label. Reopening a cancelled ticket moves it onto the current steps in the same transaction, the same way; a ticket that can't move stays cancelled. This keeps the board's invariant that every open ticket follows its definition's steps.

## Sub-steps are steps with a parent

A sub-step is a step with a `parentStepId`, so it reuses everything a step has: reassign, approval, agents, notifications, and My work. Every step comes from the definition; ticket-only sub-steps are not supported. Steps are appended on entry, so parents precede their children. The current step is the first incomplete top-level step; completing a sub-step stops there. Step ids are unique across a definition at every depth, which the schema checks.

## A ticket opens on one step

There is one page per ticket, and its URL is a step (`/my-work/$stepId`): every way in (My work, the board, notifications, sub-steps) already has a step, and the step view is where visibility is decided. The view carries the ticket's details, the other top-level steps and the open step's children.

An agent's brief carries the filled fields of the steps before its step (for a sub-step, before the step it sits in); which ones is not configurable, `carriedFields` decides it.

## Several automations can work one step

A human assignee and automation entries are independent. Entries have stable identities, so a step can run several tasks concurrently, including several for the same agent. Automations share the step's fields, comments and attachments. Entry edits cancel unfinished work before starting replacements; settled attempts remain history. Workflow defaults affect future steps; current steps keep their own entries.

The step stores no chat or task ids. TaskService finds tasks by ticket, step and automation entry. A task submits when its contribution is finished and releases its VM, independently of the shared step's completion. Complete fields and substeps plus submissions from all entries are required for automatic approval readiness. Approval settles success; whole-step rejection continues the same tasks internally. A stopped task stays active, blocking a step stops its active tasks, and unblocking continues them. Cancellation settles unfinished tasks; reopening starts new ones. Human completion can take over and cancel active tasks.

Step views stream committed ticket changes, including task state and applied results, under ticket visibility; task histories are not accessible as chats. Native tool receipts and the transaction boundary are described in [sandboxed chats](./sandboxed-chats.md).
