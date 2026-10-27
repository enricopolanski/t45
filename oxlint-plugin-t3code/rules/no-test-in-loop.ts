import { defineRule, type ESTree } from "@oxlint/plugins";

import { propertyName, TEST_FILE_PATTERN, unwrapExpression } from "../utils.ts";

// Calls that declare a test or a group of tests; all of them expose `.each`.
const TEST_FUNCTIONS = new Set(["describe", "it", "suite", "test"]);
// Modifiers whose tester also exposes `.each` (@effect/vitest's `it.effect` and `it.live`).
const EACH_CAPABLE_MODIFIERS = new Set(["effect", "live"]);
const LOOPS = new Set(["ForStatement", "ForInStatement", "ForOfStatement"]);
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);

/** Returns the reported name for `it(…)`, `describe(…)`, `it.effect(…)`, and friends. */
const testCallName = (callee: ESTree.Node): string | undefined => {
  const expression = unwrapExpression(callee);

  if (expression.type === "Identifier") {
    return TEST_FUNCTIONS.has(expression.name) ? expression.name : undefined;
  }

  if (expression.type !== "MemberExpression") return undefined;
  const object = unwrapExpression(expression.object);
  const property = propertyName(expression.property);
  if (property === undefined || !EACH_CAPABLE_MODIFIERS.has(property)) return undefined;
  if (object.type !== "Identifier" || !TEST_FUNCTIONS.has(object.name)) return undefined;
  return `${object.name}.${property}`;
};

/**
 * Reports a test declaration that runs once per loop iteration. A loop around a
 * `describe` is reported on the `describe`, so the tests inside it stay quiet.
 */
const isInsideLoop = (node: ESTree.Node): boolean => {
  let current = node.parent;
  while (current) {
    if (LOOPS.has(current.type)) return true;
    // Anything inside a function (a describe body, a helper, a test body) runs
    // once per call of that function, not once per iteration.
    if (FUNCTIONS.has(current.type)) return false;
    current = current.parent;
  }
  return false;
};

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow declaring tests inside a for loop; use it.each / it.effect.each / describe.each instead.",
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};

    return {
      CallExpression(node) {
        const name = testCallName(node.callee);
        if (name === undefined) return;
        if (!isInsideLoop(node)) return;

        context.report({
          node: node.callee,
          message: `Do not call ${name}(…) inside a for loop. Use ${name}.each(cases)(name, …) instead.`,
        });
      },
    };
  },
});
