import { expect, test } from "../fixtures.ts";
import { expectRpcFailure, rpc } from "../rpc.ts";

test("filters overlapping tape discrepancies via Phase 2 reads and discards only confirmed exclusions", async ({
  signIn,
}) => {
  const page = await signIn("reviewer@example.test");
  await page.goto("/onboarding");
  await page.getByLabel("Organization name").fill("Review Test Organization");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("heading", { name: "My work", level: 1 })).toBeVisible();

  const sessionResponse = await page.request.get("/api/auth/session");
  expect(sessionResponse.ok()).toBe(true);
  const session = (await sessionResponse.json()) as { readonly userId: string };

  const collection = await rpc<{ readonly id: string }>(page, "collections.create", {
    title: "Competitor Products",
    fields: [
      { id: "record_key", label: "Key", type: "text" },
      { id: "product_title", label: "Title", type: "text" },
    ],
    primaryKeyFieldId: "record_key",
    memberUserIds: [session.userId],
    isPublished: true,
    layout: { display: { title: "product_title" } },
  });

  await rpc(page, "collections.saveRecord", {
    collectionId: collection.id,
    values: { record_key: "tape-acrylic-90", product_title: "Acrylic 90C Tape" },
  });
  await rpc(page, "collections.saveRecord", {
    collectionId: collection.id,
    values: { record_key: "tape-rubber-90", product_title: "Rubber 90C Tape" },
  });

  const { workflowId } = await rpc<{ readonly workflowId: string }>(
    page,
    "workflows.createWorkflow",
    {
      name: "Market analysis workflow",
      edits: [
        {
          type: "add_step",
          stepId: "source_data",
          parentStepId: null,
          index: 0,
          name: "Source data",
        },
        {
          type: "add_field",
          stepId: "source_data",
          index: 0,
          field: {
            id: "source_records",
            label: "Source records",
            type: "records",
            collectionId: collection.id,
          },
        },
        {
          type: "add_step",
          stepId: "market_analysis",
          parentStepId: null,
          index: 1,
          name: "Market analysis",
        },
        {
          type: "add_field",
          stepId: "market_analysis",
          index: 0,
          field: {
            id: "competitor_products",
            label: "Competitor products",
            type: "records",
            collectionId: collection.id,
            isReviewed: true,
          },
        },
        {
          type: "bind_input",
          stepId: "market_analysis",
          input: { stepId: "source_data", fieldId: "source_records" },
        },
      ],
    },
  );
  const { version } = await rpc<{
    readonly version: { readonly id: string; readonly revision: number };
  }>(page, "workflows.getWorkflow", { workflowId });
  const { projectId } = await rpc<{ readonly projectId: string }>(page, "workflows.createProject", {
    workflowId,
    name: "Tape Proposal Review",
  });
  for (const stepId of ["source_data", "market_analysis"]) {
    await rpc(page, "workflows.addStepMember", { projectId, stepId, userId: session.userId });
  }
  await rpc(page, "workflows.adoptWorkflowVersion", {
    projectId,
    versionId: version.id,
    revision: version.revision,
  });
  const sourceKeys = ["source-large", "source-small"];
  for (const key of sourceKeys) {
    await rpc(page, "collections.saveRecord", {
      collectionId: collection.id,
      values: { record_key: key, product_title: key },
    });
  }
  const initial = await rpc<{ readonly stepId: string }>(page, "workflows.startTicket", {
    projectId,
    title: "Masking Tape",
  });
  await rpc(page, "workflows.setStepField", {
    ...initial,
    fieldKey: "source_records",
    value: sourceKeys,
  });
  const { ticket } = await rpc<{ ticket: { id: string } }>(page, "workflows.getStep", initial);
  await rpc(page, "workflows.markStepDone", initial);
  const { steps } = await rpc<{ steps: ReadonlyArray<{ id: string; stepDefinitionId: string }> }>(
    page,
    "workflows.getTicket",
    { ticketId: ticket.id },
  );
  const stepId = steps.find((entry) => entry.stepDefinitionId === "market_analysis")!.id;

  // Phase 1 proposes two 90 °C tapes with different adhesives.
  await rpc(page, "workflows.proposeStepField", {
    stepId,
    fieldKey: "competitor_products",
    value: "tape-acrylic-90",
    whyYes: "Exact 38 mm width and 50 m roll.",
    whyNo: "Rated 90 °C instead of 100 °C; acrylic adhesive instead of natural rubber.",
    score: 68,
  });
  const rubberProposal = {
    stepId,
    fieldKey: "competitor_products",
    value: "tape-rubber-90",
    whyYes: "Exact 38 mm width, 50 m roll, natural rubber adhesive.",
    whyNo: "Rated 90 °C instead of 100 °C.",
    score: 76,
  };
  await expectRpcFailure(
    page,
    "workflows.proposeStepField",
    { ...rubberProposal, sourceRecordKeys: ["outside-ticket"] },
    "invalid_proposal",
  );
  await rpc(page, "workflows.proposeStepField", {
    ...rubberProposal,
    sourceRecordKeys: sourceKeys,
  });

  // Phase 1 compact read omits proposal ids and rationale.
  const compact = await rpc<{
    readonly proposals: ReadonlyArray<Record<string, unknown>>;
  }>(page, "workflows.getStepFields", {
    stepId,
    fields: [{ key: "competitor_products", recordFields: [] }],
  });
  expect(compact.proposals).toHaveLength(2);
  expect(compact.proposals.every((proposal) => !("id" in proposal) && !("whyNo" in proposal))).toBe(
    true,
  );

  // Phase 2 detailed read returns proposal ids, scores and rationale without loading full records.
  const detailed = await rpc<{
    readonly proposals: ReadonlyArray<{
      readonly id: string;
      readonly value: string;
      readonly score?: number;
      readonly sourceRecordKeys?: ReadonlyArray<string>;
      readonly whyYes: string;
      readonly whyNo: string;
      readonly isDiscarded: boolean;
    }>;
  }>(page, "workflows.getStepFields", {
    stepId,
    fields: [{ key: "competitor_products", recordFields: [], includeProposalDetails: true }],
  });
  const acrylic = detailed.proposals.find((proposal) => proposal.value === "tape-acrylic-90");
  const rubber = detailed.proposals.find((proposal) => proposal.value === "tape-rubber-90");
  expect(acrylic?.id).toBeTruthy();
  expect(rubber?.id).toBeTruthy();
  expect(acrylic?.whyNo).toContain("acrylic adhesive");
  expect(rubber?.score).toBe(76);
  expect(rubber?.sourceRecordKeys).toEqual(sourceKeys);

  // Phase 2 saves overlapping discrepancy questions using the returned proposal ids.
  await rpc(page, "workflows.setProposalFilters", {
    stepId,
    fieldKey: "competitor_products",
    filters: [
      {
        question: "Accept 90 °C maximum temperature?",
        driftSummary: "Both candidates are rated 90 °C instead of 100 °C.",
        items: [
          { proposalId: acrylic!.id, reason: "Rated 90 °C vs 100 °C requirement" },
          { proposalId: rubber!.id, reason: "Rated 90 °C vs 100 °C requirement" },
        ],
      },
      {
        question: "Accept acrylic adhesive?",
        driftSummary: "Uses acrylic adhesive instead of natural rubber.",
        items: [{ proposalId: acrylic!.id, reason: "Acrylic adhesive vs natural rubber" }],
      },
    ],
  });

  await page.goto(`/my-work/${stepId}`);
  await expect(page.getByRole("button", { name: "Review (2)" })).toBeVisible();

  // Accepting every discrepancy offers bulk approval of survivors (or switching to individual review).
  await page.getByRole("button", { name: "Review (2)" }).click();
  const dialog = page.getByRole("dialog", { name: "Review" });
  await expect(dialog.getByText("Accept 90 °C maximum temperature?")).toBeVisible();
  await expect(dialog.getByText("Acrylic 90C Tape")).toBeVisible();
  await expect(dialog.getByText("Rubber 90C Tape")).toBeVisible();
  await dialog.getByRole("button", { name: "Accept this discrepancy" }).click();
  await expect(dialog.getByText("Accept acrylic adhesive?")).toBeVisible();
  await dialog.getByRole("button", { name: "Accept this discrepancy" }).click();
  await expect(dialog.getByRole("heading", { name: "Review summary" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Approve 2" })).toBeVisible();
  await dialog.getByRole("button", { name: "Individual review" }).click();
  await expect(dialog.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(dialog.getByText("2 left")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Accept 90 °C for both tapes, exclude acrylic adhesive, and approve the survivor + discard the excluded tape in one step.
  await page.getByRole("button", { name: "Review (2)" }).click();
  await expect(dialog.getByText("Accept 90 °C maximum temperature?")).toBeVisible();
  await dialog.getByRole("button", { name: "Accept this discrepancy" }).click();
  await expect(dialog.getByText("Accept acrylic adhesive?")).toBeVisible();
  await expect(dialog.getByText("Acrylic 90C Tape")).toBeVisible();
  await expect(dialog.getByText("Rubber 90C Tape")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Exclude 1" }).click();
  await expect(dialog.getByRole("heading", { name: "Review summary" })).toBeVisible();
  await expect(dialog.getByText("To approve (1)")).toBeVisible();
  await expect(dialog.getByText("To discard (1)")).toBeVisible();
  await dialog.getByRole("button", { name: "Approve 1 & discard 1" }).click();
  await expect(dialog).toHaveCount(0);

  // Reload and confirm Rubber 90C Tape is approved/linked while Acrylic 90C Tape is discarded.
  await page.reload();
  await expect(page.getByRole("button", { name: /^Review \(/ })).toHaveCount(0);
  const afterReload = await rpc<{
    readonly fields: ReadonlyArray<{ readonly key: string; readonly value: unknown }>;
    readonly proposals: ReadonlyArray<{
      readonly value: string;
      readonly isDiscarded: boolean;
    }>;
  }>(page, "workflows.getStepFields", {
    stepId,
    fields: [{ key: "competitor_products", recordFields: [], includeProposalDetails: true }],
  });
  expect(afterReload.proposals.find((p) => p.value === "tape-acrylic-90")?.isDiscarded).toBe(true);
  expect(afterReload.proposals.find((p) => p.value === "tape-rubber-90")).toBeUndefined();
  expect(JSON.stringify(afterReload.fields[0]?.value)).toContain("tape-rubber-90");
  const { step } = await rpc<{
    step: { recordAssociations: Record<string, Record<string, ReadonlyArray<string>>> };
  }>(page, "workflows.getStep", { stepId });
  expect(step.recordAssociations.competitor_products).toEqual({ "tape-rubber-90": sourceKeys });
});
