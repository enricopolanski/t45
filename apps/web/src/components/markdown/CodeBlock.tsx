import type { DiffsHighlighter } from "@pierre/diffs";
import { CatchBoundary } from "@tanstack/react-router";
import DOMPurify from "dompurify";
import { toHtml } from "hast-util-to-html";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { Element as HastElement } from "hast";
import { CodeIcon, WorkflowIcon, WrapTextIcon } from "lucide-react";
import type { Mermaid } from "mermaid";
import {
  Suspense,
  cloneElement,
  isValidElement,
  memo,
  use,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type DOMAttributes,
  type ReactNode,
} from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type { ExtraProps } from "react-markdown";

import { describeFailure } from "~/lib/failures";
import { CODE_THEME_NAME, getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";
import { CopyButton } from "../CopyButton";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { Spinner } from "../ui/spinner";
import { MarkdownAction } from "./MarkdownAction";
import { hastText } from "./plugins";

/**
 * react-markdown's `pre`. A fenced block renders in a frame with copy and wrap
 * controls around its Shiki-highlighted code; a Mermaid fence shows its
 * diagram once the response settles. Any other `pre` stays plain.
 *
 * The outermost element carries `data-md` with `data-md-whole`, so
 * copy-as-markdown copies the block's source rather than its rendered text.
 */
export function CodeBlock({
  node,
  children,
  "data-md": dataMd,
  isStreaming,
  onExpandDiagram,
  ...props
}: ComponentProps<"pre"> &
  ExtraProps & {
    /** The block's source offsets, added by the parse pipeline. */
    "data-md"?: string | undefined;
    isStreaming: boolean;
    /** Opens a rendered Mermaid diagram (an image URL) in the preview dialog. */
    onExpandDiagram: (imageUrl: string) => void;
  }) {
  const fence = readFence(node);
  if (!fence) {
    return (
      <pre {...props} data-md={dataMd} data-md-whole="">
        {children}
      </pre>
    );
  }

  const { code, language, title } = fence;
  const highlightedCode = (
    <CatchBoundary
      getResetKey={() => `${language}:${isStreaming}:${code}`}
      errorComponent={() => <pre {...props}>{children}</pre>}
    >
      {/* Reserve the block's height but stay hidden until Shiki has colored
         it, so plain text never flashes before the highlighted version. */}
      <Suspense
        fallback={
          <pre {...props} className="invisible" aria-hidden>
            {children}
          </pre>
        }
      >
        <HighlightedCode code={code} language={language} isStreaming={isStreaming} />
      </Suspense>
    </CatchBoundary>
  );
  if (language === "mermaid") {
    return (
      <MermaidCodeBlock
        code={code}
        title={title}
        dataMd={dataMd}
        isStreaming={isStreaming}
        onExpand={onExpandDiagram}
      >
        {highlightedCode}
      </MermaidCodeBlock>
    );
  }
  return (
    <CodeBlockFrame code={code} title={title} dataMd={dataMd}>
      {highlightedCode}
    </CodeBlockFrame>
  );
}

const FENCE_TITLE_ATTR_REGEX = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const FENCE_FILENAME_TOKEN_REGEX = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/;

/** Pulls a filename out of fence meta: ```ts title="x.ts" / ```ts src/main.ts */
function extractFenceTitle(meta: string | undefined) {
  if (!meta) return undefined;
  const attrMatch = FENCE_TITLE_ATTR_REGEX.exec(meta);
  const attrTitle = attrMatch?.[1] ?? attrMatch?.[2] ?? attrMatch?.[3];
  if (attrTitle) return attrTitle;
  return meta.split(/\s+/).find((candidate) => FENCE_FILENAME_TOKEN_REGEX.test(candidate));
}

/**
 * A fenced block is a `pre` whose only child is its `code` element. Its header shows the
 * filename from the fence meta (copied onto `code` by the parse pipeline), else the language.
 */
function readFence(pre: HastElement | undefined) {
  const code = pre?.children.length === 1 ? pre.children[0] : undefined;
  if (code?.type !== "element" || code.tagName !== "code") return null;
  const fenceLanguage = /language-([^\s,]+)/.exec(String(code.properties.className))?.[1] ?? "text";
  // Shiki doesn't bundle a gitignore grammar; ini is a close match.
  const language = fenceLanguage === "gitignore" ? "ini" : fenceLanguage;
  return {
    code: hastText(code),
    language,
    title: extractFenceTitle(String(code.properties.dataCodeMeta ?? "")) ?? language,
  };
}

function CodeBlockFrame({
  code,
  title,
  dataMd,
  leadingActions,
  children,
}: {
  code: string;
  title: string;
  dataMd: string | undefined;
  leadingActions?: ReactNode;
  children: ReactNode;
}) {
  const [wrapped, setWrapped] = useState(true);

  return (
    <div
      className="chat-markdown-codeblock my-[0.65rem] overflow-hidden rounded-lg border border-border/70 bg-secondary leading-snug"
      data-wrap={wrapped ? "true" : "false"}
      data-md={dataMd}
      data-md-whole=""
    >
      <div
        data-md-ui=""
        className="chat-markdown-codeblock-header flex items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3 select-none"
      >
        <span className="min-w-0 truncate font-mono text-2xs">{title}</span>
        <span className="flex items-center gap-0.5" role="toolbar" aria-label="Code block actions">
          {leadingActions}
          <MarkdownAction
            label={wrapped ? "Disable line wrap" : "Wrap lines"}
            pressed={wrapped}
            onClick={() => setWrapped((value) => !value)}
          >
            <WrapTextIcon className="size-3" />
          </MarkdownAction>
          <CopyButton text={code} label="Copy code" />
        </span>
      </div>
      {children}
    </div>
  );
}

/**
 * Mermaid fences render as a diagram once the response settles; streaming and
 * the code toggle keep the highlighted source.
 */
function MermaidCodeBlock({
  code,
  title,
  dataMd,
  isStreaming,
  onExpand,
  children,
}: {
  code: string;
  title: string;
  dataMd: string | undefined;
  isStreaming: boolean;
  onExpand: (imageUrl: string) => void;
  children: ReactNode;
}) {
  const [showCode, setShowCode] = useState(false);
  const source = code.trim();
  const toggle = isStreaming ? null : (
    <MarkdownAction
      label={showCode ? "Show diagram" : "Show code"}
      onClick={() => setShowCode((value) => !value)}
    >
      {showCode ? <WorkflowIcon className="size-3" /> : <CodeIcon className="size-3" />}
    </MarkdownAction>
  );
  if (showCode || isStreaming || source.length === 0) {
    return (
      <CodeBlockFrame code={code} title={title} dataMd={dataMd} leadingActions={toggle}>
        {children}
      </CodeBlockFrame>
    );
  }
  return (
    <div className="my-[0.65rem]" data-md={dataMd} data-md-whole="">
      <CatchBoundary getResetKey={() => code} errorComponent={() => children}>
        <Suspense
          fallback={
            <div
              role="status"
              className="flex min-h-36 items-center justify-center gap-2 text-xs text-muted-foreground"
            >
              <Spinner size="sm" />
              Rendering diagram…
            </div>
          }
        >
          <MermaidDiagram source={source} onExpand={onExpand} />
        </Suspense>
      </CatchBoundary>
      <div data-md-ui="" className="mt-0.5 flex items-center justify-between select-none">
        {toggle}
        <CopyButton text={code} label="Copy code" />
      </div>
    </div>
  );
}

/** Stores an entry as the newest in a module cache, dropping the oldest past `max`. */
function setCapped<T>(cache: Map<string, T>, max: number, key: string, value: T) {
  cache.delete(key);
  cache.set(key, value);
  const [oldest] = cache.keys();
  if (oldest !== undefined && cache.size > max) cache.delete(oldest);
}

/**
 * Highlighted HTML of completed blocks, keyed by `${language}\n${code}`, so a block the
 * virtualized timeline remounts skips Shiki.
 */
const highlightedHtmlCache = new Map<string, string>();
const MAX_CACHED_HIGHLIGHTS = 200;

/**
 * Suspends while the language's grammar loads. A block that never streamed
 * renders from the cache when the same code was highlighted before.
 */
function HighlightedCode({
  code,
  language,
  isStreaming,
}: {
  code: string;
  language: string;
  isStreaming: boolean;
}) {
  const [hasStreamed, setHasStreamed] = useState(isStreaming);
  if (isStreaming && !hasStreamed) setHasStreamed(true);
  // Once lines are mounted individually, keep that renderer when streaming
  // finishes so switching to cached HTML cannot clear an existing selection.
  const cachedHighlightedHtml =
    !isStreaming && !hasStreamed ? highlightedHtmlCache.get(`${language}\n${code}`) : undefined;

  if (cachedHighlightedHtml !== undefined) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  return (
    <UncachedHighlightedCode
      code={code}
      language={language}
      isStreaming={isStreaming}
      preserveLines={isStreaming || hasStreamed}
    />
  );
}

function UncachedHighlightedCode({
  code,
  language,
  isStreaming,
  preserveLines,
}: {
  code: string;
  language: string;
  isStreaming: boolean;
  preserveLines: boolean;
}) {
  const highlighter = use(getSyntaxHighlighterPromise(language));
  // A fence language Shiki has no grammar for (`output`, `tree`, `txt`) resolves
  // to the shared highlighter without loading one, and highlighting with it
  // would throw, so it renders as plain text. `ansi` needs no grammar: Shiki
  // colors its escape codes itself.
  const lang =
    language === "ansi" || highlighter.getLoadedLanguages().includes(language) ? language : "text";
  const highlightIncrementally = useMemo(
    () => (preserveLines ? createIncrementalHighlightedDocument(highlighter, lang) : null),
    [highlighter, lang, preserveLines],
  );
  const highlighted = useMemo(
    () =>
      highlightIncrementally
        ? highlightIncrementally(code)
        : highlighter.codeToHtml(code, { lang, theme: CODE_THEME_NAME }),
    [code, highlighter, highlightIncrementally, lang],
  );

  useEffect(() => {
    if (isStreaming) return;
    setCapped(
      highlightedHtmlCache,
      MAX_CACHED_HIGHLIGHTS,
      `${language}\n${code}`,
      typeof highlighted === "string" ? highlighted : toHtml(highlighted),
    );
  }, [code, highlighted, isStreaming, language]);

  return typeof highlighted === "string" ? (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlighted }} />
  ) : (
    <div className="chat-markdown-shiki">
      <HighlightedCodeLines root={highlighted} />
    </div>
  );
}

