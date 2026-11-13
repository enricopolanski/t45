import { expect, test } from "../fixtures.ts";
import {
  addStepMembers,
  createProject,
  createWorkflow,
  nameOrganization,
  saveSteps,
  startItem,
} from "../actions.ts";

test("an item keeps the workflow version it started on", async ({ signIn }) => {
  const ada = await signIn("ada@example.test");
  await nameOrganization(ada);

  // A draft changes freely until a project adopts it.
  const workflowId = await createWorkflow(ada, "Orders");
  await expect(ada.getByText("Version 1 is a draft until a project adopts it.")).toBeVisible();
  await ada.getByRole("button", { name: "Add step" }).click();
  await ada.getByLabel("Step title").fill("Collect");
  await saveSteps(ada);

  // Adoption waits for every step to have a member.
  const projectId = await createProject(ada, workflowId);
  await expect(ada.getByText("No version adopted yet, so no ticket can start.")).toBeVisible();
  const adopt = ada.getByRole("button", { name: "Adopt", exact: true });
  await adopt.click();
  await expect(ada.getByText("Choose at least one active member for every step")).toBeVisible();
  await addStepMembers(ada, "Collect", ["ada"]);
  await adopt.click();
  await expect(ada.getByText("New tickets start on version 1")).toBeVisible();
  await startItem(ada, projectId, "Old order");
  const oldStepUrl = ada.url();

  // The adopted version no longer changes: saving the rename starts version 2 as a draft.
  await ada.goto(`/settings/workflows/${workflowId}/steps`);
  await expect(ada.getByText("Version 1 is in use and no longer changes")).toBeVisible();
  await ada.getByRole("button", { name: /^1 Collect/u }).click();
  await ada.getByLabel("Step title").fill("Gather");
  await saveSteps(ada);
  await expect(ada.getByText("Version 2 is a draft until a project adopts it.")).toBeVisible();

  // Until the project adopts version 2, its new items still start on version 1.
  await startItem(ada, projectId, "Middle order");
  await expect(ada.getByRole("heading", { name: "Collect", exact: true })).toBeVisible();

  await ada.goto(`/settings/projects/${projectId}/edit`);
  await expect(ada.getByText("Adopt version 2")).toBeVisible();
  await adopt.click();
  await expect(ada.getByText("New tickets start on version 2")).toBeVisible();
  await startItem(ada, projectId, "New order");
  await expect(ada.getByRole("heading", { name: "Gather", exact: true })).toBeVisible();

  // The item started before the adoption stays on its own version, and the board shows each.
  await ada.goto(oldStepUrl);
  await expect(ada.getByRole("heading", { name: "Collect", exact: true })).toBeVisible();
  await ada.goto(`/boards/${projectId}`);
  await expect(ada.getByRole("region", { name: "Gather" }).getByText("New order")).toBeVisible();
  await expect(ada.getByText("Old order")).toHaveCount(0);
  await ada.getByRole("combobox", { name: "Workflow version" }).click();
  await ada.getByRole("option", { name: "Version 1" }).click();
  const collect = ada.getByRole("region", { name: "Collect" });
  await expect(collect.getByText("Old order")).toBeVisible();
  await expect(collect.getByText("Middle order")).toBeVisible();
  await expect(ada.getByText("New order")).toHaveCount(0);
});
