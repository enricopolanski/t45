import { chooseOption, nameOrganization } from "../actions.ts";
import { test } from "../agent-app.ts";
import { expect } from "../fixtures.ts";

test("a collection shows its records a page at a time, and a new search starts on the first", async ({
  agentApp,
  signIn,
}) => {
  const ada = await signIn("ada@example.test");
  await nameOrganization(ada);
  await ada.goto("/settings/collections/new");
  await ada.getByLabel("Title", { exact: true }).fill("Lamps");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label", { exact: true }).fill("Price");
  await chooseOption(ada, "Type", "Number");
  await ada.getByRole("button", { name: "Create collection" }).click();
  await expect(ada.getByRole("heading", { name: "Lamps", level: 1 })).toBeVisible();
  const path = new URL(ada.url()).pathname;
  const collectionId = path.split("/")[3]!;

  await ada.goto("/settings/automations/runs");
  await ada.getByRole("button", { name: "New automation" }).click();
  await ada.getByLabel("Name", { exact: true }).fill("Stock lamps");
  await ada.getByLabel("Prompt", { exact: true }).fill("Import the lamps.");
  await ada.getByRole("button", { name: "Create automation" }).click();
  await ada.getByRole("button", { name: "Stock lamps", exact: true }).click();
  await ada.getByRole("button", { name: "Actions for Stock lamps" }).click();
  await ada.getByRole("menuitem", { name: "Run now", exact: true }).click();
  const run = await agentApp.nextExecution();
  const callTool = (name: string, args: Record<string, unknown>) =>
    agentApp.callTool(run, "collection-tools.mjs", name, args);
  const [lamps] = JSON.parse((await callTool("list", {})).content[0]!.text) as Array<{
    readonly primaryKeyFieldId: string;
    readonly fields: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  }>;
  const priceId = lamps!.fields.find((field) => field.label === "Price")!.id;
  await agentApp.writeFile(
    "lamps.jsonl",
    Array.from(
      { length: 30 },
      (_, at) =>
        `${JSON.stringify({ [lamps!.primaryKeyFieldId]: `Lamp ${String(at + 1).padStart(2, "0")}`, [priceId]: at + 1 })}\n`,
    ).join(""),
  );
  expect(
    (await callTool("import_records", { collectionId, path: "lamps.jsonl" })).content[0]!.text,
  ).toBe("Saved 30 of 30 records.");
  run.finish();

  await ada.goto(path);
  const records = ada.getByRole("table", { name: "Records" });
  const pages = ada.getByRole("navigation", { name: "Pages" });
  await expect(pages.getByText("1–25 of 30")).toBeVisible();
  await expect(records.getByRole("row", { name: /^Record / })).toHaveCount(25);
  await pages.getByRole("button", { name: "Next page" }).click();
  await expect(pages.getByText("26–30 of 30")).toBeVisible();
  await expect(records.getByRole("row", { name: /^Record / })).toHaveCount(5);
  await expect(records.getByRole("row", { name: "Record Lamp 30" })).toBeVisible();
  await expect(pages.getByRole("button", { name: "Page 2" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  // The page is in the address, so a reload or a shared link opens the same one.
  await ada.reload();
  await expect(pages.getByText("26–30 of 30")).toBeVisible();
  await ada.getByLabel("Search records").fill("lamp 07");
  await expect(ada.getByText("1 of 30 records")).toBeVisible();
  await expect(records.getByRole("row", { name: "Record Lamp 07" })).toBeVisible();
  await expect(pages).toHaveCount(0);
  expect(new URL(ada.url()).search).toBe("");
});
