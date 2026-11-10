import { assert, describe, it } from "@effect/vitest";

import { canRun } from "./Automation.ts";

const admin = { userId: "user-ana", role: "admin", state: "active" } as const;
const agent = { status: "active", creatorUserId: "user-ben", isPublished: true } as const;

describe("running an automation", () => {
  it("takes an active admin", () => {
    assert.isTrue(canRun(admin, agent));
    assert.isFalse(canRun({ ...admin, role: "member" }, agent));
    assert.isFalse(canRun({ ...admin, state: "deactivated" }, agent));
  });

  it("takes an active agent that is theirs to use", () => {
    assert.isFalse(canRun(admin, null));
    assert.isFalse(canRun(admin, { ...agent, status: "archived" }));
    assert.isFalse(canRun(admin, { ...agent, isPublished: false }));
    assert.isTrue(canRun(admin, { ...agent, isPublished: false, creatorUserId: admin.userId }));
  });
});
