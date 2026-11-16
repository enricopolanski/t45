import type { Page } from "@playwright/test";

import { chooseOption, nameOrganization } from "../actions.ts";
import { expect, test } from "../fixtures.ts";

const saveRecord = async (page: Page, key: string, price: string, brand: string) => {
  await page.getByRole("button", { name: "New record" }).click();
  const dialog = page.getByRole("dialog", { name: "Record" });
  await dialog.getByLabel("Key").fill(key);
  await dialog.getByLabel("Price").fill(price);
  await dialog.getByLabel("Brand").fill(brand);
  await dialog.getByRole("button", { name: "Save record" }).click();
  await expect(dialog).toHaveCount(0);
};

test("a collection's layout sets the fields its search looks in and the filters it shows", async ({
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
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label").last().fill("Brand");
  await ada.getByRole("button", { name: "Create collection" }).click();
  await expect(ada.getByRole("heading", { name: "Lamps", level: 1 })).toBeVisible();
  const collectionId = new URL(ada.url()).pathname.split("/")[3]!;
  await saveRecord(ada, "Desk lamp", "12", "Lumo");
  await saveRecord(ada, "Floor lamp", "40", "Lumo");
  await saveRecord(ada, "Desk fan", "25", "Breeze");
  await expect(ada.getByText("3 records")).toBeVisible();

  // The search looks only in the key; Brand and Price filter the records.
  await ada.goto(`/settings/collections/${collectionId}/edit`);
  await ada.getByRole("button", { name: "Layout" }).click();
  const layout = ada.getByRole("dialog", { name: "Layout — Lamps" });
  await layout.getByRole("tab", { name: "Search" }).click();
  await layout
    .getByRole("group", { name: "Search in" })
    .getByRole("checkbox", { name: "Key" })
    .click();
  await chooseOption(ada, "Add a filter", "Brand");
  await chooseOption(ada, "Add a filter", "Price");
  await expect(layout.getByRole("group", { name: "Filters" })).toBeVisible();
  await layout.getByRole("button", { name: "Save layout" }).click();
  await expect(layout).toHaveCount(0);

  await ada.goto(`/settings/collections/${collectionId}`);
  const records = ada.getByRole("table", { name: "Records" });
  const search = ada.getByLabel("Search records");
  // Each word appears somewhere in the searched fields, in any order.
  await search.fill("lamp desk");
  await expect(ada.getByText("1 of 3 records")).toBeVisible();
  await expect(records.getByRole("row", { name: "Record Desk lamp" })).toBeVisible();
  await search.fill("lumo");
  await expect(ada.getByText("No record matches.")).toBeVisible();
  await search.fill("");
  await chooseOption(ada, "Brand", "Lumo");
  await expect(ada.getByText("2 of 3 records")).toBeVisible();
  await ada.getByLabel("Price from").fill("20");
  await expect(ada.getByText("1 of 3 records")).toBeVisible();
  await expect(records.getByRole("row", { name: "Record Floor lamp" })).toBeVisible();
  await ada.getByRole("button", { name: "Clear filters" }).click();
  await expect(ada.getByText("3 records")).toBeVisible();
});
