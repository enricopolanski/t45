import pierreLight from "@pierre/theme/pierre-light";
import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
} from "@shikijs/core";
import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";

/** The syntax-highlighting theme for markdown code blocks and shell commands. */
export const CODE_THEME_NAME = "pierre-light";

type GrammarLoader = () => Promise<{ readonly default: ReadonlyArray<LanguageRegistration> }>;

// Explicit imports let the browser load each grammar on demand without bundling Shiki's catalog.
const grammars = [
  [["css"], () => import("@shikijs/langs/css")],
  [["diff"], () => import("@shikijs/langs/diff")],
  [["docker", "dockerfile"], () => import("@shikijs/langs/docker")],
  [["html"], () => import("@shikijs/langs/html")],
  [["ini", "properties"], () => import("@shikijs/langs/ini")],
  [["javascript", "js", "cjs", "mjs"], () => import("@shikijs/langs/javascript")],
  [["json"], () => import("@shikijs/langs/json")],
  [["jsonc"], () => import("@shikijs/langs/jsonc")],
  [["jsx"], () => import("@shikijs/langs/jsx")],
  [["markdown", "md"], () => import("@shikijs/langs/markdown")],
  [["mermaid"], () => import("@shikijs/langs/mermaid")],
  [["python", "py"], () => import("@shikijs/langs/python")],
  [["shellscript", "bash", "sh", "shell", "zsh"], () => import("@shikijs/langs/shellscript")],
  [["sql"], () => import("@shikijs/langs/sql")],
  [["toml"], () => import("@shikijs/langs/toml")],
  [["tsx"], () => import("@shikijs/langs/tsx")],
  [["typescript", "ts", "cts", "mts"], () => import("@shikijs/langs/typescript")],
  [["yaml", "yml"], () => import("@shikijs/langs/yaml")],
] satisfies ReadonlyArray<readonly [ReadonlyArray<string>, GrammarLoader]>;

const grammarByLanguage = new Map(
  grammars.flatMap(([languages, load]) => languages.map((language) => [language, load] as const)),
);

let highlighterPromise: Promise<HighlighterCore> | undefined;
const grammarPromises = new Map<GrammarLoader, Promise<HighlighterCore>>();

function getHighlighter() {
  highlighterPromise ??= createHighlighterCore({
    themes: [
      {
        name: CODE_THEME_NAME,
        type: pierreLight.type,
        colors: pierreLight.colors,
        settings: [...pierreLight.tokenColors],
      },
    ],
    langs: [],
    // Oniguruma avoids catastrophic backtracking in the JavaScript regex engine.
    engine: createOnigurumaEngine(import("@shikijs/engine-oniguruma/wasm-inlined")),
  }).catch((error: unknown) => {
    highlighterPromise = undefined;
    throw error;
  });
  return highlighterPromise;
}

export function getSyntaxHighlighterPromise(language: string): Promise<HighlighterCore> {
  const load = grammarByLanguage.get(language);
  if (load === undefined) return getHighlighter();
  const cached = grammarPromises.get(load);
  if (cached !== undefined) return cached;

  const promise = getHighlighter().then(async (highlighter) => {
    try {
      await highlighter.loadLanguage(...(await load()).default);
    } catch {
      // A missing grammar chunk falls back to the shared plain text highlighter.
    }
    return highlighter;
  });
  grammarPromises.set(load, promise);
  return promise;
}
