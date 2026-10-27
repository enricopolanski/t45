import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/one-test-api-import", {
  filename: "fixture.test.ts",
});

describe("t3code/one-test-api-import", () => {
  rule.valid(
    "allows Effect tests that import everything from @effect/vitest",
    `
      import { describe, expect, it } from "@effect/vitest";
      import type { Mock } from "@effect/vitest";
    `,
  );

  rule.valid(
    "allows plain tests that import from vite-plus/test",
    `
      import { expect, it, vi } from "vite-plus/test";
    `,
  );

  rule.invalid(
    "reports a file that imports from both",
    `
      import { it } from "@effect/vitest";
      import { describe } from "vite-plus/test";
    `,
    (output) => {
      assert.match(output, /from @effect\/vitest only/);
    },
  );
});