type HighlightedRoot = ReturnType<DiffsHighlighter["codeToHast"]>;
type HighlightedNode = HighlightedRoot["children"][number];

/** Shiki's output is always `pre > code > lines`. */
function preAndCode(root: HighlightedRoot) {
  const [pre] = root.children;
  const code = pre?.type === "element" ? pre.children[0] : undefined;
  if (pre?.type !== "element" || code?.type !== "element") {
    throw new Error("Unexpected highlighted code markup");
  }
  return { pre, code };
}

/** Resume tokenization after the last completed line. Keep its grammar state so
 * multiline strings, comments, and embedded languages continue to highlight as
 * they do in a full pass. The current line is always highlighted again.
 */
function createIncrementalHighlightedDocument(highlighter: DiffsHighlighter, language: string) {
  const options = { lang: language, theme: CODE_THEME_NAME };
  const newline = { type: "text" as const, value: "\n" };
  let cached:
    | {
        prefix: string;
        state: ReturnType<DiffsHighlighter["getLastGrammarState"]>;
        children: ReturnType<typeof preAndCode>["code"]["children"];
      }
    | undefined;

  return (code: string) => {
    // Plain text and ANSI have no TextMate grammar state. A CR at the end of a
    // chunk can still become a CRLF, so keep that input on the full path.
    if (language === "text" || language === "ansi" || code.includes("\r")) {
      return highlighter.codeToHast(code, options);
    }
    if (cached && !code.startsWith(cached.prefix)) cached = undefined;
    const end = code.lastIndexOf("\n") + 1;
    if (end > (cached?.prefix.length ?? 0)) {
      // Omit the final newline: Shiki would tokenize an extra empty line and
      // advance the grammar state twice before we process the following line.
      const root = highlighter.codeToHast(code.slice(cached?.prefix.length ?? 0, end - 1), {
        ...options,
        ...(cached ? { grammarState: cached.state } : {}),
      });
      const state = highlighter.getLastGrammarState(root);
      if (!state) {
        cached = undefined;
        return highlighter.codeToHast(code, options);
      }
      cached = {
        prefix: code.slice(0, end),
        state,
        children: [
          ...(cached ? [...cached.children, newline] : []),
          ...preAndCode(root).code.children,
        ],
      };
    }
    const prefix = cached;
    if (!prefix) return highlighter.codeToHast(code, options);
    return highlighter.codeToHast(code.slice(prefix.prefix.length), {
      ...options,
      grammarState: prefix.state,
      transformers: [
        {
          code: (node) => ({ ...node, children: [...prefix.children, newline, ...node.children] }),
        },
      ],
    });
  };
}

