import { CatchBoundary } from "@tanstack/react-router";
import { Suspense, use, useMemo, type CSSProperties } from "react";

import { CODE_THEME_NAME, getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";

// Escape bytes and other control characters render as invisible gaps; they show as Unicode
// control pictures instead (ESC becomes ␛), keeping the text's length. Tab, newline and carriage
// return lay out as whitespace, so CRLF scripts stay unmarked.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const withVisibleControlCharacters = (text: string) =>
  text.replace(CONTROL_CHARACTERS, (character) =>
    character === "\u007f" ? "␡" : String.fromCharCode(0x2400 + character.charCodeAt(0)),
  );

// Shell words wrap as a unit, so `--exclude` or a quoted string is not split
// at a hyphen; a word longer than the line still breaks anywhere.
const WORD_CLASS_NAME = "inline-block max-w-full wrap-anywhere";

/** Same layout as the highlighted version, so the grammar arriving never reflows the block. */
function PlainWords({ code }: { code: string }) {
  // split with a capture group alternates words (even) and whitespace (odd).
  return code.split(/(\s+)/u).map((part, index) =>
    index % 2 === 1 || part === "" ? (
      part
    ) : (
      // Positions are stable for a given string, which is all this renders.
      // oxlint-disable-next-line react/no-array-index-key
      <span key={index} className={WORD_CLASS_NAME}>
        {part}
      </span>
    ),
  );
}

/** The command a shell message or bash tool call ran, syntax highlighted. */
export function ShellCommandBlock({ command }: { command: string }) {
  const code = withVisibleControlCharacters(command.trim());
  if (!code) return null;
  const plain = <PlainWords code={code} />;
  return (
    // The tool body sets the monospace, pre-wrapped text this sits in.
    <div className="text-foreground/85">
      <CatchBoundary getResetKey={() => code} errorComponent={() => plain}>
        <Suspense fallback={plain}>
          <HighlightedWords code={code} />
        </Suspense>
      </CatchBoundary>
    </div>
  );
}

interface SyntaxToken {
  readonly content: string;
  readonly offset: number;
  readonly color?: string;
  readonly fontStyle?: number;
}

function syntaxTokenStyle(token: SyntaxToken): CSSProperties {
  const fontStyle = token.fontStyle ?? 0;
  return {
    ...(token.color ? { color: token.color } : {}),
    ...(fontStyle & 1 ? { fontStyle: "italic" } : {}),
    ...(fontStyle & 2 ? { fontWeight: 700 } : {}),
    ...(fontStyle & 4 ? { textDecoration: "underline" } : {}),
  };
}

/**
 * Colors `code` inside the caller's `<pre>` without changing its text, so selection and copy
 * match the plain version. Suspends while the grammar loads.
 */
function HighlightedWords({ code }: { code: string }) {
  const highlighter = use(getSyntaxHighlighterPromise("shellscript"));
  const lines = useMemo(
    () =>
      keyedLines(
        code,
        highlighter.codeToTokens(code, { lang: "shellscript", theme: CODE_THEME_NAME }).tokens,
      ),
    [code, highlighter],
  );

  return lines.map(({ key, tokens, ending }) => (
    <span key={key}>
      {wordsOf(tokens).map((part) =>
        typeof part === "string" ? (
          part
        ) : (
          <span key={part.key} className={WORD_CLASS_NAME}>
            {part.pieces.map((piece) => (
              <span key={piece.key} style={syntaxTokenStyle(piece.token)}>
                {piece.text}
              </span>
            ))}
          </span>
        ),
      )}
      {ending}
    </span>
  ));
}

/**
 * Keys each line by its start offset, which stays unique when several lines
 * are empty, and pairs it with the line ending `code` has after it. Shiki drops
 * `\n` and `\r\n` from tokens alike, so CRLF has to come back from the source.
 */
export function keyedLines<Token extends SyntaxToken>(
  code: string,
  lines: ReadonlyArray<ReadonlyArray<Token>>,
) {
  const endings = code.match(/\r?\n/gu) ?? [];
  let lineStart = 0;
  return lines.map((tokens, index) => {
    const text = tokens.map((token) => token.content).join("");
    const key = `${lineStart}:${text}`;
    const ending = endings[index] ?? "";
    lineStart += text.length + ending.length;
    return { key, tokens, ending };
  });
}

interface Word {
  readonly key: string;
  readonly pieces: Array<{ key: string; text: string; token: SyntaxToken }>;
}

/**
 * Regroups a line's tokens into whitespace runs and whole words, matching
 * `text.split(/(\s+)/)`, so a word made of several tokens (`"$HOME/x"`) wraps
 * exactly like its plain-text fallback.
 */
export function wordsOf(tokens: ReadonlyArray<SyntaxToken>): Array<string | Word> {
  const parts: Array<string | Word> = [];
  let word: Word | null = null;
  for (const token of tokens) {
    let offset = token.offset;
    for (const text of token.content.split(/(\s+)/u)) {
      if (text === "") continue;
      if (/^\s/u.test(text)) {
        parts.push(text);
        word = null;
      } else {
        if (!word) {
          word = { key: String(offset), pieces: [] };
          parts.push(word);
        }
        word.pieces.push({ key: String(offset), text, token });
      }
      offset += text.length;
    }
  }
  return parts;
}
