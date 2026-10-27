/**
 * Downscale + re-encode for image attachments. The composer accepts
 * pasted/dropped images larger than the `ATTACHMENT_MAX_IMAGE_BYTES` wire cap
 * and shrinks them to fit via `compressImageToByteLimit` instead of rejecting
 * the paste.
 *
 * Supported images already within the cap pass through untouched. HEIC/HEIF
 * photos are decoded to JPEG first because providers cannot consume them.
 *
 * Decoding and encoding use `createImageBitmap` and `OffscreenCanvas`, which
 * every browser T45 targets has, so a missing API is reported as a decode
 * failure rather than probed for.
 */

/**
 * Longest edge kept when an image has to be re-encoded. Sized so a typical
 * retina screenshot (3024px wide) stays legible rather than being halved.
 */
const MAX_DIMENSION = 2048;
/**
 * Ceiling on the *source* file handed to the re-encoder or the HEIC decoder.
 * File size is a proxy for pixel count, and decoding hundreds of megapixels
 * can OOM the tab — beyond this we refuse rather than risk it.
 */
export const MAX_COMPRESSIBLE_SOURCE_BYTES = 50 * 1024 * 1024;
/**
 * Quality ladder tried in order until the encoded image fits the budget.
 * The floor stays high enough to avoid visible blocking on UI screenshots;
 * if even that overflows we drop resolution instead of quality.
 */
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const;
/** Extra downscale passes applied when even the lowest quality overflows. */
const FALLBACK_SCALE_STEPS = [0.75, 0.55] as const;

const IMAGE_MIME_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * Why an image could not be compressed. Callers report these differently:
 * "too large" is a budget outcome, "unreadable" is a decode failure.
 */
export type ImageCompressionFailureReason = "too-large" | "unreadable";

export type CompressImageFileResult =
  | { ok: true; file: File }
  | { ok: false; reason: ImageCompressionFailureReason };

/**
 * The file's MIME type, or the image type its extension names when it has none. Some sources
 * (drags from other apps, Finder's HEIC photos, files piped through a shell) hand over a `File`
 * with an empty or generic type.
 */
export function sniffImageMimeType(file: Pick<File, "name" | "type">): string {
  const type = file.type.toLowerCase();
  if (type !== "" && type !== "application/octet-stream") return type;
  const dotIndex = file.name.lastIndexOf(".");
  const extension = dotIndex > 0 ? file.name.slice(dotIndex + 1).toLowerCase() : "";
  return IMAGE_MIME_TYPES_BY_EXTENSION[extension] ?? type;
}

export const isHeicImageFile = (file: Pick<File, "name" | "type">) =>
  /^image\/hei[cf]$/.test(sniffImageMimeType(file));

export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

/** The image cropped to a centered square at most `maxSide` pixels wide, as a PNG data URL. */
export async function squareImageDataUrl(file: Blob, maxSide = 256): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(side, maxSide);
    canvas.height = canvas.width;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("This browser can't prepare the image.");
    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return canvas.toDataURL("image/png");
  } finally {
    bitmap.close();
  }
}

/**
 * The whole image scaled down to at most `maxSide` pixels on its longer side, as a PNG data URL.
 * `padded` centers it on a transparent square, for an icon.
 */
export async function fittedImageDataUrl(
  file: Blob,
  maxSide: number,
  padded = false,
): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = padded ? Math.max(width, height) : width;
    canvas.height = padded ? canvas.width : height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("This browser can't prepare the image.");
    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap,
      (canvas.width - width) / 2,
      (canvas.height - height) / 2,
      width,
      height,
    );
    return canvas.toDataURL("image/png");
  } finally {
    bitmap.close();
  }
}

/**
 * Re-encoding changes the container, so a name like `shot.png` would lie
 * about its contents. Swap the extension to match the encoded mime type.
 */
function fileNameForMimeType(name: string, mimeType: string): string {
  const extension = mimeType === "image/webp" ? ".webp" : ".jpg";
  const dotIndex = name.lastIndexOf(".");
  const base = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  return `${base}${extension}`;
}

/**
 * WebP is preferred: at matched visual quality it lands roughly 25-35%
 * smaller than JPEG, so the same budget buys more resolution and detail —
 * and it keeps alpha, so screenshots with transparency survive intact.
 * Browsers that can't encode it silently fall back to JPEG.
 */
async function encodeCanvas(canvas: OffscreenCanvas, quality: number, mimeType: string) {
  const blob = await canvas.convertToBlob({ type: mimeType, quality });
  return blob.type === mimeType ? blob : null;
}

/** WebP when the browser can encode it, else JPEG. */
async function webpOrJpeg() {
  try {
    const context = new OffscreenCanvas(1, 1).getContext("2d");
    const webp = context && (await encodeCanvas(context.canvas, QUALITY_STEPS[0], "image/webp"));
    return webp ? "image/webp" : "image/jpeg";
  } catch {
    return "image/jpeg";
  }
}

const composerThumbnails = new WeakMap<File, Promise<string | null>>();

