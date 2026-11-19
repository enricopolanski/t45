import { chooseOption, nameOrganization } from "../actions.ts";
import { expect, test } from "../fixtures.ts";

/** A one-pixel PNG. */
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("a collection's layout shows its records as cards and each on a showcase page", async ({
  signIn,
}) => {
  const ada = await signIn("ada@example.test");
  await nameOrganization(ada);
  await ada.goto("/settings/collections");
  await ada.getByRole("link", { name: "New collection" }).click();
  await ada.getByLabel("Title").fill("Lamps");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label").last().fill("Price");
  await chooseOption(ada, "Type", "Number");
  await chooseOption(ada, "Decimals", "2");
  await ada.getByLabel("Unit").fill("€");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label").last().fill("Photo");
  await chooseOption(ada, "Type", "File", 1);
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label").last().fill("Memo");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label").last().fill("Product summary");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label").last().fill("Category");
  await ada.getByRole("button", { name: "Create collection" }).click();
  await expect(ada.getByRole("heading", { name: "Lamps", level: 1 })).toBeVisible();
  const collectionId = new URL(ada.url()).pathname.split("/")[3]!;

  await ada.getByRole("button", { name: "New record" }).click();
  const dialog = ada.getByRole("dialog", { name: "Record" });
  await dialog.getByLabel("Key").fill("Desk lamp");
  await dialog.getByLabel("Price").fill("12");
  await dialog.getByLabel("Memo").fill("Internal supplier note");
  await dialog.getByLabel("Product summary").fill("A **dimmable** reading lamp.");
  await dialog.getByLabel("Category").fill("Lighting");
  await dialog
    .getByLabel("Photo")
    .setInputFiles({ name: "lamp.png", mimeType: "image/png", buffer: pixel });
  await expect(dialog.getByRole("link", { name: "lamp.png" })).toBeVisible();
  await dialog.getByRole("button", { name: "Save record" }).click();
  await expect(dialog).toHaveCount(0);

  // The grid shows the price large and the collection opens on it; a card opens the record's page.
  await ada.goto(`/settings/collections/${collectionId}/edit`);
  await ada.getByRole("button", { name: "Layout" }).click();
  const layout = ada.getByRole("dialog", { name: "Layout — Lamps" });
  await layout.getByRole("tab", { name: "Grid" }).click();
  await chooseOption(ada, "Highlight", "Price");
  await chooseOption(ada, "Records show first as", "Grid");
  const previewCard = layout
    .getByRole("list", { name: "Records" })
    .getByRole("button", { name: "Record Desk lamp" });
  await expect(previewCard).toContainText("12,00 €");
  await previewCard.click();
  await chooseOption(ada, "Template", "Showcase");
  await chooseOption(ada, "Description", "Product summary");
  await expect(layout.getByRole("heading", { name: "Desk lamp" })).toBeVisible();
  await expect(layout.getByText("Internal supplier note", { exact: true })).toBeVisible();
  await layout
    .getByRole("group", { name: "Hide fields in showcase" })
    .getByRole("checkbox", { name: "Memo", exact: true })
    .click();
  await expect(layout.getByText("Internal supplier note", { exact: true })).toHaveCount(0);
  await layout.getByRole("button", { name: "Save layout" }).click();
  await expect(layout).toHaveCount(0);

  await ada.goto(`/settings/collections/${collectionId}`);
  const card = ada
    .getByRole("list", { name: "Records" })
    .getByRole("button", { name: "Record Desk lamp" });
  await expect(card).toContainText("12,00 €");
  await expect(card.locator("img")).toHaveJSProperty("naturalWidth", 1);
  await card.click();
  await expect(ada.getByRole("heading", { name: "Desk lamp", level: 2 })).toBeVisible();
  await expect(ada.getByRole("img", { name: "Desk lamp" })).toHaveJSProperty("naturalWidth", 1);
  await expect(ada.getByText("12,00 €")).toBeVisible();
  const summary = ada.getByText("A dimmable reading lamp.", { exact: true });
  await expect(summary.locator("strong")).toHaveText("dimmable");
  const price = ada.getByText("12,00 €", { exact: true });
  const category = ada.getByText("Lighting", { exact: true });
  await expect(category).toBeVisible();
  const summaryElement = await summary.elementHandle();
  expect(
    await price.evaluate(
      (element, next) => element.compareDocumentPosition(next) === Node.DOCUMENT_POSITION_FOLLOWING,
      summaryElement,
    ),
  ).toBe(true);
  expect(
    await category.evaluate(
      (element, previous) =>
        element.compareDocumentPosition(previous) === Node.DOCUMENT_POSITION_PRECEDING,
      summaryElement,
    ),
  ).toBe(true);
  await expect(ada.getByText("Internal supplier note", { exact: true })).toHaveCount(0);
  await ada.getByRole("button", { name: "Edit record" }).click();
  await expect(ada.getByRole("form", { name: "Record" }).getByLabel("Price")).toHaveValue("12.00");
  await expect(ada.getByRole("form", { name: "Record" }).getByLabel("Memo")).toHaveValue(
    "Internal supplier note",
  );
});
