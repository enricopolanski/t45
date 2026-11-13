import type { Page } from "@playwright/test";

import { expect } from "./fixtures.ts";

// After a sign-in the app sends whoever isn't a member yet to the page for their state. On a cold
// dev server that redirect sometimes crashes the page, so these open that page themselves.

/** The first person to sign in names the organization and is its admin. */
export const nameOrganization = async (admin: Page) => {
  await admin.goto("/onboarding");
  await admin.getByLabel("Organization name").fill("Example");
  await admin.getByRole("button", { name: "Create organization" }).click();
  await expect(admin.getByRole("heading", { name: "My work", level: 1 })).toBeVisible();
};

/** `admin` lets in everyone who signed in after them; each then opens the app. */
export const approveMembers = async (admin: Page, members: ReadonlyArray<Page>) => {
  await admin.goto("/settings/people");
  const approve = admin.getByRole("button", { name: "Approve" });
  await expect(approve).toHaveCount(members.length);
  for (let waiting = members.length; waiting > 0; waiting -= 1) {
    await approve.first().click();
    await expect(approve).toHaveCount(waiting - 1);
  }
  for (const member of members) {
    await member.goto("/my-work");
    await expect(member.getByRole("heading", { name: "My work", level: 1 })).toBeVisible();
  }
};

export const chooseOption = async (page: Page, combobox: string, option: string, nth = 0) => {
  await page.getByRole("combobox", { name: combobox }).nth(nth).click();
  await page.getByRole("option", { name: option }).click();
};

/** Creates a workflow and leaves `editor` in its step editor; answers the workflow's id. */
export const createWorkflow = async (editor: Page, name: string) => {
  await editor.goto("/settings/workflows/new");
  await editor.getByLabel("Workflow name").fill(name);
  await editor.getByRole("button", { name: "Create workflow" }).click();
  await editor.waitForURL(/\/settings\/workflows\/[^/]+\/steps$/u);
  return new URL(editor.url()).pathname.split("/")[3]!;
};

export const saveSteps = async (editor: Page) => {
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.getByText("All changes saved.")).toBeVisible();
};

/** Creates a project of the workflow and leaves `admin` on its page; answers the project's id. */
export const createProject = async (admin: Page, workflowId: string) => {
  await admin.goto(`/settings/projects/new?workflowId=${workflowId}`);
  await admin.getByRole("button", { name: "Create project" }).click();
  await admin.waitForURL(/\/settings\/projects\/[^/]+\/edit$/u);
  return new URL(admin.url()).pathname.split("/")[3]!;
};

/** On the project's page, opens `step` and makes each of `people` a member of it. */
export const addStepMembers = async (admin: Page, step: string, people: ReadonlyArray<string>) => {
  await admin.locator("summary", { hasText: step }).click();
  for (const person of people) {
    await chooseOption(admin, `New member of ${step}`, person);
    await expect(
      admin.getByRole("button", { name: `Remove ${person} from ${step}` }),
    ).toBeVisible();
  }
};

/** Starts an item from the project's board and leaves `member` on its first step. */
export const startItem = async (member: Page, projectId: string, title: string) => {
  await member.goto(`/boards/${projectId}`);
  await member.getByRole("button", { name: "New item" }).click();
  await member.getByLabel("Title").fill(title);
  await member.getByRole("button", { name: "Start" }).click();
  await expect(member.getByRole("region", { name: "Open step" })).toBeVisible();
};
