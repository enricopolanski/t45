import type { Page } from "@playwright/test";

import { approveMembers, nameOrganization } from "../actions.ts";
import { expect, test } from "../fixtures.ts";

const call = (page: Page, method: string, payload?: unknown) =>
  page.evaluate(
    async ({ method, payload }) => {
      const modulePath = "/src/rpc/api.ts";
      const { api } = (await import(modulePath)) as {
        readonly api: (method: string, payload: unknown) => Promise<unknown>;
      };
      try {
        return { ok: true, value: await api(method, payload) };
      } catch (error) {
        if (typeof error === "object" && error !== null && "_tag" in error) {
          return { ok: false, error: error._tag };
        }
        throw error;
      }
    },
    { method, payload },
  );

test("admins import and replace capability bundles; members can only read them", async ({
  page,
  signIn,
}) => {
  const admin = await signIn("admin@example.test");
  await nameOrganization(admin);
  const member = await signIn("member@example.test");
  await approveMembers(admin, [member]);

  const capability = {
    id: "example-capability",
    name: "Example capability",
    description: "Runs an example MCP server.",
    files: { "example.mjs": "console.log('example');" },
    mcpServers: {
      example: { type: "local", command: ["node", "/opt/t45/example.mjs"], codemode: false },
    },
  };
  const another = {
    id: "another-capability",
    name: "Another capability",
    description: "Another declarative bundle.",
  };

  expect(await call(admin, "capabilities.list")).toMatchObject({ ok: true });
  expect(
    await call(admin, "capabilities.import", { capabilities: [capability, another] }),
  ).toMatchObject({ ok: true });
  expect(await call(member, "capabilities.get", { capabilityId: capability.id })).toEqual({
    ok: true,
    value: capability,
  });
  expect(await call(member, "capabilities.list")).toEqual({
    ok: true,
    value: expect.arrayContaining([another, capability]),
  });

  const updated = { ...capability, files: { "example.mjs": "console.log('updated');" } };
  expect(await call(member, "capabilities.import", { capabilities: [updated] })).toEqual({
    ok: false,
    error: "AccessDenied",
  });
  expect(await call(admin, "capabilities.get", { capabilityId: capability.id })).toEqual({
    ok: true,
    value: capability,
  });
  expect(await call(admin, "capabilities.import", { capabilities: [updated] })).toMatchObject({
    ok: true,
  });
  expect(await call(member, "capabilities.list")).toEqual({
    ok: true,
    value: expect.arrayContaining([another, updated]),
  });
  expect(await call(member, "capabilities.get", { capabilityId: "missing-capability" })).toEqual({
    ok: false,
    error: "NotFound",
  });

  await page.goto("/login");
  expect(await call(page, "capabilities.list")).toEqual({ ok: false, error: "AccessDenied" });
  expect(await call(page, "capabilities.get", { capabilityId: capability.id })).toEqual({
    ok: false,
    error: "AccessDenied",
  });
  expect(await call(page, "capabilities.import", { capabilities: [updated] })).toEqual({
    ok: false,
    error: "AccessDenied",
  });
});

test("an agent can select several stored capabilities and change the selection", async ({
  signIn,
}) => {
  const admin = await signIn("admin@example.test");
  await nameOrganization(admin);
  const capabilities = ["Calendar", "Mail", "Documents", "Search"].map((name) => ({
    id: `example-${name.toLowerCase()}`,
    name,
    description: `${name} integration.`,
    files: { [`${name.toLowerCase()}.txt`]: name },
  }));
  expect(await call(admin, "capabilities.import", { capabilities })).toMatchObject({ ok: true });

  await admin.goto("/settings/agents/new");
  await admin.getByLabel("Name", { exact: true }).fill("Office assistant");
  for (const capability of capabilities) {
    await admin.getByRole("checkbox", { name: `Use ${capability.name}` }).check();
  }
  await admin.getByRole("button", { name: "Create agent", exact: true }).click();
  await admin.waitForURL("/settings/agents");
  await admin.getByRole("link", { name: "Office assistant", exact: true }).click();
  for (const capability of capabilities) {
    await expect(admin.getByRole("checkbox", { name: `Use ${capability.name}` })).toBeChecked();
  }

  const agentId = new URL(admin.url()).pathname.split("/").at(-1)!;
  expect(await call(admin, "agents.get", { agentId })).toMatchObject({
    ok: true,
    value: { capabilities: capabilities.map((capability) => capability.id).sort() },
  });
  await admin.getByRole("checkbox", { name: "Use Mail" }).uncheck();
  await admin.getByRole("button", { name: "Save agent", exact: true }).click();
  await admin.waitForURL("/settings/agents");
  await admin.getByRole("link", { name: "Office assistant", exact: true }).click();
  await expect(admin.getByRole("checkbox", { name: "Use Mail" })).not.toBeChecked();
  for (const name of ["Calendar", "Documents", "Search"]) {
    await expect(admin.getByRole("checkbox", { name: `Use ${name}` })).toBeChecked();
  }
  const loaded = await call(admin, "agents.get", { agentId });
  expect(loaded).toMatchObject({ ok: true });
  if (!loaded.ok || typeof loaded.value !== "object" || loaded.value === null)
    throw new Error("Agent did not load");
  expect(
    await call(admin, "agents.update", {
      ...loaded.value,
      agentId,
      capabilities: ["missing-capability"],
    }),
  ).toEqual({ ok: false, error: "AgentRefused" });
});
