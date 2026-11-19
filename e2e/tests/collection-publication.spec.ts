import { expect, test } from "../fixtures.ts";

test("publishing a collection puts it in the main menu with read access for members", async ({
  signIn,
}) => {
  const admin = await signIn("ada@example.test");
  await admin.goto("/onboarding");
  await admin.getByLabel("Organization name").fill("Example");
  await admin.getByRole("button", { name: "Create organization" }).click();
  await expect(admin.getByRole("heading", { name: "My work" })).toBeVisible();

  const member = await signIn("ben@example.test");
  await admin.goto("/settings/people");
  await admin.getByRole("button", { name: "Approve" }).click();
  await expect(admin.getByRole("button", { name: "Approve" })).toHaveCount(0);

  await admin.goto("/settings/collections/new");
  await admin.getByLabel("Title").fill("Listings");
  await admin.getByRole("button", { name: "Create collection" }).click();
  await expect(admin.getByRole("heading", { name: "Listings" })).toBeVisible();
  const settingsPath = new URL(admin.url()).pathname;
  const collectionPath = settingsPath.replace("/settings", "");
  await admin.getByRole("button", { name: "New record" }).click();
  const record = admin.getByRole("dialog", { name: "Record" });
  await record.getByLabel("Key").fill("Listing A");
  await record.getByRole("button", { name: "Save record" }).click();
  await expect(admin.getByRole("row", { name: "Record Listing A" })).toBeVisible();

  const changePublication = async () => {
    await admin.getByRole("link", { name: "Edit collection" }).click();
    await admin.getByRole("switch", { name: "Publish to the organization" }).click();
    await admin.getByRole("button", { name: "Save collection" }).click();
    await expect(admin).toHaveURL(settingsPath);
  };

  await changePublication();
  await admin.goto("/my-work");
  await admin
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Listings" })
    .click();
  await expect(admin).toHaveURL(collectionPath);
  await expect(admin.getByRole("button", { name: "New record" })).toBeVisible();
  await expect(admin.getByRole("navigation", { name: "Main" })).toBeVisible();

  await member.goto("/my-work");
  const mainMenu = member.getByRole("navigation", { name: "Main" });
  await mainMenu.getByRole("link", { name: "Listings" }).click();
  await expect(member).toHaveURL(collectionPath);
  await expect(member.getByRole("row", { name: "Record Listing A" })).toBeVisible();
  await expect(member.getByRole("button", { name: "New record" })).toHaveCount(0);
  await member.getByRole("searchbox", { name: "Search records" }).fill("Listing A");
  await member.getByRole("row", { name: "Record Listing A" }).click();
  await expect(member.getByRole("heading", { name: "Listing A" })).toBeVisible();
  await expect(member.getByRole("button", { name: "Save record" })).toHaveCount(0);
  await expect(mainMenu.getByRole("link", { name: "Listings" })).toBeVisible();

  await admin.goto(settingsPath);
  await changePublication();
  await member.goto(collectionPath);
  await expect(member.getByRole("alert")).toContainText("That no longer exists.");
  await member.goto("/settings/collections");
  await expect(member.getByText("No collection is shared with you yet.")).toBeVisible();
  await expect(mainMenu.getByRole("link", { name: "Listings" })).toHaveCount(0);
});
