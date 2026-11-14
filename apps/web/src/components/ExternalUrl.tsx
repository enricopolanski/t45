// Adapted from pingdotgg/t3code's MarkdownExternalLink (MIT), commit
// 121f0cf014dcd6e94327588bf3f1f200a5f07ad7. See the root LICENSE.
import { GlobeIcon } from "lucide-react";
import { Children, useState, type ComponentProps, type ReactNode } from "react";

import { getFaviconUrl } from "../lib/favicon";
import { cn } from "../lib/utils";
import { webUrlHost } from "../lib/webUrl";
import { GitHubIcon } from "./Icons";

// Inline and selectable so selecting a line includes the entire link.
const FAVICON_CLASS_NAME = "inline-block size-3.5 [vertical-align:-0.125em]";
const failedFaviconHosts = new Set<string>();

function Favicon({ host }: { host: string }) {
  const [failedHost, setFailedHost] = useState<string | null>(null);
  const isGitHub = host === "github.com" || host.endsWith(".github.com");
  const faviconUrl = isGitHub ? null : getFaviconUrl(`https://${host}`);
  return (
    <span className="ms-[0.25em] me-[0.2em]" aria-hidden>
      {isGitHub ? (
        <GitHubIcon className={FAVICON_CLASS_NAME} />
      ) : faviconUrl === null || failedHost === host || failedFaviconHosts.has(host) ? (
        <GlobeIcon className={FAVICON_CLASS_NAME} />
      ) : (
        <img
          src={faviconUrl}
          alt=""
          loading="lazy"
          draggable={false}
          referrerPolicy="no-referrer"
          className={cn(FAVICON_CLASS_NAME, "rounded-sm")}
          onError={() => {
            failedFaviconHosts.add(host);
            setFailedHost(host);
          }}
        />
      )}
    </span>
  );
}

function getLeadingTextLength(text: string): number {
  const protocol = /^https?:\/\//i.exec(text)?.[0];
  if (protocol) return protocol.length;
  // Keep a whole code point together, including emoji represented by surrogate pairs.
  return Array.from(text.slice(0, 2))[0]?.length ?? 0;
}

function renderBreakableText(text: string): ReactNode[] {
  // Short words remain intact; long URLs can wrap even inside a narrow table cell.
  return Array.from(text.matchAll(/\s+|\S+/g), ({ 0: word, index: start }) =>
    word.length <= 16 ? (
      word
    ) : (
      <span key={start} className="wrap-anywhere">
        {word}
      </span>
    ),
  );
}

/** An external web link with its site's icon. Without children, the URL is its label. */
export function ExternalUrl({
  href,
  children = href,
  className,
  ...props
}: Omit<ComponentProps<"a">, "href" | "target" | "rel"> & { href: string }) {
  const host = webUrlHost(href);
  if (host === null) return <span className={className}>{children}</span>;

  const [first, ...rest] = Children.toArray(children);
  const text = typeof first === "string" ? first : "";
  const leadingLength = getLeadingTextLength(text);
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("text-primary underline underline-offset-2", className)}
    >
      {text ? (
        <>
          <span className="whitespace-nowrap">
            <Favicon host={host} />
            {text.slice(0, leadingLength)}
          </span>
          {renderBreakableText(text.slice(leadingLength))}
        </>
      ) : (
        <span className="wrap-anywhere">
          <Favicon host={host} />
          {first}
        </span>
      )}
      {rest}
    </a>
  );
}
