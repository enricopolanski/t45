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

const saveListing = async (page: Page, key: string, title: string, shopUrl?: string) => {
  await page.getByRole("button", { name: "New record" }).click();
  const dialog = page.getByRole("dialog", { name: "Record", exact: true });
  await dialog.getByLabel("Key", { exact: true }).fill(key);
  await dialog.getByLabel("Product title", { exact: true }).fill(title);
  if (key !== "source-19")
    await dialog.getByLabel("Category", { exact: true }).fill("Masking tape");
  await dialog.getByLabel("Item code", { exact: true }).fill(`Code ${key}`);
  await dialog.getByLabel("Width", { exact: true }).fill(key === "B0BBB" ? "25 mm" : "38 mm");
  await dialog
    .getByLabel("Technical data", { exact: true })
    .fill("| Property | Value |\n| --- | --- |\n| Backing | Paper |");
  await dialog.getByLabel("Description", { exact: true }).fill("A detail about this tape.");
  await dialog.getByLabel("Length", { exact: true }).fill(key === "source-19" ? "0" : "50");
  if (key.startsWith("source-"))
    await dialog.getByLabel("Quoted cost", { exact: true }).fill("0.83");
  if (shopUrl !== undefined) {
    await dialog.getByLabel("Shop", { exact: true }).fill("GitHub");
    await dialog.getByLabel("Product URL", { exact: true }).fill(shopUrl);
    await dialog.getByLabel("Product URL", { exact: true }).blur();
    for (const [at, { price, rank }] of [
      { price: "2", rank: "2" },
      { price: "2.8574", rank: "1" },
    ].entries()) {
      const entry = at + 1;
      await dialog.getByRole("button", { name: "Add entry", exact: true }).click();
      await dialog.getByLabel(`Offer price, entry ${entry}`, { exact: true }).fill(price);
      await dialog.getByLabel(`Offer rank, entry ${entry}`, { exact: true }).fill(rank);
      await dialog.getByLabel(`Offer rank, entry ${entry}`, { exact: true }).blur();
    }
  }
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
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label", { exact: true }).last().fill("Shop");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label", { exact: true }).last().fill("Product URL");
  await chooseOption(ada, "Type", "URL", 2);
  await chooseOption(ada, "Display link on", "Product title");
  for (const label of ["Category", "Item code", "Width", "Technical data", "Description"]) {
    await ada.getByRole("button", { name: "Add field" }).click();
    await ada.getByLabel("Label", { exact: true }).last().fill(label);
    if (label === "Technical data")
      await ada.getByRole("switch", { name: "Render as Markdown" }).last().click();
  }
  await ada.getByRole("switch", { name: "Render as Markdown" }).last().click();
  await ada.getByRole("switch", { name: "Show in table" }).last().click();
  for (const label of ["Quoted cost", "Length"]) {
    await ada.getByRole("button", { name: "Add field", exact: true }).last().click();
    await ada.getByLabel("Label", { exact: true }).last().fill(label);
    await ada.getByRole("combobox", { name: "Type", exact: true }).last().click();
    await ada.getByRole("option", { name: "Number", exact: true }).click();
    if (label === "Quoted cost") {
      await ada.getByLabel("Unit", { exact: true }).fill("€");
      await chooseOption(ada, "Decimals", "4");
    }
    await ada.getByRole("switch", { name: "Show in table" }).last().click();
  }
  await ada.getByRole("button", { name: "Add field", exact: true }).last().click();
  await ada.getByLabel("Label", { exact: true }).last().fill("Offers");
  await ada.getByRole("combobox", { name: "Type", exact: true }).last().click();
  await ada.getByRole("option", { name: "Group", exact: true }).click();
  await ada.getByRole("switch", { name: "Multiple entries" }).click();
  await ada.getByLabel("Label", { exact: true }).last().fill("Offer price");
  await ada.getByRole("combobox", { name: "Type", exact: true }).last().click();
  await ada.getByRole("option", { name: "Number", exact: true }).click();
  await ada.getByLabel("Unit", { exact: true }).last().fill("€");
  await ada.getByRole("button", { name: "Add field", exact: true }).first().click();
  await ada.getByLabel("Label", { exact: true }).last().fill("Offer rank");
  await ada.getByRole("combobox", { name: "Type", exact: true }).last().click();
  await ada.getByRole("option", { name: "Number", exact: true }).click();
  await ada.getByRole("button", { name: "Create collection" }).click();
  await expect(ada.getByRole("heading", { name: "Listings", level: 1 })).toBeVisible();
  const listingUrl = "https://github.com/example/crepe-tape";
  await saveListing(ada, "B0AAA", "Masking tape 50 m");
  await saveListing(ada, "B0BBB", "Crepe tape 50 m", listingUrl);
  await saveListing(ada, "source-19", "Supplier tape 19 mm x 50 m");
  await saveListing(ada, "source-38", "Supplier tape 38 mm x 50 m");
  await ada.getByRole("link", { name: "Edit collection" }).click();
  await ada.getByRole("button", { name: "Layout" }).click();
  const layout = ada.getByRole("dialog", { name: "Layout — Listings" });
  await layout.getByRole("tab", { name: "Grid" }).click();
  await layout.getByRole("combobox", { name: "Title", exact: true }).click();
  await ada.getByRole("option", { name: "Product title", exact: true }).click();
  await layout.getByRole("tab", { name: "Search" }).click();
  await chooseOption(ada, "Add a filter", "Shop");
  await chooseOption(ada, "Site icons of the Shop filter", "Site icons from Product URL");
  await layout.getByRole("button", { name: "Save layout" }).click();
  await expect(layout).toHaveCount(0);

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
  await ada.getByRole("switch", { name: "Customize comparison fields" }).check();
  await ada.getByRole("checkbox", { name: "Category", exact: true }).uncheck();
  await ada.getByRole("checkbox", { name: "Item code", exact: true }).uncheck();
  await ada.getByRole("checkbox", { name: "Width", exact: true }).uncheck();
  await ada.getByRole("button", { name: "Add derived field", exact: true }).click();
  const derived = ada.getByRole("dialog", { name: "Add derived field", exact: true });
  await derived.getByRole("textbox", { name: "Name", exact: true }).fill("Summary");
  await chooseOption(ada, "Insert field", "Width");
  await chooseOption(ada, "Insert field", "Category");
  await derived.getByRole("button", { name: "Add field", exact: true }).click();
  await ada.getByRole("button", { name: "Move Summary up", exact: true }).click();
  await ada.getByRole("button", { name: "Move Summary up", exact: true }).click();
  await ada.getByRole("button", { name: "Add derived field", exact: true }).click();
  await derived.getByRole("textbox", { name: "Name", exact: true }).fill("Price per unit");
  await derived.getByRole("switch", { name: "Separate templates" }).check();
  await chooseOption(ada, "Insert field", "Quoted cost");
  await chooseOption(ada, "Insert field", "Length");
  const sourceTemplate = derived.getByRole("textbox", { name: "Source template", exact: true });
  const [cost, length] = Array.from(
    (await sourceTemplate.inputValue()).matchAll(/\$\{([^}]+)\}/gu),
    (match) => match[1],
  );
  await sourceTemplate.fill("${" + cost + " / " + length + "}");
  await chooseOption(ada, "Insert field", "Quoted cost");
  await chooseOption(ada, "Repeatable group", "Offers", 1);
  await chooseOption(ada, "Lowest value of", "Offer rank");
  await chooseOption(ada, "Insert group field", "Offer price");
  const proposedTemplate = derived.getByRole("textbox", { name: "Proposed template", exact: true });
  await proposedTemplate.fill(
    (await proposedTemplate.inputValue()).replace(/\}$/u, " / " + length + "}"),
  );
  await chooseOption(ada, "Insert group field", "Offer rank");
  await derived.getByRole("button", { name: "Add field", exact: true }).click();
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
      whyNo: "*Another brand.*",
    });
  for (const proposed of [
    await propose("Matches", "B0AAA", 60, "Matches source-19 (same length, paper backing)."),
    await propose("Matches", "B0BBB", 90, "Matches source-38 (**same width and length**)."),
    await propose("Brand", "Tesa", 70, "The supplier's sheet names Tesa."),
  ])
    expect(proposed.isError).not.toBe(true);

  // The best fit comes first, with the record it would link.
  await ada.getByRole("button", { name: "Review (3)" }).click();
  const review = ada.getByRole("dialog", { name: "Review" });
  const comparison = review.getByRole("table", { name: "Record comparison" });
  const proposedTitle = comparison.getByRole("heading", { name: "Crepe tape 50 m" });
  const titleLink = proposedTitle.getByRole("link", { name: "Crepe tape 50 m", exact: true });
  await expect(titleLink).toHaveAttribute("href", listingUrl);
  await expect(titleLink.locator("svg")).toBeVisible();
  await expect(comparison.getByRole("rowheader")).toHaveText([
    "Summary",
    "Technical data",
    "Price per unit",
  ]);
  const summary = comparison.getByRole("row", { name: /^Summary /u }).getByRole("cell");
  await expect(summary).toHaveText(["38 mm Masking tape", "25 mm Masking tape"]);
  const technicalData = comparison.getByRole("button", { name: "Technical data", exact: true });
  const specs = comparison.getByRole("cell", { name: "Paper", exact: true });
  await expect(technicalData).toHaveAttribute("aria-expanded", "false");
  await expect(specs).toHaveCount(0);
  await technicalData.click();
  await expect(specs).toHaveCount(2);
  await technicalData.click();
  await expect(specs).toHaveCount(0);
  const price = comparison.getByRole("row", { name: /^Price per unit /u }).getByRole("cell");
  await expect(price).toHaveText(["0,017 0,83 €", "0,057 1"]);
  await review.getByText("Full record details", { exact: true }).click();
  const proposedDetails = review.getByRole("region", { name: "Proposed record details" });
  await expect(proposedDetails.getByText("Code B0BBB", { exact: true })).toBeVisible();
  await review.getByText("Full record details", { exact: true }).click();
  await expect(review.getByText("Fit 90%")).toBeVisible();
  const comment = review.getByRole("region", { name: "Comment", exact: true });
  await expect(comment).toHaveCount(1);
  await expect(comparison.getByRole("region", { name: "Comment", exact: true })).toHaveCount(0);
  await expect(
    comment.getByRole("region", { name: "Why it fits", exact: true }).locator("strong"),
  ).toHaveText("same width and length");
  await expect(
    comment.getByRole("region", { name: "Why it may not", exact: true }).locator("em"),
  ).toHaveText("Another brand.");
  const sourceTitle = comparison.getByRole("columnheader", { name: /Source record/u });
  await expect(sourceTitle.getByRole("heading")).toHaveText("Supplier tape 38 mm x 50 m");
  await expect(sourceTitle.getByRole("link")).toHaveCount(0);
  await chooseOption(ada, "Compare with step input", "Articles · Supplier tape 19 mm x 50 m");
  await expect(sourceTitle.getByRole("heading")).toHaveText("Supplier tape 19 mm x 50 m");
  await expect(summary).toHaveText(["Not provided", "25 mm Masking tape"]);
  await expect(price).toHaveText(["Not provided", "0,057 1"]);

  // Postponing every proposal leaves all three undecided, including after reopening and reload.
  await review.getByRole("button", { name: "Maybe (postpone)", exact: true }).click();
  await expect(review.getByText("Tesa", { exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Maybe (postpone)", exact: true }).click();
  const unlinkedTitle = comparison.getByRole("heading", { name: "Masking tape 50 m" });
  await expect(unlinkedTitle).toBeVisible();
  await expect(unlinkedTitle.getByRole("link")).toHaveCount(0);
  await review.getByRole("button", { name: "Maybe (postpone)", exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(ada.getByRole("button", { name: "Review (3)" })).toBeVisible();
  await ada.reload();
  await ada.getByRole("button", { name: "Review (3)" }).click();
  await expect(titleLink).toHaveAttribute("href", listingUrl);
  await expect(comparison.getByRole("rowheader")).toHaveText([
    "Summary",
    "Technical data",
    "Price per unit",
  ]);
  await expect(sourceTitle.getByRole("heading")).toHaveText("Supplier tape 38 mm x 50 m");
  await review.getByRole("button", { name: "Approve" }).click();
  await expect(review.getByText("Tesa", { exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Approve" }).click();
  await expect(unlinkedTitle).toBeVisible();
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
