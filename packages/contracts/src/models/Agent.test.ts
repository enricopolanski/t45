import { assert, describe, it } from "@effect/vitest";

import { canManage, canUse } from "./Agent.ts";

const creator = { userId: "user-ana", role: "member" } as const;
const other = { userId: "user-ben", role: "member" } as const;
const admin = { userId: "user-admin", role: "admin" } as const;
const privateAgent = { creatorUserId: creator.userId, isPublished: false };
const publishedAgent = { ...privateAgent, isPublished: true };

describe("a custom agent", () => {
  it("works for its creator alone while private, admins included", () => {
    assert.isTrue(canUse(privateAgent, creator.userId));
    assert.isFalse(canUse(privateAgent, other.userId));
    assert.isFalse(canUse(privateAgent, admin.userId));
  });

  it("works for everyone once published", () => {
    assert.isTrue(canUse(publishedAgent, other.userId));
  });

  it("is managed by its creator and admins, published or not", () => {
    assert.isTrue(canManage(privateAgent, creator));
    assert.isTrue(canManage(privateAgent, admin));
    assert.isFalse(canManage(privateAgent, other));
    assert.isFalse(canManage(publishedAgent, other));
  });
});
