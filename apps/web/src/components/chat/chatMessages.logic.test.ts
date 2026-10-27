import { WORKFLOW_DRAFT_TOOL_NAME } from "@t45/contracts/resources/AgentTools";
import { describe, expect, it } from "vite-plus/test";

import { assistantMessage, nativeMessage, userMessage } from "../../state/chats.testkit";
import type { NativeToolPart } from "../../state/chats";
import {
  betweenTurns,
  isShownMessage,
  promptHistoryOf,
  subagentSessionId,
  toolLabel,
  toolOutputText,
  userMessageContent,
  workflowDraftOf,
} from "./chatMessages.logic";

const attachment = {
  type: "file",
  id: "00000000-0000-4000-8000-000000000001.pdf",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 12,
};

function toolPart(part: Record<string, unknown>): NativeToolPart {
  const message = assistantMessage("msg_tool", [
    { type: "tool", id: "call_1", name: "bash", time: { created: 1 }, ...part },
  ]).message;
  if (message.type !== "assistant" || message.content[0]?.type !== "tool") {
    throw new Error("Expected a tool part.");
  }
  return message.content[0];
}

describe("userMessageContent", () => {
  it("shows what the member wrote, with the files and chips T45 kept on the message", () => {
    const message = userMessage("msg_1", "rewritten for the agent", {
      metadata: {
        t45: {
          text: "Summarize [report.pdf](t45-context:file/ctx-1)",
          attachments: [attachment],
          context: {
            records: [
              {
                contextId: "ctx-1",
                label: "report.pdf",
                kind: "file",
                attachmentId: "00000000-0000-4000-8000-000000000001.pdf",
                name: "report.pdf",
                mimeType: "application/pdf",
                sizeBytes: 12,
              },
            ],
          },
        },
      },
    }).message;
    if (message.type !== "user") throw new Error("Expected a user message.");
    const content = userMessageContent(message);
    expect(content.text).toBe("Summarize [report.pdf](t45-context:file/ctx-1)");
    expect(content.attachments).toEqual([attachment]);
    expect(content.context?.records.map((record) => record.contextId)).toEqual(["ctx-1"]);
  });

  it("reads a message T45 didn't send as OpenCode keeps it", () => {
    const message = userMessage("msg_1", "plain", {
      metadata: { t45: { attachments: [attachment], context: "not a context" } },
    }).message;
    if (message.type !== "user") throw new Error("Expected a user message.");
    expect(userMessageContent(message)).toEqual({
      text: "plain",
      attachments: [],
      context: undefined,
    });
  });

  it("recalls the member's own words, oldest first", () => {
    expect(
      promptHistoryOf([
        userMessage("msg_1", "agent text", {
          metadata: { t45: { text: "first", attachments: [] } },
        }),
        assistantMessage("msg_2", [{ type: "text", text: "reply" }]),
        userMessage("msg_3", "second"),
      ]),
    ).toEqual([
      { id: "msg_1", text: "first" },
      { id: "msg_3", text: "second" },
    ]);
  });
});

describe("betweenTurns", () => {
  it("is between turns before the first and after each, and after T45's notes", () => {
    const idle = nativeMessage({ id: "msg_2", type: "idle", outcome: "succeeded" });
    expect(betweenTurns([])).toBe(true);
    expect(betweenTurns([userMessage("msg_1", "hi"), idle])).toBe(true);
    expect(
      betweenTurns([
        idle,
        nativeMessage({
          id: "msg_3",
          type: "synthetic",
          text: "The sandbox restarted.",
          metadata: { t45: { note: "restore" } },
        }),
      ]),
    ).toBe(true);
    expect(betweenTurns([idle, userMessage("msg_4", "go")])).toBe(false);
    expect(
      betweenTurns([idle, nativeMessage({ id: "msg_5", type: "synthetic", text: "report" })]),
    ).toBe(false);
  });
});

describe("isShownMessage", () => {
  it("shows turns that ended badly and live or failed replies, not quiet bookkeeping", () => {
    expect(
      isShownMessage(nativeMessage({ id: "msg_1", type: "idle", outcome: "interrupted" })),
    ).toBe(true);
    expect(isShownMessage(nativeMessage({ id: "msg_2", type: "idle", outcome: "succeeded" }))).toBe(
      false,
    );
    expect(isShownMessage(assistantMessage("msg_3", [], { state: "live", completed: false }))).toBe(
      true,
    );
    expect(isShownMessage(assistantMessage("msg_4", []))).toBe(false);
  });
});

describe("tool parts", () => {
  it("labels a call by its name and what it acted on", () => {
    expect(
      toolLabel(
        toolPart({
          state: { status: "running", input: { command: "ls -la\nmore" }, metadata: {} },
        }),
      ),
    ).toEqual({ name: "bash", subject: "ls -la" });
  });

  it("shows the output of a finished call and the error of a failed one", () => {
    expect(
      toolOutputText(
        toolPart({
          state: {
            status: "completed",
            input: {},
            content: [
              { type: "text", text: "done" },
              { type: "file", uri: "file:///work/a.txt", mime: "text/plain", name: "a.txt" },
            ],
          },
        }),
      ),
    ).toBe("done\n[a.txt]");
    expect(
      toolOutputText(
        toolPart({
          state: {
            status: "error",
            input: {},
            error: { type: "unknown", message: "permission denied" },
          },
        }),
      ),
    ).toBe("permission denied");
  });

  it("finds the session a subagent call runs in", () => {
    expect(
      subagentSessionId(
        toolPart({
          name: "subagent",
          state: { status: "running", input: {}, metadata: { sessionID: "ses_child" } },
        }),
      ),
    ).toBe("ses_child");
  });

  it("reads a finished workflow draft, and leaves a refused one a tool call", () => {
    const draft = { name: "Onboarding", steps: [] };
    expect(
      workflowDraftOf(
        toolPart({
          name: WORKFLOW_DRAFT_TOOL_NAME,
          state: {
            status: "completed",
            input: draft,
            content: [{ type: "text", text: "drafted" }],
          },
        }),
      ),
    ).toEqual(draft);
    expect(
      workflowDraftOf(
        toolPart({
          name: WORKFLOW_DRAFT_TOOL_NAME,
          state: {
            status: "error",
            input: draft,
            error: { type: "unknown", message: "invalid" },
          },
        }),
      ),
    ).toBeNull();
  });

  it("bounds the input of a running call before encoding it", () => {
    const preview = toolOutputText(
      toolPart({
        state: {
          status: "running",
          input: { items: Array.from({ length: 50 }, (_, index) => index) },
          metadata: {},
        },
      }),
    );
    expect(JSON.parse(preview).items).toHaveLength(21);
  });
});
