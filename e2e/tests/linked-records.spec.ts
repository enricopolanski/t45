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

/** Fills the open record dialog's key and price and saves it. */
const saveRecord = async (page: Page, key: string | null, price: string) => {
  const dialog = page.getByRole("dialog", { name: "Record" });
  if (key !== null) await dialog.getByLabel("Key").fill(key);
  await dialog.getByLabel("Price").fill(price);
  await dialog.getByRole("button", { name: "Save record" }).click();
  await expect(dialog).toHaveCount(0);
};

test("a step lists the collection records it links, adds new ones to the collection and edits them", async ({
  signIn,
}) => {
  const ada = await signIn("ada@example.test");
  await nameOrganization(ada);
  await ada.goto("/settings/collections/new");
  await ada.getByLabel("Title").fill("Listings");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label").fill("Price");
  await chooseOption(ada, "Type", "Number");
  await ada.getByRole("button", { name: "Create collection" }).click();
  await expect(ada.getByRole("heading", { name: "Listings", level: 1 })).toBeVisible();
  await ada.getByRole("button", { name: "New record" }).click();
  await saveRecord(ada, "B0OLD", "12");

  const workflowId = await createWorkflow(ada, "Market check");
  await ada.getByRole("button", { name: "Add step" }).click();
  await ada.getByLabel("Step title").fill("Collect listings");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label", { exact: true }).fill("Competitor listings");
  await chooseOption(ada, "Type", "Collection records");
  await chooseOption(ada, "Collection", "Listings");
  await saveSteps(ada);
  const projectId = await createProject(ada, workflowId);
  await addStepMembers(ada, "Collect listings", ["ada"]);
  await ada.getByRole("button", { name: "Adopt", exact: true }).click();
  await expect(ada.getByText("New tickets start on version 1")).toBeVisible();
  await startItem(ada, projectId, "Tape 19 mm");
  const stepUrl = ada.url();

  // A record the collection holds is linked from it.
  const linked = ada.getByRole("table", { name: "Competitor listings" });
  await ada.getByRole("button", { name: "Link record", exact: true }).click();
  const picker = ada.getByRole("dialog", { name: "Link a record to Competitor listings" });
  await picker.getByRole("row", { name: "Record B0OLD" }).click();
  await expect(picker).toHaveCount(0);
  await expect(linked.getByRole("row", { name: "Record B0OLD" })).toContainText("12");

  // A new record goes to the collection and is linked here.
  await ada.getByRole("button", { name: "New record" }).click();
  await saveRecord(ada, "B0NEW", "9.5");
  await expect(linked.getByRole("row", { name: "Record B0NEW" })).toContainText("9.5");

  // A linked record opens as on the collection's page, and saving it shows here.
  await linked.getByRole("row", { name: "Record B0OLD" }).click();
  await saveRecord(ada, null, "11");
  await expect(linked.getByRole("row", { name: "Record B0OLD" })).toContainText("11");

  // Unlinking leaves the record in the collection, to link again.
  await linked.getByRole("button", { name: "Unlink record B0NEW" }).click();
  await expect(linked.getByRole("row", { name: "Record B0NEW" })).toHaveCount(0);
  await ada.getByRole("button", { name: "Link record", exact: true }).click();
  await expect(picker.getByRole("row", { name: "Record B0NEW" })).toBeVisible();
  await expect(picker.getByRole("row", { name: "Record B0OLD" })).toHaveCount(0);
  await ada.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);

  await ada.getByRole("button", { name: /^Status: To do/u }).click();
  await ada.getByRole("menuitem", { name: "Mark done" }).click();
  await ada.waitForURL(/\/my-work$/u);
  await ada.goto(stepUrl);
  await expect(linked.getByRole("row", { name: "Record B0OLD" })).toContainText("11");
  await expect(ada.getByRole("button", { name: "Link record", exact: true })).toHaveCount(0);
});
