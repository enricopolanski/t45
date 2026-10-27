import { describe, expect, it } from "vite-plus/test";

import { attachmentUploadUrl, attachmentUrl } from "./attachmentUrl";

describe("attachment URLs", () => {
  it("names the file in the path", () => {
    expect(
      attachmentUrl({
        id: "00000000-0000-4000-8000-000000000001.pdf",
        name: "Q3 report #1.pdf",
      }),
    ).toBe("/api/attachments/00000000-0000-4000-8000-000000000001.pdf/Q3%20report%20%231.pdf");
    expect(attachmentUrl({ id: "pending-1" })).toBe("/api/attachments/pending-1/pending-1");
  });

  it("describes the upload in the upload URL", () => {
    expect(attachmentUploadUrl({ type: "file", name: "a&b.txt", mimeType: "text/plain" })).toBe(
      "/api/attachments?type=file&name=a%26b.txt&mimeType=text%2Fplain",
    );
  });
});
