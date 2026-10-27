import { defineRule, type ESTree } from "@oxlint/plugins";

import { isIdentifier, propertyName, unwrapExpression } from "../utils.ts";

// Effect Schema decoder/encoder APIs allocate compiled functions. Keep them
// outside function bodies so hot paths do not rebuild compilers per call.
const COMPILER_METHODS = new Set([
  "is",
  "asserts",
  "decodeEffect",
  "decodeExit",
  "decodeOption",
  "decodePromise",
  "decodeResult",
  "decodeSync",
  "decodeUnknownExit",
  "decodeUnknownEffect",
  "decodeUnknownOption",
  "decodeUnknownPromise",
  "decodeUnknownResult",
  "decodeUnknownSync",

  "encodeExit",
  "encodeEffect",
  "encodeOption",
  "encodePromise",
  "encodeResult",
  "encodeSync",
  "encodeUnknownExit",
  "encodeUnknownEffect",
  "encodeUnknownOption",
  "encodeUnknownPromise",
  "encodeUnknownResult",
  "encodeUnknownSync",
]);

const getSchemaCompilerMethod = (callee: ESTree.Node): string | undefined => {
  const expression = unwrapExpression(callee);
  if (expression.type !== "MemberExpression") return undefined;
  if (!isIdentifier(unwrapExpression(expression.object), "Schema")) return undefined;

  const method = propertyName(expression.property);
  return method !== undefined && COMPILER_METHODS.has(method) ? method : undefined;
};

const isStaticSchemaReference = (node: ESTree.Node | undefined): boolean => {
  if (node === undefined) return false;
  const expression = unwrapExpression(node);

  if (expression.type === "Identifier") {
    const [firstChar] = expression.name;
    return firstChar !== undefined && firstChar.toUpperCase() === firstChar;
  }

  return expression.type === "MemberExpression";
};

const isNestedStaticSchemaCall = (node: ESTree.Node | undefined): boolean => {
  if (node === undefined) return false;
  const expression = unwrapExpression(node);
  if (expression.type !== "CallExpression") return false;

  const callee = unwrapExpression(expression.callee);
  if (callee.type !== "MemberExpression") return false;
  if (!isIdentifier(unwrapExpression(callee.object), "Schema")) return false;

  if (propertyName(callee.property) === "fromJsonString") {
    const firstArg = expression.arguments[0];
    return isStaticSchemaReference(firstArg) || isNestedStaticSchemaCall(firstArg);
  }

  return true;
};

const isImmediatelyInvoked = (node: ESTree.CallExpression): boolean => {
  const parent = unwrapExpression(node.parent);
  return parent.type === "CallExpression" && unwrapExpression(parent.callee) === node;
};

const messageHigh = (method: string) =>
  `Hoist Schema.${method}(...) to module scope: both the inline schema literal and the compiled function are rebuilt on every call. Move the compiled function to a module-level const.`;

const messageMedium = (method: string) =>
  `Hoist Schema.${method}(...) to module scope: the compiled function is rebuilt on every call. Move it to a module-level const.`;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Schema decoder/encoder compiler calls inside function bodies; hoist them to module scope.",
    },
  },
  createOnce(context) {
    let functionDepth = 0;

    const resetFunctionDepth = () => {
      functionDepth = 0;
    };

    const enterFunction = () => {
      functionDepth++;
    };

    const exitFunction = () => {
      functionDepth--;
    };

    return {
      before: resetFunctionDepth,
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      CallExpression(node) {
        if (functionDepth === 0) return;

        const method = getSchemaCompilerMethod(node.callee);
        if (method === undefined) return;
        if (!isImmediatelyInvoked(node)) return;

        const firstArg = node.arguments[0];
        const high = isNestedStaticSchemaCall(firstArg);
        if (!high && !isStaticSchemaReference(firstArg)) return;

        context.report({
          node: node.callee,
          message: high ? messageHigh(method) : messageMedium(method),
        });
      },
    };
  },
});
