import { expect } from "../fixtures.ts";
import { test } from "../agent-app.ts";
import {
  addStepMembers,
  chooseOption,
  createProject,
  createWorkflow,
  nameOrganization,
  saveSteps,
  startItem,
} from "../actions.ts";

test("agents report live progress on steps and settings, retaining reports per run", async ({
  agentApp,
  signIn,
}) => {
  const page = await signIn("ada@example.test");
  await nameOrganization(page);
  await page.goto("/settings/automations/runs");
  await page.getByRole("button", { name: "New automation" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Check order");
  await page.getByLabel("Prompt", { exact: true }).fill("Check invoices and purchase orders.");
  await page.getByRole("button", { name: "Create automation" }).click();
  await expect(page.getByRole("button", { name: "Check order", exact: true })).toBeVisible();

  const workflowId = await createWorkflow(page, "Orders");
  await page.getByRole("button", { name: "Add step" }).click();
  await page.getByLabel("Step title").fill("Collect");
  await chooseOption(page, "Add automation", "Check order");
  await saveSteps(page);
  const projectId = await createProject(page, workflowId);
  await addStepMembers(page, "Collect", ["ada"]);
  await page.getByRole("button", { name: "Adopt", exact: true }).click();
  await expect(page.getByText("New tickets start on version 1")).toBeVisible();
  await startItem(page, projectId, "Order 7");
  const settings = await page.context().newPage();
  await settings.goto("/settings/automations/runs");
  await settings.getByRole("button", { name: "Check order", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Check order", exact: true })).toBeVisible();

  const automations = page.getByRole("complementary", { name: "Automations" });
  await automations.getByRole("button", { name: "Run Automation", exact: true }).click();
  await page.getByRole("button", { name: "Run automation", exact: true }).click();
  const first = await agentApp.nextExecution();
  expect(
    first.request.agent.capabilities.some((capability) =>
      capability.note?.includes("when you start work"),
    ),
  ).toBe(true);
  expect(agentApp.readReports(first)).toBeNull();
  await expect(automations.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  const history = page.getByRole("complementary", { name: "History" });
  await expect(history.getByText("ran “Check order”")).toBeVisible();
  expect((await agentApp.report(first, "Checking invoices")).isError).not.toBe(true);
  await expect(automations.getByText("Checking invoices", { exact: true })).toBeVisible();
  await expect(settings.getByText("Checking invoices", { exact: true })).toBeVisible();
  // Settings list the run under its ticket, which opens the step.
  await expect(settings.getByRole("link", { name: "Order 7", exact: true })).toBeVisible();

  // The run's number opens its page: how it stands, then its reports, tool calls and session.
  await automations.getByRole("link", { name: "#1", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check order #1", level: 2 })).toBeVisible();
  const summary = page.getByRole("region", { name: "Summary" });
  await expect(summary).toContainText("Manually triggered");
  await expect(summary).toContainText("Running");
  const rows = page.getByRole("tabpanel").getByRole("listitem");
  await expect(rows).toHaveText([/^Checking invoices/u]);
  const at = 1_790_000_000_000;
  first.emit({
    _tag: "messages",
    sessionId: first.request.rootId,
    messages: [
      {
        id: "msg_a1",
        type: "assistant",
        agent: "build",
        model: { providerID: "opencode-go", id: "test-model" },
        content: [
          {
            type: "tool",
            id: "call_1",
            name: "skill",
            state: {
              status: "completed",
              input: { id: "read-documents" },
              content: [{ type: "text", text: "Loaded." }],
            },
            time: { created: at, completed: at },
          },
          { type: "text", text: "Both documents match." },
        ],
        cost: 0.5,
        tokens: { input: 1200, output: 300, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: at, completed: at },
      },
    ],
  });
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await expect(page.getByText('You contribute to the step "Collect"')).toBeVisible();
  await expect(page.getByText("Both documents match.")).toBeVisible();
  await page.getByRole("tab", { name: "Tool calls", exact: true }).click();
  await expect(rows).toHaveText([/skill\{"id":"read-documents"\}$/u]);
  expect((await agentApp.report(first, "Matching purchase orders")).isError).not.toBe(true);
  await page.getByRole("tab", { name: "Reports", exact: true }).click();
  await expect(rows).toHaveText([/^Checking invoices/u, /^Matching purchase orders/u]);
  // The report refreshed the step, which carries what the run used.
  await expect(summary).toContainText("1.5K");
  await expect(summary).toContainText("$0.50");
  await page.getByRole("link", { name: "Order 7", exact: true }).click();
  await expect(automations.getByText("Matching purchase orders", { exact: true })).toBeVisible();
  await expect(settings.getByText("Matching purchase orders", { exact: true })).toBeVisible();
  await expect(automations.getByText("Checking invoices", { exact: true })).toHaveCount(0);
  await page.reload();
  await settings.reload();
  await expect(automations.getByText("Matching purchase orders", { exact: true })).toBeVisible();
  await expect(settings.getByText("Matching purchase orders", { exact: true })).toBeVisible();
  const reports = agentApp.readReports(first);
  expect(typeof reports).toBe("string");
  expect(JSON.parse(String(reports))).toEqual([
    { message: "Checking invoices", at: expect.any(String) },
    { message: "Matching purchase orders", at: expect.any(String) },
  ]);

  await automations.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(automations.getByRole("img", { name: "Stopped" })).toBeVisible();
  await expect(history.getByText("stopped “Check order”")).toBeVisible();
  expect((await agentApp.report(first, "Late report")).isError).toBe(true);
  expect(agentApp.readReports(first)).toBe(reports);

  // A manual run uses the same tool and gets its own reports, while the step keeps its run.
  await settings.getByRole("button", { name: "Check order", exact: true }).click();
  await settings.getByRole("button", { name: "Actions for Check order" }).click();
  await settings.getByRole("menuitem", { name: "Run now", exact: true }).click();
  const second = await agentApp.nextExecution();
  expect(second.request.rootId).not.toBe(first.request.rootId);
  expect(agentApp.readReports(second)).toBeNull();
  expect((await agentApp.report(second, "Checking a new order")).isError).not.toBe(true);
  await expect(settings.getByText("Checking a new order", { exact: true })).toBeVisible();
  await expect(automations.getByText("Matching purchase orders", { exact: true })).toBeVisible();
  await expect(automations.getByText("Checking a new order", { exact: true })).toHaveCount(0);
  second.finish();
  await expect(settings.getByRole("img", { name: "Completed" })).toBeVisible();
  await expect(settings.getByText("Checking a new order", { exact: true })).toBeVisible();
  expect((await agentApp.report(second, "After completion")).isError).toBe(true);

  // A run that fails says why, where it shows what it is doing.
  await settings.getByRole("button", { name: "Actions for Check order" }).click();
  await settings.getByRole("menuitem", { name: "Run now", exact: true }).click();
  const third = await agentApp.nextExecution();
  third.fail("The agent's tools didn't connect within a minute: collections (failed: no schema).");
  await expect(settings.getByRole("img", { name: "Failed" })).toBeVisible();
  await expect(
    settings.getByText(
      "Failed: The agent's tools didn't connect within a minute: collections (failed: no schema).",
      { exact: true },
    ),
  ).toBeVisible();
});
