import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures.ts";
import {
  addStepMembers,
  approveMembers,
  chooseOption,
  createProject,
  createWorkflow,
  nameOrganization,
  saveSteps,
  startItem,
} from "../actions.ts";

test.describe.configure({ mode: "parallel" });

/**
 * A project whose items go through Collect, then Review, which reads Collect's amount and nothing
 * else of it. Ben works on Collect and Cy on Review; Ada administers it and is a member of
 * neither. Ben starts "Order 7" and fills Collect.
 */
const openOrder = async (signIn: (email: string) => Promise<Page>) => {
  const ada = await signIn("ada@example.test");
  await nameOrganization(ada);
  const ben = await signIn("ben@example.test");
  const cy = await signIn("cy@example.test");
  await approveMembers(ada, [ben, cy]);

  const workflowId = await createWorkflow(ada, "Orders");
  await ada.getByRole("button", { name: "Add step" }).click();
  await ada.getByLabel("Step title").fill("Collect");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label").fill("Amount");
  await ada.getByRole("button", { name: "Add field" }).click();
  await ada.getByLabel("Label").nth(1).fill("Supplier");
  await ada.getByRole("button", { name: "Add step" }).click();
  await ada.getByLabel("Step title").nth(1).fill("Review");
  await chooseOption(ada, "Add input", "Collect › Amount", 1);
  await saveSteps(ada);
  const projectId = await createProject(ada, workflowId);
  await addStepMembers(ada, "Collect", ["ben"]);
  await addStepMembers(ada, "Review", ["cy"]);
  await ada.getByRole("button", { name: "Adopt", exact: true }).click();
  await expect(ada.getByText("New tickets start on version 1")).toBeVisible();

  await startItem(ben, projectId, "Order 7");
  await ben.getByLabel("Amount").fill("120");
  await ben.getByLabel("Supplier").fill("Acme");
  await ben.getByLabel("Supplier").blur();
  await expect(
    ben.getByRole("complementary", { name: "History" }).getByText("changed 2 fields"),
  ).toBeVisible();
  return { ada, ben, cy, projectId, collectUrl: ben.url() };
};

const markStepDone = async (member: Page) => {
  await member.getByRole("button", { name: /^Status: To do/u }).click();
  await member.getByRole("menuitem", { name: "Mark done" }).click();
  await member.waitForURL(/\/my-work$/u);
};

const expectStep = (member: Page, name: string) =>
  expect(member.getByRole("heading", { name, exact: true })).toBeVisible();

const expectNothing = (outsider: Page) =>
  expect(outsider.getByRole("alert")).toHaveText("That no longer exists.");

test("an open item shows only to the members of the step it is in", async ({ signIn }) => {
  const { ada, ben, cy, projectId, collectUrl } = await openOrder(signIn);

  // While the item is in Collect, neither the next step's member nor the project's admin opens it.
  for (const outsider of [cy, ada]) {
    await outsider.goto(collectUrl);
    await expectNothing(outsider);
  }
  // The admin manages the item by its title alone.
  await ada.goto(`/settings/projects/${projectId}/edit`);
  await expect(
    ada.getByRole("region", { name: "Open tickets" }).getByText("Order 7"),
  ).toBeVisible();
  await cy.goto(`/boards/${projectId}`);
  await expect(cy.getByRole("region", { name: "Review" })).toBeVisible();
  await expect(cy.getByText("Order 7")).toHaveCount(0);

  // Done in Collect, the item moves to Review: Ben's step closes to him and opens to Cy.
  await markStepDone(ben);
  await ben.goto(collectUrl);
  await expectNothing(ben);
  await cy.goto(`/boards/${projectId}`);
  await cy.getByRole("region", { name: "Review" }).getByText("Order 7").click();
  await expectStep(cy, "Review");
  const inputs = cy.getByRole("region", { name: "Inputs" });
  await expect(inputs.getByLabel("Amount")).toHaveValue("120");
  await expect(cy.getByText("Supplier")).toHaveCount(0);
  await expect(cy.getByText("Acme")).toHaveCount(0);
});

test("a closed item shows whole only to a member of every step", async ({ signIn }) => {
  const { ada, ben, cy, projectId, collectUrl } = await openOrder(signIn);
  await markStepDone(ben);
  await cy.goto(`/boards/${projectId}`);
  await cy.getByRole("region", { name: "Review" }).getByText("Order 7").click();
  await expectStep(cy, "Review");
  const reviewUrl = cy.url();
  await markStepDone(cy);

  // The item closed in Review: that step stays with its members, and no other step opens to them.
  await cy.goto(reviewUrl);
  await expectStep(cy, "Review");
  for (const [outsider, url] of [
    [cy, collectUrl],
    [ben, collectUrl],
    [ben, reviewUrl],
    [ada, collectUrl],
  ] as const) {
    await outsider.goto(url);
    await expectNothing(outsider);
  }

  // Administering the project opened nothing to Ada; being a member of every step does.
  await ada.goto(`/settings/projects/${projectId}/edit`);
  await addStepMembers(ada, "Collect", ["ada"]);
  await addStepMembers(ada, "Review", ["ada"]);
  await ada.goto(collectUrl);
  await expectStep(ada, "Collect");
  await expect(ada.getByRole("region", { name: "Fields" }).getByText("Acme")).toBeVisible();
});
