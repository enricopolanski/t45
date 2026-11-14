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

test.describe.configure({ mode: "parallel" });

const serveFavicons = (page: Page) =>
  page.route("https://www.google.com/s2/favicons?*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14" fill="green"/></svg>',
    }),
  );

test("a collection keeps its links and column order when linked from a step", async ({
  signIn,
}) => {
  const ada = await signIn("ada@example.test");
  await nameOrganization(ada);
  await serveFavicons(ada);
  await ada
    .context()
    .route("https://example.com/listing", (route) => route.fulfill({ body: "Listing" }));
  await ada.goto("/settings/collections/new");
  await ada.getByLabel("Title", { exact: true }).fill("Listings");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label", { exact: true }).fill("Product title");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label", { exact: true }).nth(1).fill("Price");
  await chooseOption(ada, "Type", "Number", 1);
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label", { exact: true }).nth(2).fill("Product URL");
  await chooseOption(ada, "Type", "URL", 2);
  await ada.getByRole("button", { name: "Create collection" }).click();
  await expect(ada.getByRole("heading", { name: "Listings", level: 1 })).toBeVisible();
  await ada.getByRole("button", { name: "New record" }).click();
  const dialog = ada.getByRole("dialog", { name: "Record", exact: true });
  await dialog.getByLabel("Key", { exact: true }).fill("B0ABC");
  await dialog.getByLabel("Product title", { exact: true }).fill("Masking tape");
  await dialog.getByLabel("Price", { exact: true }).fill("12.5");
  await dialog.getByLabel("Product URL", { exact: true }).fill("https://example.com/listing");
  await dialog.getByRole("button", { name: "Save record" }).click();
  await expect(dialog).toHaveCount(0);
  const row = ada.getByRole("row", { name: "Record B0ABC", exact: true });

  // Display settings remain editable after records exist, for every other field type.
  for (const [target, text] of [
    ["Key", "B0ABC"],
    ["Price", "12.5"],
    ["Product title", "Masking tape"],
  ]) {
    await ada.getByRole("link", { name: "Edit collection" }).click();
    await chooseOption(ada, "Display link on", target!);
    await ada.getByRole("button", { name: "Save collection" }).click();
    await expect(row.getByRole("link", { name: text!, exact: true })).toHaveAttribute(
      "href",
      "https://example.com/listing",
    );
    await expect(ada.getByRole("columnheader", { name: "Product URL", exact: true })).toHaveCount(
      0,
    );
  }
  await ada.reload();
  const link = row.getByRole("link", { name: "Masking tape", exact: true });
  await expect(link).toHaveAttribute("href", "https://example.com/listing");
  await expect(link.locator("img")).toHaveAttribute(
    "src",
    "https://www.google.com/s2/favicons?domain=example.com&sz=32",
  );
  const opened = ada.waitForEvent("popup");
  await link.press("Enter");
  const destination = await opened;
  await expect(destination).toHaveURL("https://example.com/listing");
  await destination.close();
  await expect(dialog).toHaveCount(0);

  // Both values still edit independently in the record's details.
  await row.getByRole("cell").first().click();
  await expect(dialog.getByLabel("Product URL", { exact: true })).toHaveValue(
    "https://example.com/listing",
  );
  await dialog.getByLabel("Product title", { exact: true }).fill("Blue masking tape");
  await dialog.getByLabel("Product URL", { exact: true }).fill("https://example.com/blue");
  await dialog.getByRole("button", { name: "Save record" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByRole("link", { name: "Blue masking tape", exact: true })).toHaveAttribute(
    "href",
    "https://example.com/blue",
  );

  // Clearing the setting restores the ordinary URL column.
  await ada.getByRole("link", { name: "Edit collection" }).click();
  await chooseOption(ada, "Display link on", "Own field");
  await ada.getByRole("button", { name: "Save collection" }).click();
  await expect(ada.getByRole("columnheader", { name: "Product URL", exact: true })).toBeVisible();
  await expect(row.getByRole("link", { name: "Product URL", exact: true })).toHaveAttribute(
    "href",
    "https://example.com/blue",
  );
  await ada.getByRole("link", { name: "Edit collection" }).click();
  await chooseOption(ada, "Display link on", "Product title");
  await ada.getByRole("button", { name: "Save collection" }).click();
  await expect(row).toBeVisible();

  // Reordering moves visible columns, including the update time, without changing the record.
  const records = ada.getByRole("table", { name: "Records" });
  await expect(records.getByRole("button", { name: /^Move /u })).toHaveCount(0);
  await ada.getByRole("switch", { name: "Reorder", exact: true }).click();
  await expect(records.getByRole("button", { name: "Move Key left", exact: true })).toBeDisabled();
  await expect(
    records.getByRole("button", { name: "Move Last update right", exact: true }),
  ).toBeDisabled();
  await records.getByRole("button", { name: "Move Product title left", exact: true }).click();
  await expect(records.getByRole("columnheader")).toHaveText([
    "Product title",
    "Key",
    "Price",
    "Last update",
  ]);
  await records.getByRole("button", { name: "Move Last update left", exact: true }).click();
  await expect(records.getByRole("columnheader")).toHaveText([
    "Product title",
    "Key",
    "Last update",
    "Price",
  ]);
  await records.getByRole("button", { name: "Move Key right", exact: true }).click();
  const columnOrder = ["Product title", "Last update", "Key", "Price"];
  await expect(records.getByRole("columnheader")).toHaveText(columnOrder);
  await ada.getByRole("switch", { name: "Reorder", exact: true }).click();
  await expect(records.getByRole("button", { name: /^Move /u })).toHaveCount(0);
  await ada.reload();
  await expect(records.getByRole("columnheader")).toHaveText(columnOrder);
  await expect(row.getByRole("cell").nth(2)).toHaveText("B0ABC");
  await expect(row.getByRole("cell").nth(3)).toHaveText("12.5");
  await expect(row.getByRole("link", { name: "Blue masking tape", exact: true })).toHaveAttribute(
    "href",
    "https://example.com/blue",
  );
  // Editing collection settings preserves the saved table order.
  await ada.getByRole("link", { name: "Edit collection" }).click();
  await ada.getByRole("button", { name: "Save collection" }).click();
  await expect(records.getByRole("columnheader")).toHaveText(columnOrder);

  const workflowId = await createWorkflow(ada, "Market check");
  await ada.getByRole("button", { name: "Add step" }).click();
  await ada.getByLabel("Step title").fill("Collect listings");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label", { exact: true }).fill("Competitors");
  await chooseOption(ada, "Type", "Collection records");
  await chooseOption(ada, "Collection", "Listings");
  await saveSteps(ada);
  const projectId = await createProject(ada, workflowId);
  await addStepMembers(ada, "Collect listings", ["ada"]);
  await ada.getByRole("button", { name: "Adopt", exact: true }).click();
  await expect(ada.getByText("New tickets start on version 1")).toBeVisible();
  await startItem(ada, projectId, "Tape check");
  await ada.getByRole("button", { name: "Link record", exact: true }).click();
  await ada
    .getByRole("dialog", { name: "Link a record to Competitors" })
    .getByRole("row", { name: "Record B0ABC" })
    .getByRole("cell", { name: "B0ABC", exact: true })
    .click();
  const table = ada.getByRole("table", { name: "Competitors" });
  await expect(table.getByRole("columnheader")).toHaveText([...columnOrder, "Remove"]);
  await expect(table.getByRole("link", { name: "Blue masking tape", exact: true })).toHaveAttribute(
    "href",
    "https://example.com/blue",
  );
  await expect(table.getByRole("columnheader", { name: "Product URL", exact: true })).toHaveCount(
    0,
  );
});

