import type { ChatTarget } from "@t45/contracts/resources/Chats";
import type { WorkflowInstanceCall } from "@t45/contracts/resources/WorkflowInstanceTools";
import type { Refused } from "@t45/contracts/models/Workflow";
import type { NotFound } from "@t45/contracts/resources/errors";
import type * as Effect from "effect/Effect";

/** Bound at startup, after workflow services can use the chat/task services. */
export interface WorkflowChatHooks {
  readonly targets: (userId: string) => Effect.Effect<ReadonlyArray<ChatTarget>>;
  readonly name: (userId: string, workflowId: string) => Effect.Effect<string, NotFound>;
  readonly context: (userId: string, workflowId: string) => Effect.Effect<string, NotFound>;
  readonly execute: (
    userId: string,
    workflowId: string,
    call: WorkflowInstanceCall,
  ) => Effect.Effect<string, Refused | NotFound>;
}