/** Cache a centered square crop for the composer's object-cover image tiles. */
export function createComposerImageThumbnail(file: File): Promise<string | null> {
  const cached = composerThumbnails.get(file);
  if (cached) return cached;
  const thumbnail = squareImageDataUrl(file).catch(() => null);
  composerThumbnails.set(file, thumbnail);
  return thumbnail;
}

/**
 * Draws `bitmap` scaled to fit `maxDimension` and encodes it as `mimeType`, stepping
 * quality down until the encoding fits `maxBytes`.
 */
async function encodeWithinBudget(
  bitmap: ImageBitmap,
  maxDimension: number,
  maxBytes: number,
  mimeType: string,
): Promise<Blob | null> {
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) return null;

  // JPEG has no alpha, so it needs a white matte under the image.
  if (mimeType === "image/jpeg") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap, 0, 0, width, height);

  for (const quality of QUALITY_STEPS) {
    const encoded = await encodeCanvas(canvas, quality, mimeType);
    if (!encoded) break;
    if (encoded.size <= maxBytes) return encoded;
  }
  return null;
}

type ReencodeResult =
  | { ok: true; blob: Blob }
  | { ok: false; reason: ImageCompressionFailureReason };

/**
 * Decodes `file`, then walks the quality ladder and fallback downscale passes
 * until an encoding fits `maxBytes`.
 */
async function reencodeWithinBudget(
  file: File,
  maxBytes: number,
  preferredMimeType?: "image/jpeg",
): Promise<ReencodeResult> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  try {
    const mimeType = preferredMimeType ?? (await webpOrJpeg());
    // Each pass shrinks relative to the *previous target*, capped by
    // MAX_DIMENSION. Scaling a fixed ceiling instead would be a no-op for
    // images already smaller than that ceiling — the fallback passes would
    // all resolve to the source size and never actually reduce resolution.
    const baseDimension = Math.min(MAX_DIMENSION, Math.max(bitmap.width, bitmap.height));
    // Tracks whether the *last* attempt threw, so a run of encoder failures
    // is reported as unreadable while a run of merely-too-big results is
    // reported as too-large.
    let encodeFailed = false;
    for (const dimensionScale of [1, ...FALLBACK_SCALE_STEPS]) {
      const targetDimension = Math.max(1, Math.round(baseDimension * dimensionScale));
      let encoded: Blob | null;
      try {
        encoded = await encodeWithinBudget(bitmap, targetDimension, maxBytes, mimeType);
      } catch {
        // Canvas allocation, drawing, or the codec itself can throw — often
        // precisely *because* the target is too big (OOM on a large bitmap).
        // Keep trying the smaller fallback scales rather than giving up: a
        // reduced pass may well succeed. The exception must never escape,
        // though, since callers settle the paste after this returns.
        encodeFailed = true;
        continue;
      }
      encodeFailed = false;
      if (encoded) return { ok: true, blob: encoded };
    }
    return { ok: false, reason: encodeFailed ? "unreadable" : "too-large" };
  } finally {
    bitmap.close();
  }
}

/**
 * Shrinks `file` until its binary size fits `maxBytes`, returning a new
 * `File` (WebP or JPEG). Files already within the limit pass through
 * untouched, preserving their exact bytes and format. Sources above
 * `MAX_COMPRESSIBLE_SOURCE_BYTES` are refused outright — decoding them is
 * the risk, so no amount of output budget makes them safe. An internally
 * converted image can provide its original source size when the intermediate
 * format expands beyond that ceiling.
 */
async function compressImageToByteLimit(
  file: File,
  maxBytes: number,
  options?: { preferredMimeType?: "image/jpeg"; sourceSizeBytes?: number },
): Promise<CompressImageFileResult> {
  if (file.size <= maxBytes) {
    return { ok: true, file };
  }
  if ((options?.sourceSizeBytes ?? file.size) > MAX_COMPRESSIBLE_SOURCE_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  const reencoded = await reencodeWithinBudget(file, maxBytes, options?.preferredMimeType);
  if (!reencoded.ok) {
    return reencoded;
  }
  return {
    ok: true,
    file: new File(
      [reencoded.blob],
      fileNameForMimeType(file.name || "image", reencoded.blob.type),
      { type: reencoded.blob.type },
    ),
  };
}

/**
 * Converts HEIC/HEIF photos to provider-compatible JPEG before applying the
 * attachment size limit. The decoder is loaded only when such a photo arrives.
 */
export async function prepareImageForAttachment(
  file: File,
  maxBytes: number,
): Promise<CompressImageFileResult> {
  if (!isHeicImageFile(file)) {
    return compressImageToByteLimit(file, maxBytes);
  }

  if (file.size > MAX_COMPRESSIBLE_SOURCE_BYTES) {
    return { ok: false, reason: "too-large" };
  }

  let converted: Blob;
  try {
    const { heicTo } = await import("heic-to/csp");
    converted = await heicTo({ blob: file, type: "image/jpeg", quality: QUALITY_STEPS[0] });
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const jpeg = new File([converted], fileNameForMimeType(file.name || "image", "image/jpeg"), {
    type: "image/jpeg",
    lastModified: file.lastModified,
  });
  return compressImageToByteLimit(jpeg, maxBytes, {
    preferredMimeType: "image/jpeg",
    sourceSizeBytes: file.size,
  });
}
