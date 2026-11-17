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
  await ada.getByRole("button", { name: "Create collection" }).click();
  await expect(ada.getByRole("heading", { name: "Lamps", level: 1 })).toBeVisible();
  const collectionId = new URL(ada.url()).pathname.split("/")[3]!;

  await ada.getByRole("button", { name: "New record" }).click();
  const dialog = ada.getByRole("dialog", { name: "Record" });
  await dialog.getByLabel("Key").fill("Desk lamp");
  await dialog.getByLabel("Price").fill("12");
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
  await expect(layout.getByRole("heading", { name: "Desk lamp" })).toBeVisible();
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
  await ada.getByRole("button", { name: "Edit record" }).click();
  await expect(ada.getByRole("form", { name: "Record" }).getByLabel("Price")).toHaveValue("12.00");
});
