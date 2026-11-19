import {
  addStepMembers,
  createProject,
  createWorkflow,
  nameOrganization,
  saveSteps,
  startItem,
} from "../actions.ts";
import { expect, test } from "../fixtures.ts";

test("a project admin can cancel an item with or without a reason", async ({ signIn }) => {
  const ada = await signIn("ada@example.test");
  await nameOrganization(ada);
  const workflowId = await createWorkflow(ada, "Orders");
  await ada.getByRole("button", { name: "Add step" }).click();
  await ada.getByLabel("Step title").fill("Collect");
  await saveSteps(ada);
  const projectId = await createProject(ada, workflowId);
  await addStepMembers(ada, "Collect", ["ada"]);
  await ada.getByRole("button", { name: "Adopt", exact: true }).click();
  await expect(ada.getByText("New tickets start on version 1")).toBeVisible();

  await startItem(ada, projectId, "Order 7");
  const status = ada.getByRole("button", { name: /^Status:/u });
  const dialog = ada.getByRole("dialog", { name: "Cancel this item" });
  await status.click();
  await ada.getByRole("menuitem", { name: "Cancel item" }).click();
  await expect(dialog.getByLabel("Reason (optional)")).toHaveValue("");
  await dialog.getByRole("button", { name: "Cancel item" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(ada.getByText("Cancelled", { exact: true })).toBeVisible();

  await startItem(ada, projectId, "Order 8");
  const itemUrl = ada.url();
  await ada.goto(`/settings/projects/${projectId}/edit`);
  const tickets = ada.getByRole("region", { name: "Open tickets" });
  await tickets
    .getByRole("listitem")
    .filter({ hasText: "Order 8" })
    .getByRole("button", {
      name: "Cancel",
      exact: true,
    })
    .click();
  await expect(dialog.getByRole("button", { name: "Cancel item" })).toBeEnabled();
  await dialog.getByLabel("Reason (optional)").fill("Supplier withdrew the offer.");
  await dialog.getByRole("button", { name: "Cancel item" }).click();
  await expect(tickets.getByText("Order 8", { exact: true })).toHaveCount(0);
  await ada.goto(itemUrl);
  await expect(
    ada.getByText("Cancelled: Supplier withdrew the offer.", { exact: true }),
  ).toBeVisible();
});