const runtime = { Fragment, jsx, jsxs };

function elementShell(node: Extract<HighlightedNode, { type: "element" }>) {
  const element = toJsxRuntime({ ...node, children: [] }, runtime);
  if (!isValidElement<DOMAttributes<HTMLElement>>(element)) {
    throw new Error("Expected a highlighted code element");
  }
  return element;
}

const HighlightedLine = memo(function HighlightedLine({ node }: { node: HighlightedNode }) {
  if (node.type !== "element") return toJsxRuntime(node, runtime);
  return cloneElement(elementShell(node), {
    dangerouslySetInnerHTML: { __html: toHtml({ type: "root", children: node.children }) },
  });
});

/** Completed line nodes retain their identity in the incremental highlighter.
 * Keep their DOM mounted too: replacing the entire pre makes the browser parse
 * and resolve styles for thousands of unchanged token spans on each update.
 */
function HighlightedCodeLines({ root }: { root: HighlightedRoot }) {
  const { pre, code } = preAndCode(root);
  return cloneElement(
    elementShell(pre),
    undefined,
    cloneElement(
      elementShell(code),
      undefined,
      code.children.map((node, index) => (
        // A line's position is stable as tokens and new lines are appended.
        // oxlint-disable-next-line react/no-array-index-key
        <HighlightedLine key={index} node={node} />
      )),
    ),
  );
}

