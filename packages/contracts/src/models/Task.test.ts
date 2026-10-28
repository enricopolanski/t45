import { assert, describe, it } from "@effect/vitest";

import { taskExecution, type TaskState } from "./Task.ts";

const active: TaskState = { type: "active" };
const running = { status: "running" as const, awake: true, queued: false, stopping: false };

describe("task execution", () => {
  it("distinguishes queued work, processing and interrupted work without changing task progress", () => {
    assert.equal(taskExecution(active, { ...running, awake: false, queued: true }), "starting");
    assert.equal(taskExecution(active, { ...running, queued: true }), "starting");
    assert.equal(taskExecution(active, running), "processing");
    assert.equal(
      taskExecution(active, { ...running, status: "interrupted", awake: false }),
      "stopped",
    );
    assert.equal(taskExecution(active, { ...running, status: null }), "stopped");
    assert.equal(taskExecution(active, null), "stopped");
  });

  it("stops showing processing as soon as a stop is requested and reports failed starts", () => {
    assert.equal(taskExecution(active, { ...running, stopping: true }), "stopped");
    assert.equal(taskExecution(active, { ...running, status: "failed", queued: true }), "failed");
    assert.equal(taskExecution(active, { ...running, status: "waiting" }), "waiting");
  });

  it("keeps submitted and settled results when their worker stops or its VM disappears", () => {
    assert.equal(
      taskExecution({ type: "submitted" }, { ...running, status: "interrupted" }),
      "finished",
    );
    assert.equal(taskExecution({ type: "submitted" }, null), "finished");
    assert.equal(
      taskExecution({ type: "settled", outcome: { type: "succeeded" } }, null),
      "finished",
    );
    assert.equal(
      taskExecution(
        { type: "settled", outcome: { type: "failed", reason: "Missing source" } },
        running,
      ),
      "failed",
    );
    assert.equal(
      taskExecution(
        { type: "settled", outcome: { type: "cancelled", reason: "Stopped" } },
        running,
      ),
      "stopped",
    );
  });
});
