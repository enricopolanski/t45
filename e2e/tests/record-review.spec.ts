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
import { expect, test } from "../fixtures.ts";

const markDone = async (page: Page) => {
  await page.getByRole("button", { name: /^Status: To do/u }).click();
  await page.getByRole("menuitem", { name: "Mark done" }).click();
};

test("each linked article needs its own confirmed characteristics before the step can finish", async ({
  signIn,
}) => {
  const ada = await signIn("ada@example.test");
  await nameOrganization(ada);
  await ada.goto("/settings/collections/new");
  await ada.getByLabel("Title", { exact: true }).fill("Products");
  await ada.getByRole("button", { name: "Create collection" }).click();
  await expect(ada.getByRole("heading", { name: "Products", level: 1 })).toBeVisible();

  const workflowId = await createWorkflow(ada, "Product analysis");
  await ada.getByRole("button", { name: "Add step" }).click();
  await ada.getByLabel("Step title").fill("Extraction");
  const addField = ada.getByRole("button", { name: "Add field", exact: true });
  const labels = ada.getByLabel("Label", { exact: true });
  await addField.click();
  await labels.fill("Articles");
  await chooseOption(ada, "Type", "Collection records");
  await chooseOption(ada, "Collection", "Products");
  await addField.click();
  await labels.last().fill("Characteristics");
  await chooseOption(ada, "Type", "Group", 1);
  await ada.getByRole("switch", { name: "Multiple entries" }).click();
  await labels.last().fill("Article key");
  await addField.first().click();
  await labels.last().fill("Temperature resistance");
  await ada.getByRole("button", { name: "Review by record" }).click();
  await chooseOption(ada, "Linked records", "Articles");
  await chooseOption(ada, "Record key field", "Article key");
  const reviewMessage = "Your confirmed values will be used to check the order.";
  await ada.getByLabel("Review message", { exact: true }).fill(reviewMessage);
  await ada.getByRole("button", { name: "Save review" }).click();
  await saveSteps(ada);

  const projectId = await createProject(ada, workflowId);
  await addStepMembers(ada, "Extraction", ["ada"]);
  await ada.getByRole("button", { name: "Adopt", exact: true }).click();
  await expect(ada.getByText("New tickets start on version 1")).toBeVisible();
  await startItem(ada, projectId, "Compare tapes");
  await expect(ada.getByRole("button", { name: "Link record", exact: true })).toHaveCount(0);
  const articles = ada.getByRole("table", { name: "Articles" });
  for (const key of ["Coral tape", "Blue tape"]) {
    await ada.getByRole("button", { name: "New record" }).click();
    const form = ada.getByRole("dialog", { name: "Record", exact: true });
    await form.getByLabel("Key", { exact: true }).fill(key);
    await form.getByRole("button", { name: "Save record" }).click();
    await expect(articles.getByRole("row", { name: `Record ${key}` })).toBeVisible();
  }
  const coral = articles.getByRole("row", { name: "Record Coral tape" });
  const blue = articles.getByRole("row", { name: "Record Blue tape" });
  await expect(articles.getByRole("columnheader", { name: "Status", exact: true })).toBeVisible();
  const review = ada.getByRole("dialog", { name: "Review characteristics" });
  await markDone(ada);
  await expect(ada.getByRole("button", { name: "Confirm reviews for Articles" })).toBeVisible();

  await expect(ada.getByRole("button", { name: /^Review \(/u })).toHaveCount(0);
  await expect(ada.getByRole("button", { name: "Link record", exact: true })).toHaveCount(0);
  await coral.getByRole("button", { name: "Review", exact: true }).click();
  await expect(review).toHaveAccessibleDescription(reviewMessage);
  await expect(review.getByText("Coral tape", { exact: true })).toBeVisible();
  await review.getByLabel("Temperature resistance").fill("100 °C for 30 minutes");
  await review.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(review).toHaveCount(0);
  const coralStatus = coral.getByRole("cell", { name: "Confirmed", exact: true });
  await expect(coralStatus).toBeVisible();
  await expect(coralStatus.getByRole("button")).toHaveCount(0);
  await expect(blue.getByRole("button", { name: "Review", exact: true })).toBeVisible();

  await ada.reload();
  await expect(coralStatus).toBeVisible();
  await markDone(ada);
  await expect(ada.getByRole("button", { name: "Confirm reviews for Articles" })).toBeVisible();

  await blue.getByRole("button", { name: "Review", exact: true }).click();
  await review.getByLabel("Temperature resistance").fill("110 °C");
  await review.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(blue.getByRole("cell", { name: "Confirmed", exact: true })).toBeVisible();
  await markDone(ada);
  await ada.waitForURL(/\/my-work$/u);
});
