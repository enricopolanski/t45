import type { Root } from "mdast";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import type { Plugin } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { createIncrementalMarkdownPlugin, rehypePlugins, remarkPlugins } from "./plugins";

function render(source: string, incremental?: Plugin<[], Root>, parsedSources?: string[]) {
  let tree: Root | undefined;
  const observeParsing: Plugin<[], Root> = function () {
    const original = this.parser;
    if (original) {
      this.parser = (text, file) => {
        parsedSources?.push(text);
        return original(text, file);
      };
    }
  };
  const capture: Plugin<[], Root> = () => (root) => {
    tree = structuredClone(root);
  };
  const html = renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[
        observeParsing,
        capture,
        ...remarkPlugins(false),
        ...(incremental ? [incremental] : []),
      ]}
      rehypePlugins={rehypePlugins(true)}
    >
      {source}
    </ReactMarkdown>,
  );
  return { html, tree };
}

const html = (source: string, lineBreaks = false) =>
  renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={remarkPlugins(lineBreaks)} rehypePlugins={rehypePlugins(true)}>
      {source}
    </ReactMarkdown>,
  ).replaceAll(/ data-md="[^"]*"/g, "");

describe("markdown syntax", () => {
  it("renders padded list markers as list text instead of a code block per bullet", () => {
    const rendered = html(`why did you do this?

-       for (const step of rest.steps) {
-           if (step.request.body) {
-               step.request.body = "redacted";
-           }
-       }`);

    expect(rendered).toContain("<li>for (const step of rest.steps) {</li>");
    expect(rendered).toContain("<li>if (step.request.body) {</li>");
    expect(rendered).toContain("<li>step.request.body = &quot;redacted&quot;;</li>");
  });

  it("keeps inline markdown, task boxes, and later blocks of a padded bullet", () => {
    const rendered = html(
      "-       **important** [docs](https://example.com) use `code`\n\n        second block\n\n-       [ ] todo",
    );

    expect(rendered).toContain("<strong>important</strong>");
    expect(rendered).toContain('<a href="https://example.com">docs</a>');
    expect(rendered).toContain("<code>code</code>");
    expect(rendered).toContain("<p>second block</p>");
    expect(rendered).toContain('<input type="checkbox" disabled=""/> todo');
  });

  it("keeps fenced code inside list items", () => {
    expect(html("- ```ts\n  const value = 1;\n  ```")).toContain(
      '<pre><code class="language-ts">const value = 1;',
    );
  });

  it("strikes through double tildes only, so git refs stay plain text", () => {
    expect(html("compare HEAD~1 with HEAD~2, not ~~this~~")).toBe(
      "<p>compare HEAD~1 with HEAD~2, not <del>this</del></p>",
    );
  });

  // parse5 only moves whitespace out of tables and spells boolean attributes differently.
  it("renders the same whether or not raw parsing runs on a message without HTML", () => {
    const source =
      "# Title\n\n| a | b |\n|---|:-:|\n| 1 | 2 |\n\n> [!TIP]\n> tip\n\n- [x] done\n\nfoot[^n]\n\n[^n]: note\n\n![shot](https://e.com/a.png)";
    const withRaw = renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={remarkPlugins(false)} rehypePlugins={[rehypeRaw]}>
        {source}
      </ReactMarkdown>,
    );
    const withoutRaw = renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={remarkPlugins(false)}>{source}</ReactMarkdown>,
    );

    const normalize = (markup: string) =>
      markup.replaceAll(/>\s+</g, "><").replaceAll('="true"', '=""');
    expect(normalize(withoutRaw)).toBe(normalize(withRaw));
  });
});

const prefix = "# Before\n\n```ts\nconst values = [1, 2];\n```\n\n";

describe("incremental Markdown parsing", () => {
  it("parses only what follows the cached prefix", () => {
    const source =
      prefix + "-       first block\n\n        ```ts\n        const nested = 1;\n        ```";
    const incremental = createIncrementalMarkdownPlugin();
    const parsedSources: string[] = [];
    expect(render(source, incremental, parsedSources)).toEqual(render(source));
    parsedSources.length = 0;
    const next = source + "\n\ntail";
    const rendered = render(next, incremental, parsedSources);

    expect(rendered).toEqual(render(next));
    expect(rendered.html).toMatch(/<code class="language-ts"[^>]*>const nested = 1;/);
    expect(parsedSources).not.toContain(next);
  });

  it.each([
    "a\n===\n\nb\n---\n",
    "- first\n\n  continued\n\n- next\n",
    "> quoted\n>\n> ```js\n> abc\n> ```\n\nend",
    "<div>\nhello\n\n</div>\n\nend",
    "[ref]\n\n[ref]: /later",
    "a[^x]\n\n[^x]: note",
    "a | b\n--|--\na | b\n",
    "```\na\n```\n\nnext\n\n~~~\nb\n~~~\n\nmore",
    "\n\n\tcode\n\nmore",
    "text <https://example.com> *bold*",
    "> [!NOTE]\n> alert\n\n- [ ] task",
    "﻿text after a byte-order mark",
    "## Heading\nprose\n# Next #tag\n===\n\ntext",
    "- item\n# Heading\n> quote\nlazy\n## Another\n",
    "<pre>\n# not a heading\n</pre>\n\n# Heading\n[d]\n\n[d]: /later",
    "# Heading \n## Trailing #\n   ### Indented\n    #### Deep\nend",
  ])("preserves the parse tree, positions, and HTML while streaming %j", (tail) => {
    const source = prefix + tail;
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      expect(render(text, incremental), `prefix ${end}`).toEqual(render(text));
    }
  });

  it.each(["\r\n", "\r"])("preserves partial %j line endings", (newline) => {
    const source = (prefix + "next\n\n```\nlast\n```\n\nend").replaceAll("\n", newline);
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      expect(render(text, incremental)).toEqual(render(text));
    }
  });

  it("updates earlier references when definitions arrive after the cached prefix", () => {
    const before = "[later] and footnote[^note]\n\n" + prefix;
    const incremental = createIncrementalMarkdownPlugin();
    for (const tail of ["text", "[later]: /target", "[later]: /target\n\n[^note]: a note"]) {
      expect(render(before + tail, incremental)).toEqual(render(before + tail));
    }
  });

  it("handles edits, replacements, and repeated renders without leaking transformed nodes", () => {
    const incremental = createIncrementalMarkdownPlugin();
    const documents = [
      prefix + "- first\n - second",
      prefix + "> [!NOTE]\n> transformed alert",
      prefix + "plain text",
      "replacement without fences",
      prefix.replace("Before", "Edited") + "edited prefix",
      prefix + "plain text",
      prefix + "plain text",
    ];
    for (const document of documents) {
      expect(render(document, incremental)).toEqual(render(document));
    }
  });

  it("does not freeze unclosed, nested, indented, or mismatched fences", () => {
    const prefixes = [
      "```\nopen\n\n",
      "````\n```\n\n",
      "> ```\n> code\n> ```\n\n",
      "- ```\n  code\n  ```\n\n",
      "    ```\n    code\n    ```\n\n",
      "<script>\n```\ncode\n```\n\n",
    ];
    for (const start of prefixes) {
      const incremental = createIncrementalMarkdownPlugin();
      for (const tail of ["", "text", "\n```\n", "\n```\n\nnext"]) {
        expect(render(start + tail, incremental)).toEqual(render(start + tail));
      }
    }
  });
});