type MermaidRenderResult =
  | { readonly status: "rendered"; readonly svg: string }
  | { readonly status: "error"; readonly message: string; readonly retryable: boolean };

let mermaidModulePromise: Promise<Mermaid> | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();
let nextDiagramId = 0;
// Keyed by the full source so distinct diagrams never share an entry; use() must
// get the same promise each time a diagram suspends. Capped because a fence whose
// text still grows without isStreaming (an open reasoning part) renders every
// partial source.
const renderCache = new Map<string, Promise<MermaidRenderResult>>();
const MAX_CACHED_DIAGRAMS = 64;

// Mermaid is ~1MB, so it only loads once a diagram is actually shown.
function loadMermaid(): Promise<Mermaid> {
  mermaidModulePromise ??= import("mermaid")
    .then((module) => module.default)
    .catch((error: unknown) => {
      mermaidModulePromise = null;
      throw error;
    });
  return mermaidModulePromise;
}

const REMOTE_CSS_URL = /url\(\s*(?!['"]?#)[^)]*\)/gi;
let purifier: ReturnType<typeof DOMPurify> | null = null;

// Diagrams come from agent output, so strip anything that can navigate, run
// script, or fetch remote content on top of Mermaid's own strict sanitization.
// CSS keeps only local url(#id) references; label text is untouched.
function sanitizeMermaidSvg(svg: string): string {
  if (!purifier) {
    purifier = DOMPurify(window);
    purifier.addHook("uponSanitizeElement", (node, data) => {
      if (data.tagName === "style" && node.textContent) {
        node.textContent = node.textContent.replace(REMOTE_CSS_URL, "none");
      }
    });
    purifier.addHook("uponSanitizeAttribute", (_node, data) => {
      if (data.attrName === "style")
        data.attrValue = data.attrValue.replace(REMOTE_CSS_URL, "none");
    });
  }
  return purifier.sanitize(svg, {
    ADD_TAGS: ["foreignObject"],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
    FORBID_TAGS: ["a", "img", "image", "script"],
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
  });
}

// Mermaid also lazy-loads diagram chunks inside render(); losing the network
// there is worth a retry, unlike a syntax error.
const CHUNK_LOAD_ERROR = /dynamically imported module|importing a module script|failed to fetch/i;

async function renderMermaid(source: string): Promise<MermaidRenderResult> {
  const id = `mermaid-diagram-${nextDiagramId++}`;
  let mermaid: Mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    return { status: "error", message: "Mermaid failed to load.", retryable: true };
  }
  try {
    // initialize() mutates global config, so renders run one at a time.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      // HTML labels and theme CSS are mounted while Mermaid lays the diagram
      // out, before sanitizing, so diagram directives must not set them.
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
        "htmlLabels",
        "themeCSS",
      ],
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: "default",
      fontFamily: getComputedStyle(document.body).fontFamily,
    });
    const { svg } = await mermaid.render(id, source);
    return { status: "rendered", svg: sanitizeMermaidSvg(svg) };
  } catch (error) {
    const message = describeFailure(error, "The diagram could not be rendered.");
    return { status: "error", message, retryable: CHUNK_LOAD_ERROR.test(message) };
  } finally {
    document.getElementById(`d${id}`)?.remove();
  }
}

