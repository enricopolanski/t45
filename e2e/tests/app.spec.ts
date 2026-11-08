import { expect, test } from "../fixtures.ts";

test("the application loads", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to this server" })).toBeVisible();
});
