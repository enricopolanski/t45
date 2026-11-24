import { expect, test } from "../fixtures.ts";
import { rpc } from "../rpc.ts";

test("keeps the linked record column order on an already active step", async ({ signIn }) => {
  const page = await signIn("editor@example.test");
  await page.goto("/onboarding");
  await page.getByLabel("Organization name").fill("Records team");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("heading", { name: "My work", level: 1 })).toBeVisible();
  const session = await page.request.get("/api/auth/session");
  const { userId } = (await session.json()) as { userId: string };

  const { id: collectionId } = await rpc<{ id: string }>(page, "collections.create", {
    title: "References",
    fields: [
      { id: "record_key", label: "Key", type: "text" },
      { id: "record_name", label: "Name", type: "text" },
      { id: "record_note", label: "Note", type: "text" },
    ],
    primaryKeyFieldId: "record_key",
    memberUserIds: [userId],
    isPublished: true,
  });
  await rpc(page, "collections.saveRecord", {
    collectionId,
    values: { record_key: "reference-1", record_name: "Sample record", record_note: "Sample note" },
  });
  const stepId = "intake";
  const fieldKey = "references";
  const { workflowId } = await rpc<{ workflowId: string }>(page, "workflows.createWorkflow", {
    name: "Records workflow",
    edits: [
      { type: "add_step", stepId, parentStepId: null, index: 0, name: "Intake" },
      {
        type: "add_field",
        stepId,
        index: 0,
        field: { id: fieldKey, label: "Linked references", type: "records", collectionId },
      },
    ],
  });
  const { projectId } = await rpc<{ projectId: string }>(page, "workflows.createProject", {
    workflowId,
    name: "Records project",
  });
  const getVersion = async () =>
    (
      await rpc<{ version: { id: string; revision: number } }>(page, "workflows.getWorkflow", {
        workflowId,
      })
    ).version;
  const version = await getVersion();
  await rpc(page, "workflows.addStepMember", { projectId, stepId, userId });
  await rpc(page, "workflows.adoptWorkflowVersion", {
    projectId,
    versionId: version.id,
    revision: version.revision,
  });
  const current = await rpc<{ stepId: string }>(page, "workflows.startTicket", {
    projectId,
    title: "Linked records test",
  });
  await rpc(page, "workflows.setStepField", { ...current, fieldKey, value: ["reference-1"] });

  const workUrl = `/my-work/${current.stepId}`;
  const table = page.getByRole("table", { name: "Linked references" });
  const headers = table.getByRole("columnheader");
  await page.goto(workUrl);
  await expect(headers).toHaveText(["Key", "Name", "Note", "Last update", "Actions"]);

  const editorUrl = `/settings/workflows/${workflowId}/steps`;
  await page.goto(editorUrl);
  const editor = page.getByRole("region", { name: "Step Editor" });
  await editor.getByRole("button", { name: /Intake.*1 field/ }).click();
  await editor.getByRole("button", { name: /^Linked references/ }).click();
  await editor.getByRole("switch", { name: "Customize linked record columns" }).click();
  const settings = editor.getByRole("group", { name: "Linked record columns" });
  await settings.getByRole("checkbox", { name: "Key", exact: true }).uncheck();
  await settings.getByRole("checkbox", { name: "Last update" }).uncheck();
  await settings.getByRole("button", { name: "Move Note up", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("All changes saved.")).toBeVisible();
  expect((await getVersion()).id).toBe(version.id);

  await page.goto(workUrl);
  await expect(headers).toHaveText(["Note", "Name", "Actions"]);
  await expect(table.getByText("Sample record")).toBeVisible();
  await expect(table.getByText("Sample note")).toBeVisible();

  await page.goto(editorUrl);
  await editor.getByRole("button", { name: /Intake.*1 field/ }).click();
  await editor.getByRole("button", { name: /^Linked references/ }).click();
  await expect(settings.getByRole("checkbox", { name: "Key", exact: true })).not.toBeChecked();
  await editor.getByRole("switch", { name: "Customize linked record columns" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("All changes saved.")).toBeVisible();

  await page.goto(workUrl);
  await expect(headers).toHaveText(["Key", "Name", "Note", "Last update", "Actions"]);
});
