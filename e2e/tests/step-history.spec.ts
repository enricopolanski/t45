import { expect, test } from "../fixtures.ts";
import {
  addStepMembers,
  approveMembers,
  createProject,
  createWorkflow,
  nameOrganization,
  saveSteps,
  startItem,
} from "../actions.ts";

test("history groups consecutive actions by actor and counts distinct fields", async ({
  signIn,
}) => {
  const ada = await signIn("ada@example.test");
  await nameOrganization(ada);
  const ben = await signIn("ben@example.test");
  await approveMembers(ada, [ben]);

  const workflowId = await createWorkflow(ada, "Orders");
  await ada.getByRole("button", { name: "Add step" }).click();
  await ada.getByLabel("Step title").fill("Collect");
  for (const [index, label] of ["Amount", "Supplier"].entries()) {
    await ada.getByRole("button", { name: "Add field" }).click();
    await ada.getByLabel("Label").nth(index).fill(label);
  }
  await saveSteps(ada);
  const projectId = await createProject(ada, workflowId);
  await addStepMembers(ada, "Collect", ["ada", "ben"]);
  await ada.getByRole("button", { name: "Adopt", exact: true }).click();
  await expect(ada.getByText("New tickets start on version 1")).toBeVisible();
  await startItem(ada, projectId, "Order 7");
  await ben.goto(ada.url());

  const history = ada.getByRole("complementary", { name: "History" });
  const rows = history.getByRole("listitem");
  for (const [field, value] of [
    ["Amount", "120"],
    ["Supplier", "Acme"],
    ["Amount", "130"],
  ] as const) {
    await ada.getByLabel(field, { exact: true }).fill(value);
    await ada.getByLabel(field, { exact: true }).blur();
    // The other member receives the saved change through the step's live feed.
    await expect(ben.getByLabel(field, { exact: true })).toHaveValue(value);
  }
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("ada");
  await expect(rows.nth(1)).toContainText("changed 2 fields");

  await ben.getByLabel("Supplier", { exact: true }).fill("Example");
  await ben.getByLabel("Supplier", { exact: true }).blur();
  await expect(ada.getByLabel("Supplier", { exact: true })).toHaveValue("Example");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText("ben");
  await expect(rows.nth(2)).toContainText("changed a field");

  for (const body of ["Confirmed supplier", "Ready for review"]) {
    await ada.getByLabel("New comment").fill(body);
    await ada.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(ben.getByRole("region", { name: "Comments" }).getByText(body)).toBeVisible();
    await expect(ada.getByLabel("New comment")).toHaveValue("");
  }
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(3)).toContainText("commented 2 times");

  // A different action ends the group, even when the same person edits another field later.
  await ada.getByLabel("Amount", { exact: true }).fill("140");
  await ada.getByLabel("Amount", { exact: true }).blur();
  await expect(ben.getByLabel("Amount", { exact: true })).toHaveValue("140");
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(4)).toContainText("ada");
  await expect(rows.nth(4)).toContainText("changed a field");
  await ada.reload();
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(1)).toContainText("changed 2 fields");
  await expect(rows.nth(3)).toContainText("commented 2 times");
});
