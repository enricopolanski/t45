import { expect, it } from "vite-plus/test";

import { CODE_THEME_NAME, getSyntaxHighlighterPromise } from "./syntaxHighlighting";

it("renders excluded languages as plain text", async () => {
  const first = getSyntaxHighlighterPromise("wolfram");
  const textHighlighter = await getSyntaxHighlighterPromise("text");
  await expect(first).resolves.toBe(textHighlighter);
  expect(getSyntaxHighlighterPromise("emacs-lisp")).toBe(first);
  expect(textHighlighter.getLoadedLanguages()).not.toContain("wolfram");
});

it("highlights shell commands and TypeScript fences", async () => {
  const shell = await getSyntaxHighlighterPromise("shellscript");
  const typescript = await getSyntaxHighlighterPromise("ts");
  expect(typescript).toBe(shell);
  expect(shell.getLoadedLanguages()).toEqual(expect.arrayContaining(["bash", "ts"]));
  expect(
    shell.codeToTokens("echo 'hello'", { lang: "bash", theme: CODE_THEME_NAME }).tokens[0],
  ).toEqual(expect.arrayContaining([expect.objectContaining({ content: "'hello'" })]));
});