test("step table links use the URL from their own row and carry into the next step", async ({
  signIn,
}) => {
  const ada = await signIn("ada@example.test");
  await nameOrganization(ada);
  await serveFavicons(ada);
  const workflowId = await createWorkflow(ada, "Listing review");
  await ada.getByRole("button", { name: "Add step" }).click();
  await ada.getByLabel("Step title").fill("Collect");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label", { exact: true }).fill("Listings");
  await chooseOption(ada, "Type", "Group");
  await ada.getByRole("switch", { name: "Multiple entries" }).click();
  await ada.getByLabel("Label", { exact: true }).nth(1).fill("Name");
  await ada.getByRole("button", { name: "Add field", exact: true }).first().click();
  await ada.getByLabel("Label", { exact: true }).nth(2).fill("Product URL");
  await chooseOption(ada, "Type", "URL", 2);
  await chooseOption(ada, "Display link on", "Name");
  await ada.getByRole("button", { name: "Add step" }).click();
  await ada.getByLabel("Step title").nth(1).fill("Review");
  await chooseOption(ada, "Add input", "Collect › Listings", 1);
  await saveSteps(ada);
  const projectId = await createProject(ada, workflowId);
  await addStepMembers(ada, "Collect", ["ada"]);
  await addStepMembers(ada, "Review", ["ada"]);
  await ada.getByRole("button", { name: "Adopt", exact: true }).click();
  await expect(ada.getByText("New tickets start on version 1")).toBeVisible();
  await startItem(ada, projectId, "Tape check");
  for (const [at, name] of ["Blue tape", "Yellow tape"].entries()) {
    await ada.getByRole("button", { name: "Add entry", exact: true }).click();
    await ada.getByRole("button", { name: `Details of entry ${at + 1} of Listings` }).click();
    const details = ada.getByRole("dialog", { name: `Listings, entry ${at + 1}` });
    await details.getByLabel("Name", { exact: true }).fill(name);
    await details.getByLabel("Name", { exact: true }).blur();
    await details.getByLabel("Product URL", { exact: true }).fill(`https://example.com/${at + 1}`);
    await details.getByLabel("Product URL", { exact: true }).blur();
    await expect(details.getByRole("link", { name, exact: true })).toHaveAttribute(
      "href",
      `https://example.com/${at + 1}`,
    );
    await ada.keyboard.press("Escape");
    await expect(details).toHaveCount(0);
  }
  await ada.reload();
  await expect(ada.getByRole("link", { name: "Blue tape", exact: true })).toHaveAttribute(
    "href",
    "https://example.com/1",
  );
  await expect(ada.getByRole("link", { name: "Yellow tape", exact: true })).toHaveAttribute(
    "href",
    "https://example.com/2",
  );
  await expect(ada.getByRole("columnheader", { name: "Product URL", exact: true })).toHaveCount(0);
  await ada.getByRole("button", { name: /^Status: To do/u }).click();
  await ada.getByRole("menuitem", { name: "Mark done" }).click();
  await ada.waitForURL(/\/my-work$/u);
  await ada.goto(`/boards/${projectId}`);
  await ada.getByRole("region", { name: "Review", exact: true }).getByText("Tape check").click();
  await ada.getByRole("button", { name: "Inputs" }).click();
  const table = ada.getByRole("table", { name: "Listings", exact: true });
  await expect(table.getByRole("link", { name: "Blue tape", exact: true })).toHaveAttribute(
    "href",
    "https://example.com/1",
  );
  await expect(table.getByRole("link", { name: "Yellow tape", exact: true })).toHaveAttribute(
    "href",
    "https://example.com/2",
  );
  await expect(table.getByRole("columnheader", { name: "Product URL", exact: true })).toHaveCount(
    0,
  );
});
