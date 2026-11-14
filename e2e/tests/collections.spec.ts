import type { Page } from "@playwright/test";

import { approveMembers, chooseOption, nameOrganization } from "../actions.ts";
import { test } from "../agent-app.ts";
import { expect } from "../fixtures.ts";

/** Opens a new record on the collection's page, fills its fields and saves it. */
const saveRecord = async (page: Page, key: string, price: string, manual?: string) => {
  await page.getByRole("button", { name: "New record" }).click();
  const dialog = page.getByRole("dialog", { name: "Record" });
  await dialog.getByLabel("Key").fill(key);
  await dialog.getByLabel("Price").fill(price);
  if (manual !== undefined) {
    await dialog.getByLabel("Manual").setInputFiles({
      name: manual,
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 manual"),
    });
    await expect(dialog.getByRole("link", { name: manual })).toBeVisible();
  }
  await dialog.getByRole("button", { name: "Save record" }).click();
  await expect(dialog).toHaveCount(0);
};

const toolText = (result: { readonly content: ReadonlyArray<{ readonly text: string }> }) =>
  result.content[0]!.text;

test("admins define collections whose records people and agents look up and save by key", async ({
  agentApp,
  signIn,
}) => {
  const ada = await signIn("ada@example.test");
  await nameOrganization(ada);
  const ben = await signIn("ben@example.test");
  await approveMembers(ada, [ben]);

  await ada.goto("/settings/collections");
  await ada.getByRole("link", { name: "New collection" }).click();
  await ada.getByLabel("Title").fill("Listings");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label").fill("Price");
  await chooseOption(ada, "Type", "Number");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label").last().fill("Manual");
  await chooseOption(ada, "Type", "File", 1);
  await ada.getByRole("button", { name: "Create collection" }).click();
  await expect(ada.getByRole("heading", { name: "Listings", level: 1 })).toBeVisible();
  const collectionId = new URL(ada.url()).pathname.split("/")[3]!;

  // Saving a key the collection holds replaces that record.
  const records = ada.getByRole("table", { name: "Records" });
  const fileUrl = async (name: string) => {
    await records.getByRole("row", { name: "Record B0ABC" }).click();
    const dialog = ada.getByRole("dialog", { name: "Record" });
    const url = await dialog.getByRole("link", { name }).getAttribute("href");
    await ada.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    return url!;
  };
  await saveRecord(ada, "B0ABC", "4.5", "manual.pdf");
  await expect(records.getByRole("row", { name: "Record B0ABC" })).toContainText("4.5");
  const firstUrl = await fileUrl("manual.pdf");
  expect((await ada.request.get(firstUrl)).status()).toBe(200);
  await saveRecord(ada, "B0ABC", "5", "manual-2.pdf");
  await expect(records.getByRole("row", { name: /^Record / })).toHaveCount(1);
  await expect(records.getByRole("row", { name: "Record B0ABC" })).toContainText("5");
  // The replaced record let go of its file.
  expect((await ada.request.get(firstUrl)).status()).toBe(404);
  const manualUrl = await fileUrl("manual-2.pdf");
  await ada.getByLabel("Search records").fill("missing");
  await expect(ada.getByText("No record matches.")).toBeVisible();
  await ada.getByLabel("Search records").fill("b0a");
  await expect(records.getByRole("row", { name: "Record B0ABC" })).toBeVisible();
  await ada.reload();
  await expect(records.getByRole("row", { name: "Record B0ABC" })).toContainText("5");

  // A member the collection doesn't list sees nothing of it.
  await ben.goto("/settings/collections");
  await expect(ben.getByText("No collection is shared with you yet.")).toBeVisible();
  expect((await ben.request.get(manualUrl!)).status()).toBe(404);

  // An automation's agent reads and writes records through its tools.
  await ada.goto("/settings/automations/runs");
  await ada.getByRole("button", { name: "New automation" }).click();
  await ada.getByLabel("Name", { exact: true }).fill("Check prices");
  await ada.getByLabel("Prompt", { exact: true }).fill("Check the listings' prices.");
  await ada.getByRole("button", { name: "Create automation" }).click();
  await ada.getByRole("button", { name: "Check prices", exact: true }).click();
  await ada.getByRole("button", { name: "Actions for Check prices" }).click();
  await ada.getByRole("menuitem", { name: "Run now", exact: true }).click();
  const run = await agentApp.nextExecution();
  const callTool = (name: string, args: Record<string, unknown>) =>
    agentApp.callTool(run, "collection-tools.mjs", name, args);
  const [listings] = JSON.parse(toolText(await callTool("list", {}))) as Array<{
    readonly id: string;
    readonly primaryKeyFieldId: string;
    readonly fields: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  }>;
  expect(listings?.id).toBe(collectionId);
  const keyId = listings!.primaryKeyFieldId;
  const priceId = listings!.fields.find((field) => field.label === "Price")!.id;
  const found = await callTool("get_record", { collectionId, key: "B0ABC" });
  expect(JSON.parse(toolText(found)).values).toMatchObject({ [keyId]: "B0ABC", [priceId]: 5 });
  expect(toolText(await callTool("get_record", { collectionId, key: "B0NONE" }))).toBe("null");
  const saved = await callTool("save_record", {
    collectionId,
    values: { [keyId]: "B0XYZ", [priceId]: 3 },
  });
  expect(saved.isError).not.toBe(true);
  const refused = await callTool("save_record", {
    collectionId,
    values: { [keyId]: "B0BAD", [priceId]: "three" },
  });
  expect(refused.isError).toBe(true);
  expect(toolText(refused)).toContain("takes a number");
  const search = async (args: Record<string, unknown>) =>
    JSON.parse(toolText(await callTool("search", { collectionId, ...args }))) as {
      readonly records: ReadonlyArray<{ readonly key: string }>;
      readonly hasMore: boolean;
    };
  expect((await search({ filters: { [priceId]: 3 } })).records.map(({ key }) => key)).toEqual([
    "B0XYZ",
  ]);
  const firstPage = await search({ limit: 1 });
  expect(firstPage.records.map(({ key }) => key)).toEqual(["B0ABC"]);
  expect(firstPage.hasMore).toBe(true);
  const lastPage = await search({ limit: 1, offset: 1 });
  expect(lastPage.records.map(({ key }) => key)).toEqual(["B0XYZ"]);
  expect(lastPage.hasMore).toBe(false);
  run.finish();
  await ada.goto(`/settings/collections/${collectionId}`);
  await expect(records.getByRole("row", { name: "Record B0XYZ" })).toContainText("3");

  // In a chat, the agent writes, but reads with the access of the person chatting.
  await ben.goto("/chats");
  await ben.getByRole("button", { name: "New chat" }).click();
  await ben.getByRole("menuitem", { name: "Progress agent" }).click();
  await ben.getByRole("textbox", { name: "Message" }).fill("What does B0ABC cost?");
  await ben.keyboard.press("Enter");
  const chat = await agentApp.nextExecution();
  const lookUp = () =>
    agentApp.callTool(chat, "collection-tools.mjs", "get_record", { collectionId, key: "B0ABC" });
  expect((await lookUp()).isError).toBe(true);
  const written = await agentApp.callTool(chat, "collection-tools.mjs", "save_record", {
    collectionId,
    values: { [keyId]: "B0BEN", [priceId]: 2 },
  });
  expect(written.isError).not.toBe(true);

  // Listing a member lets them, and their chats, use its records.
  await ada.goto(`/settings/collections/${collectionId}/edit`);
  await chooseOption(ada, "New member", "ben");
  await ada.getByRole("button", { name: "Save collection" }).click();
  await ada.waitForURL(/\/collections\/[^/]+$/u);
  expect(JSON.parse(toolText(await lookUp())).values[priceId]).toBe(5);
  await ben.goto("/settings/collections");
  await ben.getByRole("link", { name: /^Listings/u }).click();
  await expect(ben.getByRole("table", { name: "Records" })).toContainText("B0BEN");
  expect((await ben.request.get(manualUrl!)).status()).toBe(200);
  chat.finish();
});
