import { STEP_TOOLS_MCP } from "@t45/core/agentTools";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { assignableActors, formatDueDate, type WorkDirectory } from "./workLogic";

const at = DateTime.makeUnsafe("2026-10-13T12:00:00Z");

describe("formatDueDate", () => {
  it("leaves the year out for this year's dates only", () => {
    const year = new Date().getFullYear();
    expect(formatDueDate(`${year}-10-27`)).not.toContain(String(year));
    expect(formatDueDate(`${year + 1}-01-05`)).toContain(String(year + 1));
  });
});

describe("assignableActors", () => {
  const stepTools = { [STEP_TOOLS_MCP.name]: STEP_TOOLS_MCP.server };
  const directory: WorkDirectory = {
    people: [
      {
        id: "anna",
        displayName: "Anna",
        email: "anna@example.test",
        state: "active",
        role: "member",
        avatarColor: "slate",
        avatarContentType: null,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "gone",
        displayName: "Gone",
        email: "gone@example.test",
        state: "deactivated",
        role: "member",
        avatarColor: "slate",
        avatarContentType: null,
        createdAt: at,
        updatedAt: at,
      },
    ],
    agents: [
      {
        id: "timesheets",
        name: "Timesheets",
        status: "active",
        mcpServers: stepTools,
      },
      {
        id: "old",
        name: "Old",
        status: "archived",
        mcpServers: stepTools,
      },
      { id: "plain", name: "Plain", status: "active", mcpServers: {} },
      {
        id: "chatter",
        name: "Chatter",
        status: "active",
        mcpServers: stepTools,
      },
    ],
  };

  it("offers only people and agents who can take work", () => {
    expect(
      [...assignableActors(directory, "person"), ...assignableActors(directory, "agent")].map(
        (actor) => [actor.id, actor.label],
      ),
    ).toEqual([
      ["anna", "Anna"],
      ["timesheets", "Timesheets"],
      ["chatter", "Chatter"],
    ]);
  });
});