function mermaidRenderPromise(source: string) {
  let result = renderCache.get(source);
  if (!result) {
    result = renderQueue.then(() => renderMermaid(source));
    renderQueue = result;
    setCapped(renderCache, MAX_CACHED_DIAGRAMS, source, result);
  }
  return result;
}

let expandedImageUrl: string | null = null;

/**
 * Converts a rendered diagram into a standalone image with fixed size and background.
 * Media save and copy actions fetch it as a blob URL. Only one diagram is expanded
 * at a time, so the previous URL is released.
 */
function mermaidImageUrl(svg: string): string {
  const svgDocument = new DOMParser().parseFromString(svg, "image/svg+xml");
  const element = svgDocument.documentElement;
  const viewBox = element.getAttribute("viewBox")?.trim().split(/\s+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    element.setAttribute("width", String(viewBox[2]));
    element.setAttribute("height", String(viewBox[3]));
  }
  element.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  element.style.maxWidth = "none";
  element.style.backgroundColor = getComputedStyle(document.body).backgroundColor;
  if (expandedImageUrl) URL.revokeObjectURL(expandedImageUrl);
  expandedImageUrl = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(element)], { type: "image/svg+xml" }),
  );
  return expandedImageUrl;
}

/** Suspends until the diagram renders; failures show the parser message above the source. */
function MermaidDiagram({
  source,
  onExpand,
}: {
  source: string;
  onExpand: (imageUrl: string) => void;
}) {
  const [, setAttempt] = useState(0);
  const result = use(mermaidRenderPromise(source));

  if (result.status === "error") {
    return (
      <div>
        <div className="flex items-center justify-between gap-2">
          <ErrorText size="xs" className="m-0">
            Unable to render diagram: {result.message}
          </ErrorText>
          {result.retryable ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                renderCache.delete(source);
                setAttempt((attempt) => attempt + 1);
              }}
            >
              Retry
            </Button>
          ) : null}
        </div>
        <pre className="mt-2 mb-0 overflow-auto font-mono text-xs whitespace-pre-wrap">
          {source}
        </pre>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <button
        type="button"
        aria-label="Expand diagram"
        className="flex w-full cursor-zoom-in justify-center rounded-md focus-visible:outline-2 focus-visible:outline-ring [&_svg]:h-auto [&_svg]:max-w-full"
        onClick={() => onExpand(mermaidImageUrl(result.svg))}
        dangerouslySetInnerHTML={{ __html: result.svg }}
      />
    </div>
  );
}
