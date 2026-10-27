import type { ESTree } from "@oxlint/plugins";

export const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

export function unwrapExpression(node: ESTree.Node): ESTree.Node {
  let current = node;
  while (
    current.type === "ChainExpression" ||
    current.type === "ParenthesizedExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSTypeAssertion"
  ) {
    current = current.expression;
  }
  return current;
}

export function propertyName(node: ESTree.Node): string | undefined {
  if (node.type === "Identifier" || node.type === "PrivateIdentifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
}

export const isIdentifier = (node: ESTree.Node, name: string) =>
  node.type === "Identifier" && node.name === name;
