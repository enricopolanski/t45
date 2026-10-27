import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  isHeicImageFile,
  MAX_COMPRESSIBLE_SOURCE_BYTES,
  prepareImageForAttachment,
} from "./imageCompression";

const mocks = vi.hoisted(() => ({
  heicTo: vi.fn(),
}));

vi.mock("heic-to/csp", () => ({
  heicTo: mocks.heicTo,
}));

afterEach(() => {
  mocks.heicTo.mockReset();
});

describe("HEIC attachment preparation", () => {
  it("recognizes HEIC and HEIF MIME types and case-insensitive file extensions", () => {
    expect(isHeicImageFile({ name: "photo.bin", type: "image/heic" })).toBe(true);
    expect(isHeicImageFile({ name: "photo.bin", type: "image/heif" })).toBe(true);
    expect(isHeicImageFile({ name: "photo.heic", type: "image/heic-sequence" })).toBe(false);
    expect(isHeicImageFile({ name: "photo.heif", type: "image/heif-sequence" })).toBe(false);
    expect(isHeicImageFile({ name: "IMG_1234.HEIC", type: "" })).toBe(true);
    expect(isHeicImageFile({ name: "photo.heif", type: "application/octet-stream" })).toBe(true);
    expect(isHeicImageFile({ name: "photo.png", type: "image/png" })).toBe(false);
    expect(isHeicImageFile({ name: "photo.heic", type: "image/png" })).toBe(false);
    expect(isHeicImageFile({ name: "photo.heif", type: "image/jpeg" })).toBe(false);
  });

  it("converts a HEIC photo with a missing MIME type into a named JPEG", async () => {
    const original = new File(["heic"], "IMG_1234.HEIC", { type: "", lastModified: 123 });
    mocks.heicTo.mockResolvedValueOnce(
      new Blob([new Uint8Array([4, 5, 6, 7])], { type: "image/jpeg" }),
    );

    const result = await prepareImageForAttachment(original, 1024);

    expect(mocks.heicTo).toHaveBeenCalledWith({
      blob: original,
      type: "image/jpeg",
      quality: 0.92,
    });
    expect(result.ok && result.file.name).toBe("IMG_1234.jpg");
    expect(result.ok && result.file.type).toBe("image/jpeg");
    expect(result.ok && result.file.size).toBe(4);
    expect(result.ok && result.file.lastModified).toBe(123);
  });

  it("reports unreadable when HEIC decoding fails", async () => {
    const original = new File(["heic"], "broken.heic", { type: "image/heic" });
    mocks.heicTo.mockRejectedValueOnce(new Error("Invalid HEIC image"));

    expect(await prepareImageForAttachment(original, 1024)).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("rejects unsafe HEIC sources before loading the decoder", async () => {
    const original = new File(["photo"], "large.heic", { type: "image/heic" });
    Object.defineProperty(original, "size", { value: MAX_COMPRESSIBLE_SOURCE_BYTES + 1 });

    expect(await prepareImageForAttachment(original, 1024)).toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(mocks.heicTo).not.toHaveBeenCalled();
  });
});
