import { expect, test } from "../fixtures.ts";
import { expectRpcFailure, rpc } from "../rpc.ts";

test("associates linked records with the source field chosen in the step editor", async ({
  signIn,
}) => {
  const page = await signIn("editor@example.test");
  await page.goto("/onboarding");
  await page.getByLabel("Organization name").fill("Document reviews");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("heading", { name: "My work", level: 1 })).toBeVisible();
  const session = await page.request.get("/api/auth/session");
  const { userId } = (await session.json()) as { userId: string };

  const { id: collectionId } = await rpc<{ id: string }>(page, "collections.create", {
    title: "Documents",
    fields: [{ id: "document_key", label: "Name", type: "text" }],
    primaryKeyFieldId: "document_key",
    memberUserIds: [userId],
    isPublished: true,
  });
  for (const key of ["First source", "Second source", "Response", "Unlinked source"]) {
    await rpc(page, "collections.saveRecord", { collectionId, values: { document_key: key } });
  }

  const source = { stepId: "intake01", fieldId: "documents" };
  const review = "review01";
  const fieldKey = "responses";
  const { workflowId } = await rpc<{ workflowId: string }>(page, "workflows.createWorkflow", {
    name: "Document review",
    edits: [
      { type: "add_step", stepId: source.stepId, parentStepId: null, index: 0, name: "Intake" },
      { type: "add_step", stepId: review, parentStepId: null, index: 1, name: "Review" },
      {
        type: "add_field",
        stepId: source.stepId,
        index: 0,
        field: { id: source.fieldId, label: "Documents", type: "records", collectionId },
      },
      {
        type: "add_field",
        stepId: review,
        index: 0,
        field: { id: fieldKey, label: "Responses", type: "records", collectionId },
      },
      { type: "bind_input", stepId: review, input: source },
    ],
  });

  await page.goto(`/settings/workflows/${workflowId}/steps`);
  const editor = page.getByRole("region", { name: "Step Editor" });
  await editor.getByRole("button", { name: /Review.*1 field/ }).click();
  await editor.getByRole("button", { name: /^Responses/ }).click();
  await editor.getByRole("combobox", { name: "Source records" }).click();
  await page.getByRole("option", { name: "Intake › Documents" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("All changes saved.")).toBeVisible();

  const { version } = await rpc<{ version: { id: string; revision: number } }>(
    page,
    "workflows.getWorkflow",
    { workflowId },
  );
  const { projectId } = await rpc<{ projectId: string }>(page, "workflows.createProject", {
    workflowId,
    name: "Document review",
  });
  for (const stepId of [source.stepId, review])
    await rpc(page, "workflows.addStepMember", { projectId, stepId, userId });
  await rpc(page, "workflows.adoptWorkflowVersion", {
    projectId,
    versionId: version.id,
    revision: version.revision,
  });
  const current = await rpc<{ stepId: string }>(page, "workflows.startTicket", {
    projectId,
    title: "Check documents",
  });
  await rpc(page, "workflows.setStepField", {
    stepId: current.stepId,
    fieldKey: source.fieldId,
    value: ["First source", "Second source"],
  });
  const { ticket } = await rpc<{ ticket: { id: string } }>(page, "workflows.getStep", current);
  await rpc(page, "workflows.markStepDone", { stepId: current.stepId });
  const { steps } = await rpc<{ steps: ReadonlyArray<{ id: string; stepDefinitionId: string }> }>(
    page,
    "workflows.getTicket",
    { ticketId: ticket.id },
  );
  const stepId = steps.find(({ stepDefinitionId }) => stepDefinitionId === review)!.id;
  await expectRpcFailure(
    page,
    "workflows.setRecordAssociation",
    { stepId, fieldKey, recordKey: "Response", sourceRecordKeys: ["Unlinked source"] },
    "invalid_field_value",
  );
  await page.goto(`/my-work/${stepId}`);
  await page.getByRole("button", { name: "Link record" }).click();
  await page.getByRole("row", { name: "Record Response", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Choose source records" });
  await expect(dialog.getByRole("checkbox")).toHaveCount(2);
  await dialog.getByRole("checkbox", { name: "Second source" }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Responses" }).getByText("Second source", { exact: true }),
  ).toBeVisible();
});
