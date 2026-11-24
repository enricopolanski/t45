import { expect, test } from "../fixtures.ts";
import { expectRpcFailure, rpc } from "../rpc.ts";

const program = `import { readFile } from "node:fs/promises";

const { base, $review } = JSON.parse(await readFile(process.argv[2], "utf8"));
const discount = $review.edits.rows.editor?.discount ?? 0;
const value = base - discount;
const amount = { id: "amount", type: "number", value };
const outputs = { value };
const preview = {
  columns: [{ id: "$label", label: "Name" }, { id: "amount", label: "Total" }],
  rows: [{
    key: "record", label: "Request", cells: { amount: { values: [amount] } },
    history: { results: [amount], sources: [] },
  }],
};
const review = {
  canApprove: true,
  sections: [{
    key: "record", label: "Request", cards: [], forms: [],
    rows: [{
      id: "editor", label: "Total calculation", note: "", isVisible: true,
      metrics: [{ id: "total", label: "Total", value, decimals: 0, unit: "" }],
      form: {
        rowId: "editor",
        editors: [{ id: "discount", label: "Discount", type: "number", value: discount, sourceValue: 0, min: 0, max: 100 }],
      },
    }],
  }],
};

console.log(JSON.stringify($review.isPreview ? { outputs, preview } : { outputs, review }));
`;

test("recalculates manual inputs and completes the step with the approved version", async ({
  signIn,
}) => {
  const page = await signIn("reviewer@example.test");
  await rpc(page, "organization.update", {
    name: "Calculation review",
    avatar: { kind: "initial", color: "slate" },
  });
  const { userId } = (await (await page.request.get("/api/auth/session")).json()) as {
    userId: string;
  };
  const { models } = await rpc<{ models: ReadonlyArray<{ slug: string }> }>(
    page,
    "agents.listModels",
    null,
  );
  const agent = await rpc<{ id: string }>(page, "agents.create", {
    name: "Review program",
    model: models[0]!.slug,
    instructions: "",
    skills: [],
    capabilities: [],
    files: {
      "calculation.json": JSON.stringify({
        entrypoint: "calculate.mjs",
        inputs: ["base"],
        outputs: ["value"],
        review: true,
      }),
      "calculate.mjs": program,
    },
    permissions: { network: "provider" },
    isConversational: false,
  });
  const automation = await rpc<{ id: string }>(page, "automations.create", {
    title: "Review program",
    prompt: "Calculate the total.",
    agentId: agent.id,
  });
  const { workflowId } = await rpc<{ workflowId: string }>(page, "workflows.createWorkflow", {
    name: "Calculation review",
    edits: [
      { type: "add_step", stepId: "intake", parentStepId: null, index: 0, name: "Intake" },
      { type: "add_step", stepId: "review", parentStepId: null, index: 1, name: "Review result" },
      {
        type: "add_field",
        stepId: "intake",
        index: 0,
        field: { id: "base_total", type: "number", label: "Base" },
      },
      {
        type: "add_field",
        stepId: "review",
        index: 0,
        field: { id: "value_out", type: "number", label: "Total" },
      },
    ],
  });
  await page.goto(`/settings/workflows/${workflowId}/steps`);
  const editor = page.getByRole("region", { name: "Step Editor" });
  await editor.getByRole("button", { name: /Review result.*1 field/ }).click();
  for (const [name, option] of [
    ["Calculation automation", "Review program"],
    ["Calculation input base", "Intake › Base"],
    ["Calculation output value", "Total"],
  ] as const) {
    await editor.getByRole("combobox", { name, exact: true }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  }
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("All changes saved.")).toBeVisible();
  const { version } = await rpc<{
    version: {
      id: string;
      revision: number;
      steps: ReadonlyArray<{ id: string; calculator?: unknown }>;
    };
  }>(page, "workflows.getWorkflow", { workflowId });
  expect(version.steps.find(({ id }) => id === "review")?.calculator).toMatchObject({
    review: true,
    id: automation.id,
  });
  const { projectId } = await rpc<{ projectId: string }>(page, "workflows.createProject", {
    workflowId,
    name: "Calculation review",
  });
  for (const stepId of ["intake", "review"])
    await rpc(page, "workflows.addStepMember", { projectId, stepId, userId });
  await rpc(page, "workflows.adoptWorkflowVersion", {
    projectId,
    versionId: version.id,
    revision: version.revision,
  });
  const { stepId } = await rpc<{ stepId: string }>(page, "workflows.startTicket", {
    projectId,
    title: "November request",
  });
  await rpc(page, "workflows.setStepField", { stepId, fieldKey: "base_total", value: 100 });
  await page.goto(`/my-work/${stepId}`);
  await page.getByRole("link", { name: /Review result.*Preliminary results/ }).click();
  await expect(page.getByRole("cell", { name: "100", exact: true })).toBeVisible();
  const { nextStepId } = await rpc<{ nextStepId: string }>(page, "workflows.markStepDone", {
    stepId,
  });
  const getStep = () =>
    rpc<{
      calculatedReview?: { result: { revision: string } | null };
      step: { status: { type: string }; values: { value_out?: number } };
    }>(page, "workflows.getStep", { stepId: nextStepId });
  const discount = page.getByRole("spinbutton", { name: "Discount" });
  await expect(discount).toBeEditable();
  const before = (await getStep()).calculatedReview!.result!;
  await discount.fill("20");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("80", { exact: true })).toBeVisible();
  await expectRpcFailure(
    page,
    "workflows.approveCalculatedStep",
    {
      stepId: nextStepId,
      revision: before.revision,
    },
    "calculation_changed",
  );
  await expectRpcFailure(
    page,
    "workflows.markStepDone",
    { stepId: nextStepId },
    "calculation_changed",
  );
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();
  await rpc(page, "workflows.markStepDone", { stepId: nextStepId });
  const final = await getStep();
  expect(final.step.status.type).toBe("completed");
  expect(final.step.values.value_out).toBe(80);
});
