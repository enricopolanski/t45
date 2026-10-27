export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseWebUrl(url: string): URL | null {
  try {
    return new URL(url.startsWith("//") ? `https:${url}` : url);
  } catch {
    return null;
  }
}

/** The host of an http(s) link, protocol-relative ones included; null for anything else. */
export function webUrlHost(href: string | undefined): string | null {
  const url = href ? parseWebUrl(href) : null;
  return url && (url.protocol === "http:" || url.protocol === "https:")
    ? url.hostname || null
    : null;
}

const IMAGE_EXTENSIONS = new Set(["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);

/**
 * Whether a link names an image: its decoded file name has an image extension. Query strings
 * and fragments are not the file name.
 */
export function isImagePath(href: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(href, "https://media.invalid").pathname;
  } catch {
    return false;
  }
  const basename = safeDecodeURIComponent(pathname).split(/[\\/]/).at(-1) ?? "";
  const extension = /\.([a-z0-9]+)$/i.exec(basename)?.[1];
  return extension !== undefined && IMAGE_EXTENSIONS.has(extension.toLowerCase());
}

/** The file name in a web URL, its escapes decoded exactly once. */
export function webUrlFileName(url: string): string | undefined {
  const basename = parseWebUrl(url)?.pathname.split("/").at(-1);
  return basename ? safeDecodeURIComponent(basename) : undefined;
}

/** Gives a protocol-relative URL the page's scheme, so it opens and fetches the same everywhere. */
export function resolveProtocolRelativeUrl(src: string): string {
  return src.startsWith("//") ? `${window.location.protocol}${src}` : src;
}
