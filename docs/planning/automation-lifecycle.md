# Automation lifecycle plan

Scope: remove the separate task outcome lifecycle, preserve automation transcripts, and notify the assignee when execution ends—including manual stop.

Acceptance criteria: [automation-lifecycle.feature](automation-lifecycle.feature).

## 1. Remove task outcomes

- Remove `TaskState`, `Outcome`, `step_submit_task` and `step_give_up`.
- Keep the chat execution status and origin association.
- Let MCP tools return the actual result of field, comment and attachment operations. Remove automatic failure comments and failure notices.
- Keep step completion under the existing workflow rules; ending an automation does not complete its step.

Files: [Task.ts](../../packages/contracts/src/models/Task.ts), [AgentTools.ts](../../packages/contracts/src/resources/AgentTools.ts), [TaskService.ts](../../apps/server/src/tasks/TaskService.ts), [WorkflowService.ts](../../apps/server/src/workflows/WorkflowService.ts), [step-tools.ts](../../apps/server/src/agent-tools/step-tools.ts), [Schema.ts](../../apps/server/src/persistence/Schema.ts).

## 2. Preserve transcripts

- Remove settlement-triggered chat deletion and cleanup. Retain stored messages, sessions, inputs, saved disk and associated files after an automation ends or is stopped.
- Keep stopping execution separate from deleting its stored conversation.

Trace the existing deletion path through [TaskService.ts](../../apps/server/src/tasks/TaskService.ts), [ChatService.ts](../../apps/server/src/chats/ChatService.ts), [ChatExecutions.ts](../../apps/server/src/chats/ChatExecutions.ts) and [ChatRepository.ts](../../apps/server/src/chats/ChatRepository.ts).

## 3. Notify when execution ends

- Replace the failure notice with a neutral “Automation ended” notification.
- Send it on normal completion and manual stop.
- If the step has no assignee, create no notification.
- Route completion and stop through shared handling so the same ending does not notify twice.
- Update the existing notification and automation status labels.

Files: [ChatService.ts](../../apps/server/src/chats/ChatService.ts), [ChatExecutions.ts](../../apps/server/src/chats/ChatExecutions.ts), [WorkflowService.ts](../../apps/server/src/workflows/WorkflowService.ts), [Notification.ts](../../packages/contracts/src/models/Notification.ts), [NotificationRepository.ts](../../apps/server/src/workflows/NotificationRepository.ts), [NotificationBell.tsx](../../apps/web/src/components/work/NotificationBell.tsx), [AutomationRepository.ts](../../apps/server/src/automations/AutomationRepository.ts).

## Verification

Verify that normal completion and manual stop retain the stored conversation, notify an assigned person, and produce no notification for an unassigned step. Verify that MCP refusals reach the agent and execution ending leaves step completion to the workflow. Update affected existing checks and run the repository validation before completing implementation.
