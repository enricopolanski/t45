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
import { expect } from "../fixtures.ts";
import { test } from "../agent-app.ts";

test.describe.configure({ mode: "parallel" });

const serveFavicons = (page: Page) =>
  page.route("https://www.google.com/s2/favicons?*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14" fill="green"/></svg>',
    }),
  );

test("collection URL fields keep their destination and label, and open without editing the record", async ({
  signIn,
}) => {
  const ada = await signIn("ada@example.test");
  await nameOrganization(ada);
  await serveFavicons(ada);
  await ada
    .context()
    .route("https://example.com/listing", (route) => route.fulfill({ body: "Product listing" }));

  await ada.goto("/settings/collections/new");
  await ada.getByLabel("Title").fill("Product links");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label", { exact: true }).fill("Listing");
  await chooseOption(ada, "Type", "URL");
  await ada.getByRole("button", { name: "Create collection" }).click();
  await expect(ada.getByRole("heading", { name: "Product links", level: 1 })).toBeVisible();
  await ada.getByRole("button", { name: "New record" }).click();
  const dialog = ada.getByRole("dialog", { name: "Record" });
  await dialog.getByLabel("Key", { exact: true }).fill("first");
  await dialog.getByLabel("Listing URL", { exact: true }).fill("https://example.com/listing");
  await dialog.getByLabel("Listing link text", { exact: true }).fill("Product listing");
  await dialog.getByRole("button", { name: "Save record" }).click();
  await expect(dialog).toHaveCount(0);

  const row = ada.getByRole("row", { name: "Record first" });
  const link = row.getByRole("link", { name: "Product listing", exact: true });
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

  await row.getByRole("cell").first().click();
  await expect(dialog.getByLabel("Listing URL", { exact: true })).toHaveValue(
    "https://example.com/listing",
  );
  await dialog.getByLabel("Listing link text", { exact: true }).fill("Updated listing");
  await dialog.getByRole("button", { name: "Save record" }).click();
  await expect(dialog).toHaveCount(0);
  await ada.reload();
  await expect(row.getByRole("link", { name: "Updated listing" })).toHaveAttribute(
    "href",
    "https://example.com/listing",
  );
  await ada.getByLabel("Search records").fill("missing");
  await expect(row).toHaveCount(0);
  await ada.getByLabel("Search records").fill("updated");
  await expect(row).toBeVisible();
  await ada.getByLabel("Search records").fill("missing");
  await expect(row).toHaveCount(0);
  await ada.getByLabel("Search records").fill("example.com");
  await expect(row).toBeVisible();
});

test("step URL fields show labeled links while editing and after completion, including repeated groups", async ({
  signIn,
}) => {
  const ada = await signIn("ada@example.test");
  await nameOrganization(ada);
  await serveFavicons(ada);
  const workflowId = await createWorkflow(ada, "Link review");
  await ada.getByRole("button", { name: "Add step" }).click();
  await ada.getByLabel("Step title").fill("Collect");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label", { exact: true }).fill("Source");
  await chooseOption(ada, "Type", "URL");
  await ada.getByLabel("Source default URL", { exact: true }).fill("https://example.com/reference");
  await ada.getByLabel("Source default link text", { exact: true }).fill("Starting source");
  await ada.getByRole("button", { name: "Add field", exact: true }).click();
  await ada.getByLabel("Label", { exact: true }).nth(1).fill("References");
  await chooseOption(ada, "Type", "Group", 1);
  await ada.getByRole("switch", { name: "Multiple entries" }).click();
  await ada.getByLabel("Label", { exact: true }).nth(2).fill("Reference");
  await chooseOption(ada, "Type", "URL", 2);
  await saveSteps(ada);
  const projectId = await createProject(ada, workflowId);
  await addStepMembers(ada, "Collect", ["ada"]);
  await ada.getByRole("button", { name: "Adopt", exact: true }).click();
  await expect(ada.getByText("New tickets start on version 1")).toBeVisible();
  await startItem(ada, projectId, "First review");
  const stepUrl = ada.url();
  await expect(ada.getByRole("link", { name: "Starting source" })).toHaveAttribute(
    "href",
    "https://example.com/reference",
  );

  await ada.getByLabel("Source URL", { exact: true }).fill("https://example.com/updated");
  await ada.getByLabel("Source link text", { exact: true }).fill("Updated source");
  await ada.getByLabel("Source link text", { exact: true }).blur();
  const history = ada.getByRole("complementary", { name: "History" });
  await expect(history.getByText("changed a field", { exact: false })).toBeVisible();
  await ada.reload();
  await expect(ada.getByLabel("Source URL", { exact: true })).toHaveValue(
    "https://example.com/updated",
  );
  await expect(ada.getByRole("link", { name: "Updated source" })).toHaveAttribute(
    "href",
    "https://example.com/updated",
  );

  await ada.getByRole("button", { name: "Add entry", exact: true }).click();
  await ada
    .getByLabel("Reference, entry 1 URL", { exact: true })
    .fill("https://example.com/documentation");
  await ada.getByLabel("Reference, entry 1 link text", { exact: true }).fill("Documentation");
  await ada.getByLabel("Reference, entry 1 link text", { exact: true }).blur();
  await expect(history.getByText("changed 3 fields", { exact: false })).toBeVisible();
  await ada.getByRole("button", { name: /^Status: To do/u }).click();
  await ada.getByRole("menuitem", { name: "Mark done" }).click();
  await ada.waitForURL(/\/my-work$/u);
  await ada.goto(stepUrl);
  await expect(ada.getByLabel("Source URL", { exact: true })).toHaveCount(0);
  await expect(ada.getByRole("link", { name: "Updated source" })).toHaveAttribute(
    "href",
    "https://example.com/updated",
  );
  await expect(ada.getByRole("link", { name: "Documentation" })).toHaveAttribute(
    "href",
    "https://example.com/documentation",
  );
});
