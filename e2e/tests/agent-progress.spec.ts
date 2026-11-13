import { test as base, expect } from "../fixtures.ts";
import { startAgentApp } from "../agent-app.ts";
import {
  addStepMembers,
  chooseOption,
  createProject,
  createWorkflow,
  nameOrganization,
  saveSteps,
  startItem,
} from "../actions.ts";

const test = base.extend<{ agentApp: Awaited<ReturnType<typeof startAgentApp>> }>({
  // Playwright requires destructuring even for fixtures without dependencies.
  // eslint-disable-next-line no-empty-pattern
  agentApp: async ({}, use) => {
    const app = await startAgentApp();
    try {
      await use(app);
    } finally {
      await app.close();
    }
  },
  baseURL: async ({ agentApp }, use) => use(agentApp.url),
  // This fixture already owns a whole app and database for each test.
  extraHTTPHeaders: {},
});

test("agents report live progress on steps and settings, retaining reports per run", async ({
  agentApp,
  signIn,
}) => {
  const page = await signIn("ada@example.test");
  await nameOrganization(page);
  await page.goto("/settings/automations");
  await page.getByRole("button", { name: "New automation" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Check order");
  await page.getByLabel("Prompt", { exact: true }).fill("Check invoices and purchase orders.");
  await page.getByRole("button", { name: "Create automation" }).click();
  await expect(page.getByRole("heading", { name: "Check order", exact: true })).toBeVisible();

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
  await settings.goto("/settings/automations");
  await expect(settings.getByRole("heading", { name: "Check order", exact: true })).toBeVisible();

  const automations = page.getByRole("complementary", { name: "Automations" });
  await automations.getByRole("button", { name: "Not run yet. Run" }).click();
  const first = await agentApp.nextExecution();
  expect(
    first.request.agent.capabilities.some((capability) =>
      capability.note?.includes("when you start work"),
    ),
  ).toBe(true);
  expect(agentApp.readReports(first)).toBeNull();
  await expect(automations.getByRole("button", { name: "Running. Stop" })).toBeVisible();
  const history = page.getByRole("complementary", { name: "History" });
  await expect(history.getByText("ran “Check order”")).toBeVisible();
  expect((await agentApp.report(first, "Checking invoices")).isError).not.toBe(true);
  await expect(automations.getByText("Checking invoices", { exact: true })).toBeVisible();
  await expect(settings.getByText("Checking invoices", { exact: true })).toBeVisible();
  expect((await agentApp.report(first, "Matching purchase orders")).isError).not.toBe(true);
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

  await automations.getByRole("button", { name: "Running. Stop" }).click();
  await expect(automations.getByRole("button", { name: "Run", exact: true })).toBeVisible();
  await expect(history.getByText("stopped “Check order”")).toBeVisible();
  expect((await agentApp.report(first, "Late report")).isError).toBe(true);
  expect(agentApp.readReports(first)).toBe(reports);

  // A manual run uses the same tool and gets its own reports, while the step keeps its run.
  await settings.getByRole("button", { name: "Actions for Check order" }).click();
  await settings.getByRole("menuitem", { name: "Run now", exact: true }).click();
  const second = await agentApp.nextExecution();
  expect(second.request.rootId).not.toBe(first.request.rootId);
  expect(agentApp.readReports(second)).toBeNull();
  expect((await agentApp.report(second, "Checking a new order")).isError).not.toBe(true);
  await expect(settings.getByText("Checking a new order", { exact: true })).toBeVisible();
  await automations.getByRole("button", { name: "1 earlier run" }).click();
  await expect(automations.getByText("Matching purchase orders", { exact: true })).toBeVisible();
  await expect(automations.getByText("Checking a new order", { exact: true })).toHaveCount(0);
  second.finish();
  await expect(settings.getByText(/Last run: Ended/u)).toBeVisible();
  await expect(settings.getByText("Checking a new order", { exact: true })).toBeVisible();
  expect((await agentApp.report(second, "After completion")).isError).toBe(true);
});
