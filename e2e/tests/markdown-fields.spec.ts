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

test.describe.configure({ mode: "parallel" });

const rationale =
  "**Sources**\nFirst line\nSecond line\n\n- Supplier offer\n- [Listing](https://example.com/listing)";
const calculation = "**Costs**\n\n- Purchase: 10 EUR\n- Freight: 2 EUR";

test("Markdown fields edit their source and keep formatting in entries, completed steps and inputs", async ({
  signIn,
}) => {
  const page = await signIn("ada@example.test");
  await nameOrganization(page);
  const workflowId = await createWorkflow(page, "Pricing review");
  await page.getByRole("button", { name: "Add step" }).click();
  await page.getByLabel("Step title").fill("Propose");
  await page.getByRole("button", { name: "Add field" }).click();
  await page.getByLabel("Label", { exact: true }).fill("Rationale");
  await page.getByRole("switch", { name: "Render as Markdown" }).click();
  await page.getByRole("button", { name: "Add field" }).click();
  await page.getByLabel("Label", { exact: true }).nth(1).fill("Proposals");
  await chooseOption(page, "Type", "Group", 1);
  await page.getByRole("switch", { name: "Multiple entries" }).click();
  await page.getByLabel("Label", { exact: true }).nth(2).fill("Calculation details");
  await page.getByRole("switch", { name: "Render as Markdown" }).nth(1).click();
  await page.getByRole("button", { name: "Add field", exact: true }).first().click();
  await page.getByLabel("Label", { exact: true }).nth(3).fill("Additional notes");
  await page.getByLabel("Default value", { exact: true }).nth(2).fill("Keep the original source.");
  await page.getByRole("switch", { name: "Show in table" }).nth(1).click();
  await page.getByRole("button", { name: "Add step" }).click();
  await page.getByLabel("Step title").nth(1).fill("Review");
  await chooseOption(page, "Add input", "Propose › Rationale", 1);
  await chooseOption(page, "Add input", "Propose › Proposals", 1);
  await saveSteps(page);
  const projectId = await createProject(page, workflowId);
  await addStepMembers(page, "Propose", ["ada"]);
  await addStepMembers(page, "Review", ["ada"]);
  await page.getByRole("button", { name: "Adopt", exact: true }).click();
  await expect(page.getByText("New tickets start on version 1")).toBeVisible();
  await startItem(page, projectId, "Tape");
  const firstStep = page.url();

  await page.getByRole("textbox", { name: "Rationale", exact: true }).fill(rationale);
  await page.getByRole("textbox", { name: "Rationale", exact: true }).blur();
  await expect(page.locator(".chat-markdown strong", { hasText: "Sources" })).toBeVisible();
  await expect(page.locator(".chat-markdown br")).toHaveCount(2);
  await page.getByRole("button", { name: "Edit Rationale", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Rationale", exact: true })).toHaveValue(
    rationale,
  );
  await page.getByRole("textbox", { name: "Rationale", exact: true }).fill("Discard this edit");
  await page.getByRole("textbox", { name: "Rationale", exact: true }).press("Escape");
  await expect(page.locator(".chat-markdown strong", { hasText: "Sources" })).toBeVisible();

  await page.getByRole("button", { name: "Add entry", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Calculation details, entry 1", exact: true })
    .fill(calculation);
  await page.getByRole("textbox", { name: "Calculation details, entry 1", exact: true }).blur();
  await expect(page.locator("td .chat-markdown strong", { hasText: "Costs" })).toBeVisible();
  await page.getByRole("button", { name: "Details of entry 1 of Proposals" }).click();
  const details = page.getByRole("dialog", { name: "Proposals, entry 1" });
  await expect(details.getByRole("listitem")).toHaveText(["Purchase: 10 EUR", "Freight: 2 EUR"]);
  await details.getByRole("button", { name: "Edit Calculation details", exact: true }).click();
  await expect(
    details.getByRole("textbox", { name: "Calculation details", exact: true }),
  ).toHaveValue(calculation);
  await details
    .getByRole("textbox", { name: "Calculation details", exact: true })
    .fill(`${calculation}\n- Packing: 1 EUR`);
  await details.getByRole("textbox", { name: "Calculation details", exact: true }).blur();
  await expect(details.getByRole("listitem")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);

  const comments = page.getByRole("region", { name: "Comments", exact: true });
  await comments.getByRole("textbox", { name: "New comment" }).fill(rationale);
  await comments.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(comments.locator("strong")).toHaveText("Sources");
  await expect(comments.locator("br")).toHaveCount(2);
  await expect(comments.getByRole("link", { name: "Listing", exact: true })).toHaveAttribute(
    "href",
    "https://example.com/listing",
  );
  await page.reload();
  await expect(comments.locator("strong")).toHaveText("Sources");
  await page.getByRole("button", { name: /^Status: To do/u }).click();
  await page.getByRole("menuitem", { name: "Mark done" }).click();
  await page.waitForURL(/\/my-work$/u);
  await page.goto(`/boards/${projectId}`);
  await page.getByRole("region", { name: "Review", exact: true }).getByText("Tape").click();
  await page.getByRole("button", { name: "Inputs", exact: true }).click();
  await expect(page.locator(".chat-markdown strong", { hasText: "Sources" })).toBeVisible();
  await expect(page.locator("td .chat-markdown strong", { hasText: "Costs" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Edit /u })).toHaveCount(0);
  await page.getByRole("button", { name: /^Status: To do/u }).click();
  await page.getByRole("menuitem", { name: "Mark done" }).click();
  await page.waitForURL(/\/my-work$/u);
  await page.goto(firstStep);
  await expect(page.locator(".chat-markdown strong", { hasText: "Costs" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit Rationale", exact: true })).toHaveCount(0);
});

test("an existing collection can enable and disable Markdown without changing its stored text", async ({
  signIn,
}) => {
  const page = await signIn("ada@example.test");
  await nameOrganization(page);
  await page.goto("/settings/collections/new");
  await page.getByLabel("Title", { exact: true }).fill("Sources");
  await page.getByRole("button", { name: "Add field" }).click();
  await page.getByLabel("Label", { exact: true }).fill("Notes");
  await page.getByRole("button", { name: "Create collection" }).click();
  await expect(page.getByRole("heading", { name: "Sources", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "New record" }).click();
  const dialog = page.getByRole("dialog", { name: "Record", exact: true });
  await dialog.getByLabel("Key", { exact: true }).fill("tape");
  await dialog.getByLabel("Notes", { exact: true }).fill(rationale);
  await dialog.getByRole("button", { name: "Save record" }).click();
  await expect(dialog).toHaveCount(0);
  const row = page.getByRole("row", { name: "Record tape", exact: true });
  await expect(row.locator("strong")).toHaveCount(0);
  await page.getByRole("link", { name: "Edit collection" }).click();
  await page.getByRole("switch", { name: "Render as Markdown" }).nth(1).click();
  await page.getByRole("button", { name: "Save collection" }).click();
  await expect(row.locator("strong")).toHaveText("Sources");
  await expect(row.getByRole("listitem")).toHaveCount(2);
  await page
    .context()
    .route("https://example.com/listing", (route) => route.fulfill({ body: "Listing" }));
  const opened = page.waitForEvent("popup");
  await row.getByRole("link", { name: "Listing", exact: true }).click();
  const destination = await opened;
  await expect(destination).toHaveURL("https://example.com/listing");
  await destination.close();
  await expect(dialog).toHaveCount(0);
  await row.getByRole("cell").first().click();
  await expect(dialog.locator("strong")).toHaveText("Sources");
  await dialog.getByRole("button", { name: "Edit Notes", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue(rationale);
  await dialog
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill(`${rationale}\n- Verified`);
  await dialog.getByRole("button", { name: "Save record" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByRole("listitem")).toHaveCount(3);
  await page.reload();
  await expect(row.getByRole("listitem")).toHaveCount(3);
  await page.getByRole("link", { name: "Edit collection" }).click();
  await page.getByRole("switch", { name: "Render as Markdown" }).nth(1).click();
  await page.getByRole("button", { name: "Save collection" }).click();
  await expect(row.locator("strong")).toHaveCount(0);
  await row.getByRole("cell").first().click();
  await expect(dialog.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue(
    `${rationale}\n- Verified`,
  );
});
