import { ChatFileAttachment, ChatImageAttachment } from "@t45/contracts/models/Attachment";
import { assert, describe, it } from "@effect/vitest";

import * as PromptService from "./PromptService.ts";

const document = ChatFileAttachment.make({
  id: "00000000-0000-4000-8000-000000000001.pdf",
  type: "file",
  name: "spec.pdf",
  mimeType: "application/pdf",
  sizeBytes: 123,
});
const image = ChatImageAttachment.make({
  id: "00000000-0000-4000-8000-000000000002.png",
  type: "image",
  name: "diagram.png",
  mimeType: "image/png",
  sizeBytes: 456,
});

describe("PromptService", () => {
  it("appends resolvable file paths for documents and images", () => {
    assert.equal(
      PromptService.format({
        text: "Review these.",
        attachments: [document, image],
      }),
      'Review these.\n\n[Attached file "spec.pdf" is saved at: /work/attachments/00000000-0000-4000-8000-000000000001.pdf]\n' +
        '\n[Attached image "diagram.png" is saved at: /work/attachments/00000000-0000-4000-8000-000000000002.png]',
    );
  });

  it("appends answer files' paths and keeps selected values intact", () => {
    const original = { q: ["First", "Second"], other: "No file" };
    const answers = PromptService.formatAnswers({
      answers: original,
      attachmentsByField: { q: [{ ...document, name: 'spec "final".pdf' }] },
    });
    assert.deepEqual(answers, {
      q: [
        "First",
        "Second",
        'Attached file "spec \\"final\\".pdf": "/work/attachments/00000000-0000-4000-8000-000000000001.pdf"',
      ],
      other: "No file",
    });
    assert.deepEqual(original.q, ["First", "Second"]);
    const specialKey = PromptService.formatAnswers({
      answers: {},
      attachmentsByField: { ["__proto__"]: [document] },
    });
    assert.deepEqual(Object.keys(specialKey), ["__proto__"]);
  });
});
