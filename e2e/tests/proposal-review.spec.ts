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
  await saveListing(ada, "source-19", "Supplier tape 19 mm x 50 m");
  await saveListing(ada, "source-38", "Supplier tape 38 mm x 50 m");

  await ada.goto("/settings/automations/runs");
  await ada.getByRole("button", { name: "New automation" }).click();
  await ada.getByLabel("Name", { exact: true }).fill("Match listings");
  await ada.getByLabel("Prompt", { exact: true }).fill("Propose the listings that match.");
  await ada.getByRole("button", { name: "Create automation" }).click();
  await expect(ada.getByRole("button", { name: "Match listings", exact: true })).toBeVisible();

  const workflowId = await createWorkflow(ada, "Benchmark");
  await ada.getByRole("button", { name: "Add step" }).click();
  await ada.getByLabel("Step title").fill("Collect");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label", { exact: true }).fill("Articles");
  await chooseOption(ada, "Type", "Collection records");
  await chooseOption(ada, "Collection", "Listings");
  await ada.getByRole("button", { name: "Add step" }).click();
  await ada.getByLabel("Step title").nth(1).fill("Match");
  await ada.getByRole("button", { name: "Add field" }).nth(1).click();
  await ada.getByLabel("Label", { exact: true }).nth(1).fill("Matches");
  await chooseOption(ada, "Type", "Collection records", 1);
  await chooseOption(ada, "Collection", "Listings", 1);
  await ada.getByRole("switch", { name: "Agents propose, members approve" }).nth(1).click();
  await ada.getByRole("button", { name: "Add field" }).nth(1).click();
  await ada.getByLabel("Label", { exact: true }).nth(2).fill("Brand");
  await ada.getByRole("switch", { name: "Agents propose, members approve" }).nth(2).click();
  await chooseOption(ada, "Add input", "Collect › Articles", 1);
  await chooseOption(ada, "Add automation", "Match listings", 1);
  await saveSteps(ada);
  const projectId = await createProject(ada, workflowId);
  await addStepMembers(ada, "Collect", ["ada"]);
  await addStepMembers(ada, "Match", ["ada"]);
  await ada.getByRole("button", { name: "Adopt", exact: true }).click();
  await expect(ada.getByText("New tickets start on version 1")).toBeVisible();
  await startItem(ada, projectId, "Tape 50 m");
  for (const key of ["source-19", "source-38"]) {
    await ada.getByRole("button", { name: "Link record", exact: true }).click();
    const picker = ada.getByRole("dialog", { name: "Link a record to Articles" });
    await picker.getByRole("row", { name: `Record ${key}`, exact: true }).click();
    await expect(picker).toHaveCount(0);
  }
  await ada.getByRole("button", { name: /^Status: To do/u }).click();
  await ada.getByRole("menuitem", { name: "Mark done" }).click();
  await ada.waitForURL(/\/my-work$/u);
  await ada.goto(`/boards/${projectId}`);
  await ada
    .getByRole("region", { name: "Match", exact: true })
    .getByText("Tape 50 m", { exact: true })
    .click();

  // The current step can inspect source articles and their details without editing or leaving it.
  const matchUrl = ada.url();
  await ada.getByRole("button", { name: "View previous step data", exact: true }).click();
  const inputs = ada.getByRole("dialog", { name: "Previous step data", exact: true });
  const articles = inputs.getByRole("table", { name: "Articles", exact: true });
  await expect(articles.getByRole("row", { name: /^Record /u })).toHaveCount(2);
  await articles.getByRole("row", { name: "Record source-19", exact: true }).click();
  const source = ada.getByRole("dialog", { name: "Articles · source-19", exact: true });
  await expect(source.getByText("Supplier tape 19 mm x 50 m", { exact: true })).toBeVisible();
  await expect(source.getByRole("textbox")).toHaveCount(0);
  await expect(source.getByRole("button", { name: /save|approve|discard/iu })).toHaveCount(0);
  await source.getByRole("button", { name: "Close", exact: true }).click();
  await expect(articles).toBeVisible();
  await inputs.getByRole("button", { name: "Close", exact: true }).click();
  await expect(ada).toHaveURL(matchUrl);

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
    await propose("Matches", "B0AAA", 60, "Matches source-19 (same length, paper backing)."),
    await propose("Matches", "B0BBB", 90, "Matches source-38 (same width and length)."),
    await propose("Brand", "Tesa", 70, "The supplier's sheet names Tesa."),
  ])
    expect(proposed.isError).not.toBe(true);

  // The best fit comes first, with the record it would link.
  await ada.getByRole("button", { name: "Review (3)" }).click();
  const review = ada.getByRole("dialog", { name: "Review" });
  await expect(review.getByRole("heading", { name: "B0BBB" })).toBeVisible();
  await expect(review.getByText("Fit 90%")).toBeVisible();
  await expect(
    review
      .getByRole("region", { name: "Why it fits" })
      .getByText("Matches source-38 (same width and length)."),
  ).toBeVisible();
  const comparison = review.getByRole("table", { name: "Record comparison" });
  const titles = comparison
    .getByRole("row", { name: "Product title", exact: false })
    .getByRole("cell");
  await expect(titles).toHaveText(["Supplier tape 38 mm x 50 m", "Crepe tape 50 m"]);
  await chooseOption(ada, "Compare with step input", "Articles · source-19");
  await expect(titles).toHaveText(["Supplier tape 19 mm x 50 m", "Crepe tape 50 m"]);

  // Postponing every proposal leaves all three undecided, including after reopening and reload.
  await review.getByRole("button", { name: "Maybe (postpone)", exact: true }).click();
  await expect(review.getByText("Tesa", { exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Maybe (postpone)", exact: true }).click();
  await expect(review.getByRole("heading", { name: "B0AAA" })).toBeVisible();
  await review.getByRole("button", { name: "Maybe (postpone)", exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(ada.getByRole("button", { name: "Review (3)" })).toBeVisible();
  await ada.reload();
  await ada.getByRole("button", { name: "Review (3)" }).click();
  await expect(review.getByRole("heading", { name: "B0BBB" })).toBeVisible();
  await expect(titles).toHaveText(["Supplier tape 38 mm x 50 m", "Crepe tape 50 m"]);
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
