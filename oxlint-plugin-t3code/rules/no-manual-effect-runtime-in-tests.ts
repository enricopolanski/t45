import { defineRule, type ESTree } from "@oxlint/plugins";

import { isIdentifier, propertyName, TEST_FILE_PATTERN, unwrapExpression } from "../utils.ts";

const EFFECT_RUNTIME_METHODS = new Set([
  "runCallback",
  "runCallbackWith",
  "runFork",
  "runForkWith",
  "runPromise",
  "runPromiseExit",
  "runPromiseExitWith",
  "runPromiseWith",
  "runSync",
  "runSyncExit",
  "runSyncExitWith",
  "runSyncWith",
]);

const manualRunnerName = (callee: ESTree.Node): string | undefined => {
  const expression = unwrapExpression(callee);
  if (expression.type !== "MemberExpression") return undefined;

  const object = unwrapExpression(expression.object);
  const property = propertyName(expression.property);
  if (property === undefined) return undefined;

  if (isIdentifier(object, "Effect") && EFFECT_RUNTIME_METHODS.has(property)) {
    return `Effect.${property}`;
  }

  if (isIdentifier(object, "ManagedRuntime") && property === "make") {
    return "ManagedRuntime.make";
  }

  return undefined;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow manually creating or running Effect runtimes in tests; use @effect/vitest.",
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};

    return {
      CallExpression(node) {
        const runner = manualRunnerName(node.callee);
        if (runner === undefined) return;

        context.report({
          node: node.callee,
          message: `Do not use ${runner} in tests. Use @effect/vitest with it.effect(...) and test layers instead.`,
        });
      },
    };
  },
});
