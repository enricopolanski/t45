import type { Page } from "@playwright/test";

import {
  addStepMembers,
  chooseOption,
  createProject,
  createWorkflow,
  nameOrganization,
  saveSteps,
  startItem,
} from "../actions.ts";
import { test } from "../agent-app.ts";
import { expect } from "../fixtures.ts";

const saveListing = async (page: Page, key: string, title: string) => {
  await page.getByRole("button", { name: "New record" }).click();
  const dialog = page.getByRole("dialog", { name: "Record", exact: true });
  await dialog.getByLabel("Key", { exact: true }).fill(key);
  await dialog.getByLabel("Product title", { exact: true }).fill(title);
  await dialog.getByRole("button", { name: "Save record" }).click();
  await expect(dialog).toHaveCount(0);
};

test("agents only propose a reviewed field's values, which members approve or discard one by one", async ({
  agentApp,
  signIn,
}) => {
  const ada = await signIn("ada@example.test");
  await nameOrganization(ada);
  await ada.goto("/settings/collections/new");
  await ada.getByLabel("Title", { exact: true }).fill("Listings");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label", { exact: true }).fill("Product title");
  await ada.getByRole("button", { name: "Create collection" }).click();
  await expect(ada.getByRole("heading", { name: "Listings", level: 1 })).toBeVisible();
  await saveListing(ada, "B0AAA", "Masking tape 50 m");
  await saveListing(ada, "B0BBB", "Crepe tape 50 m");

  await ada.goto("/settings/automations/runs");
  await ada.getByRole("button", { name: "New automation" }).click();
  await ada.getByLabel("Name", { exact: true }).fill("Match listings");
  await ada.getByLabel("Prompt", { exact: true }).fill("Propose the listings that match.");
  await ada.getByRole("button", { name: "Create automation" }).click();
  await expect(ada.getByRole("button", { name: "Match listings", exact: true })).toBeVisible();

  const workflowId = await createWorkflow(ada, "Benchmark");
  await ada.getByRole("button", { name: "Add step" }).click();
  await ada.getByLabel("Step title").fill("Match");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label", { exact: true }).fill("Matches");
  await chooseOption(ada, "Type", "Collection records");
  await chooseOption(ada, "Collection", "Listings");
  await ada.getByRole("switch", { name: "Agents propose, members approve" }).click();
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label", { exact: true }).nth(1).fill("Brand");
  await ada.getByRole("switch", { name: "Agents propose, members approve" }).nth(1).click();
  await chooseOption(ada, "Add automation", "Match listings");
  await saveSteps(ada);
  const projectId = await createProject(ada, workflowId);
  await addStepMembers(ada, "Match", ["ada"]);
  await ada.getByRole("button", { name: "Adopt", exact: true }).click();
  await expect(ada.getByText("New tickets start on version 1")).toBeVisible();
  await startItem(ada, projectId, "Tape 50 m");

  const automations = ada.getByRole("complementary", { name: "Automations" });
  await automations.getByRole("button", { name: "Run Automation", exact: true }).click();
  await ada.getByRole("button", { name: "Run automation", exact: true }).click();
  const run = await agentApp.nextExecution();
  const tool = (name: string, args: Record<string, unknown>) =>
    agentApp.callTool(run, "step-tools.mjs", name, args);
  // The agent reads the fields' keys as get_step answers them.
  const { fields } = JSON.parse((await tool("get_step", {})).content[0]!.text) as {
    fields: Array<{ key: string; label: string; isReviewed?: boolean }>;
  };
  expect(fields.every((field) => field.isReviewed)).toBe(true);
  const keyOf = (label: string) => fields.find((field) => field.label === label)!.key;
  const refused = await tool("set_field", { fieldKey: keyOf("Matches"), value: ["B0AAA"] });
  expect(refused.isError).toBe(true);
  expect(refused.content[0]!.text).toContain("propose_value");
  const propose = (fieldKey: string, value: string, score: number, whyYes: string) =>
    tool("propose_value", {
      fieldKey: keyOf(fieldKey),
      value,
      score,
      whyYes,
      whyNo: "Another brand.",
    });
  for (const proposed of [
    await propose("Matches", "B0AAA", 60, "Same length, paper backing."),
    await propose("Matches", "B0BBB", 90, "Same width and length."),
    await propose("Brand", "Tesa", 70, "The supplier's sheet names Tesa."),
  ])
    expect(proposed.isError).not.toBe(true);

  // The best fit comes first, with the record it would link.
  await ada.getByRole("button", { name: "Review (3)" }).click();
  const review = ada.getByRole("dialog", { name: "Review" });
  await expect(review.getByRole("heading", { name: "B0BBB" })).toBeVisible();
  await expect(review.getByText("Fit 90%")).toBeVisible();
  await expect(
    review.getByRole("region", { name: "Why it fits" }).getByText("Same width and length."),
  ).toBeVisible();
  await review.getByRole("button", { name: "Approve" }).click();
  await expect(review.getByText("Tesa", { exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Approve" }).click();
  await expect(review.getByRole("heading", { name: "B0AAA" })).toBeVisible();
  await review.getByRole("button", { name: "Discard" }).click();
  await expect(review).toHaveCount(0);

  const matches = ada.getByRole("table", { name: "Matches" });
  await expect(matches.getByRole("row", { name: "Record B0BBB" })).toBeVisible();
  await expect(matches.getByRole("row", { name: "Record B0AAA" })).toHaveCount(0);
  await expect(ada.getByLabel("Brand", { exact: true })).toHaveValue("Tesa");
  await expect(ada.getByRole("button", { name: /^Review/ })).toHaveCount(0);
  const history = ada.getByRole("complementary", { name: "History" });
  await expect(history.getByText("proposed 3 values")).toBeVisible();
  await expect(history.getByText("discarded a proposal")).toBeVisible();

  // A discarded value is never proposed again.
  const again = await propose("Matches", "B0AAA", 60, "Same length.");
  expect(again.isError).toBe(true);
  expect(again.content[0]!.text).toContain("discarded");
});
