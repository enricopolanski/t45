import { defineRule } from "@oxlint/plugins";

const TEST_APIS = new Set(["@effect/vitest", "vite-plus/test"]);

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Import the test API from @effect/vitest or vite-plus/test, not both.",
    },
  },
  create(context) {
    let first: string | undefined;
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (!TEST_APIS.has(source)) return;
        first ??= source;
        if (source === first) return;
        context.report({
          node,
          message: `Import the test API from ${first} only: @effect/vitest re-exports vite-plus/test. Files that call vi.mock use vite-plus/test alone, since Vitest hoists mocks only for its own vi.`,
        });
      },
    };
  },
});
