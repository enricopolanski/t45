import { Refused as AgentRefused } from "@t45/contracts/models/Agent";
import { Refused as ChatRefused } from "@t45/contracts/models/Chat";
import { Refused as AutomationRefused } from "@t45/contracts/models/Automation";
import { Refused as SkillRefused } from "@t45/contracts/models/Skill";
import { Refused as UserRefused } from "@t45/contracts/models/User";
import { Refused as WorkflowRefused } from "@t45/contracts/models/Workflow";
import { AccessDenied, NotFound } from "@t45/contracts/resources/errors";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { HttpClientError } from "effect/http";
import { RpcClientError } from "effect/rpc";

const isRefusal = Schema.is(
  Schema.Union([
    AgentRefused,
    ChatRefused,
    AutomationRefused,
    SkillRefused,
    UserRefused,
    WorkflowRefused,
    AccessDenied,
  ]),
);
export const isNotFound = Schema.is(NotFound);
export const isRpcClientError = Schema.is(RpcClientError.RpcClientError);
const isHttpTransportError = (error: unknown) =>
  HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError";

const SERVER_FAILED = "Something went wrong on the server.";

export function describeFailure(failure: unknown, fallback = SERVER_FAILED): string {
  const error = Cause.isCause(failure) ? Cause.squash(failure) : failure;
  if (isRefusal(error)) return error.message;
  if (isNotFound(error)) return "That no longer exists.";
  if (isRpcClientError(error) || isHttpTransportError(error)) return "Couldn't reach the server.";
  return fallback;
}

const UPLOAD_REFUSALS: Partial<Record<number, string>> = {
  400: "That file can't be attached here.",
  401: "Your session ended. Sign in again.",
  403: "You do not have permission to do that.",
  413: "The file is too large to upload.",
};

export const describeUploadRefusal = (status: number) => UPLOAD_REFUSALS[status] ?? SERVER_FAILED;

/** An error's message for display, or `fallback` when it has none. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}
