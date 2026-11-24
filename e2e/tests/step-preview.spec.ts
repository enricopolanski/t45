import { expect, test } from "../fixtures.ts";
import { rpc } from "../rpc.ts";

test("configures an upcoming step's live read-only preview from ordered workflow fields", async ({
  signIn,
}) => {
  const page = await signIn("editor@example.test");
  await page.goto("/onboarding");
  await page.getByLabel("Organization name").fill("Document review");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("heading", { name: "My work", level: 1 })).toBeVisible();
  const session = await page.request.get("/api/auth/session");
  const { userId } = (await session.json()) as { userId: string };
  const { workflowId } = await rpc<{ workflowId: string }>(page, "workflows.createWorkflow", {
    name: "Document workflow",
    edits: [
      {
        type: "add_step",
        stepId: "intake",
        parentStepId: null,
        index: 0,
        name: "Intake",
      },
      {
        type: "add_step",
        stepId: "review",
        parentStepId: null,
        index: 1,
        name: "Review documents",
      },
      ...["Document title", "Finding", "Internal note"].flatMap((label, index) => {
        const fieldId = ["document", "finding", "internal"][index]!;
        return [
          {
            type: "add_field",
            stepId: "intake",
            index,
            field: { id: fieldId, label, type: "text" },
          },
          { type: "bind_input", stepId: "review", input: { stepId: "intake", fieldId } },
        ];
      }),
    ],
  });

  await page.goto(`/settings/workflows/${workflowId}/steps`);
  const editor = page.getByRole("region", { name: "Step Editor" });
  await editor.getByRole("button", { name: /Review documents.*0 fields/ }).click();
  await editor.getByRole("switch", { name: "Show preview during the preceding step" }).click();
  await editor.getByRole("combobox", { name: "Add preview field" }).click();
  await page.getByRole("option", { name: "Intake › Finding" }).click();
  await editor.getByRole("button", { name: "Move Intake › Finding up", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("All changes saved.")).toBeVisible();

  const { version } = await rpc<{
    version: {
      id: string;
      revision: number;
      steps: ReadonlyArray<{ id: string; previewFields?: unknown }>;
    };
  }>(page, "workflows.getWorkflow", { workflowId });
  expect(version.steps.find(({ id }) => id === "review")?.previewFields).toEqual([
    { stepId: "intake", fieldId: "finding" },
    { stepId: "intake", fieldId: "document" },
  ]);
  const { projectId } = await rpc<{ projectId: string }>(page, "workflows.createProject", {
    workflowId,
    name: "Document review",
  });
  for (const stepId of ["intake", "review"])
    await rpc(page, "workflows.addStepMember", { projectId, stepId, userId });
  await rpc(page, "workflows.adoptWorkflowVersion", {
    projectId,
    versionId: version.id,
    revision: version.revision,
  });
  const current = await rpc<{ stepId: string }>(page, "workflows.startTicket", {
    projectId,
    title: "January report",
  });
  async function fill(fieldKey: string, value: string) {
    await rpc(page, "workflows.setStepField", { ...current, fieldKey, value });
  }
  await fill("document", "Monthly report");
  await fill("finding", "Review pending");
  await fill("internal", "Working note");

  await page.goto(`/my-work/${current.stepId}`);
  await page.getByRole("link", { name: /Review documents.*Preliminary results/ }).click();
  await expect(page.getByRole("heading", { name: "Review documents", exact: true })).toBeVisible();
  const fields = page.getByRole("textbox");
  await expect(fields).toHaveCount(2);
  await expect(fields.first()).toHaveValue("Review pending");
  await expect(fields.last()).toHaveValue("Monthly report");
  await expect(fields.first()).toHaveAttribute("readonly", "");
  await expect(page.getByText("Internal note", { exact: true })).toHaveCount(0);

  await fill("finding", "Complete");
  await expect(fields.first()).toHaveValue("Complete");
  const entered = await rpc<{ nextStepId: string | null }>(page, "workflows.markStepDone", current);
  expect(entered.nextStepId).toBeNull();
  await expect(page).toHaveURL(/\/my-work\/(?!preview\/)[\w-]+$/u);
});
