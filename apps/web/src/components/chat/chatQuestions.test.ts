import { describe, expect, it } from "vite-plus/test";

import { decodeChatQuestion } from "../../state/chats.testkit";
import {
  carryDisplacedCustomAnswerIntoPrompt,
  deriveAskedQuestions,
  deriveQuestionProgress,
  formAnswerFromDrafts,
  formAttachments,
  questionKey,
  toggleOption,
  typeAnswer,
  type FieldDraft,
} from "./chatQuestions";

const question = (fields: ReadonlyArray<unknown>) =>
  decodeChatQuestion({
    sessionId: "ses_root",
    form: { id: "frm_1", sessionID: "ses_root", title: "Setup", fields },
  });

const asked = (fields: ReadonlyArray<unknown>) => deriveAskedQuestions([question(fields)], {})[0]!;

const answer = (fields: ReadonlyArray<unknown>, drafts: Record<string, FieldDraft>) =>
  formAnswerFromDrafts(question(fields).form, drafts);

const choices = [
  { value: " first\t", label: "Result" },
  { value: "second", label: "Result" },
];

describe("deriveAskedQuestions", () => {
  it("asks each field as a question, with yes and no for a boolean", () => {
    const input = asked([
      {
        key: "db",
        type: "string",
        title: "Database",
        description: "Which database?",
        options: [{ value: "pg", label: "Postgres" }],
        required: true,
      },
      { key: "tests", type: "boolean", title: "Run tests?" },
    ]);
    expect(input.key).toBe("ses_root:frm_1");
    expect(input.answerable).toBe(true);
    expect(input.fields).toEqual([
      expect.objectContaining({
        key: "db",
        header: "Database",
        question: "Which database?",
        options: [{ value: "pg", label: "Postgres" }],
        allowCustomAnswer: false,
        acceptsAttachments: false,
      }),
      expect.objectContaining({
        key: "tests",
        options: [
          { label: "Yes", value: "true" },
          { label: "No", value: "false" },
        ],
      }),
    ]);
  });

  it("asks a field only once its conditions hold, and never a hidden one", () => {
    const form = question([
      { key: "deploy", type: "boolean", title: "Deploy?" },
      {
        key: "target",
        type: "string",
        title: "Where?",
        when: [{ key: "deploy", op: "eq", value: true }],
      },
      { key: "token", type: "string", hidden: true, default: "auto" },
    ]);
    const askedFields = (deploy?: string) =>
      deriveAskedQuestions(
        [form],
        deploy === undefined
          ? {}
          : { [questionKey(form)]: { deploy: { selectedOptionValues: [deploy] } } },
      )[0]?.fields.map((entry) => entry.key);
    expect(askedFields()).toEqual(["deploy"]);
    expect(askedFields("false")).toEqual(["deploy"]);
    expect(askedFields("true")).toEqual(["deploy", "target"]);
  });

  it("leaves a form that needs a step outside the chat to be dismissed", () => {
    expect(
      asked([{ key: "auth", type: "external", url: "https://example.test/login" }]).answerable,
    ).toBe(false);
  });
});

describe("formAnswerFromDrafts", () => {
  it("answers each field in its own type and fills hidden and unanswered fields from defaults", () => {
    expect(
      answer(
        [
          { key: "count", type: "integer", title: "How many?" },
          { key: "tests", type: "boolean" },
          { key: "tags", type: "multiselect", options: choices },
          { key: "region", type: "string", default: "eu" },
          { key: "token", type: "string", hidden: true, default: "auto" },
        ],
        {
          count: { customAnswer: " 3 " },
          tests: { selectedOptionValues: ["false"] },
          tags: { selectedOptionValues: [" first\t", "second"] },
        },
      ),
    ).toEqual({
      _tag: "answer",
      answers: {
        count: 3,
        tests: false,
        tags: [" first\t", "second"],
        region: "eu",
        token: "auto",
      },
    });
  });

  it("prefers typed text over picked options, unless the field takes no typed text", () => {
    const drafts = { pick: { selectedOptionValues: ["second"], customAnswer: "Use another" } };
    expect(
      answer([{ key: "pick", type: "string", options: choices, custom: true }], drafts),
    ).toEqual({ _tag: "answer", answers: { pick: "Use another" } });
    expect(answer([{ key: "pick", type: "string", options: choices }], drafts)).toEqual({
      _tag: "answer",
      answers: { pick: "second" },
    });
    expect(
      answer([{ key: "tags", type: "multiselect", options: choices, custom: true }], {
        tags: { customAnswer: "both" },
      }),
    ).toEqual({ _tag: "answer", answers: { tags: ["both"] } });
  });

  it.each([" first\t", ""])("sends the exact picked option value %j", (value) => {
    const fields = [
      { key: "pick", type: "string", options: [{ value, label: "Result" }, choices[1]] },
    ];
    expect(
      answer(fields, { pick: toggleOption(asked(fields).fields[0]!, undefined, value) }),
    ).toEqual({ _tag: "answer", answers: { pick: value } });
  });

  it("ignores picks that are not one of the field's options", () => {
    expect(
      answer([{ key: "pick", type: "string", options: choices, required: true }], {
        pick: { selectedOptionValues: ["Result", "unknown"] },
      })._tag,
    ).toBe("invalid");
  });

  it("refuses a missing required answer, a number that doesn't parse and too many choices", () => {
    expect(answer([{ key: "name", type: "string", title: "Name", required: true }], {})).toEqual({
      _tag: "invalid",
      message: "Answer Name first.",
    });
    expect(
      answer([{ key: "count", type: "integer", title: "Count" }], {
        count: { customAnswer: "2.5" },
      }),
    ).toEqual({ _tag: "invalid", message: "Answer Count with a whole number." });
    expect(answer([{ key: "ratio", type: "number" }], { ratio: { customAnswer: "2.5" } })).toEqual({
      _tag: "answer",
      answers: { ratio: 2.5 },
    });
    expect(
      answer([{ key: "tags", type: "multiselect", maxItems: 1, options: choices }], {
        tags: { selectedOptionValues: [" first\t", "second"] },
      })._tag,
    ).toBe("invalid");
  });

  it("takes files alone as the answer to a required text field, once they finish uploading", () => {
    const report = [{ key: "report", type: "string", required: true }];
    expect(answer(report, { report: { attachmentCount: 1 } })._tag).toBe("answer");
    expect(answer(report, { report: { attachmentCount: 1, attachmentsBlocked: true } })).toEqual({
      _tag: "invalid",
      message: "Wait for attachments to finish uploading, or remove failed uploads.",
    });
    const choice = [{ key: "pick", type: "string", options: choices, required: true }];
    expect(answer(choice, { pick: { attachmentCount: 1 } })._tag).toBe("invalid");
  });
});

describe("deriveQuestionProgress", () => {
  const fields = [
    { key: "name", type: "string", title: "Name", required: true },
    { key: "count", type: "integer", title: "Count" },
  ];

  it("blocks the field on screen until it can be sent", () => {
    expect(deriveQuestionProgress(asked(fields), {}, 0)).toMatchObject({
      fieldIndex: 0,
      field: expect.objectContaining({ key: "name" }),
      isLastField: false,
      blockedReason: "Answer Name first.",
    });
    expect(
      deriveQuestionProgress(asked(fields), { name: { customAnswer: "Ada" } }, 0).blockedReason,
    ).toBeNull();
    expect(
      deriveQuestionProgress(asked(fields), { count: { customAnswer: "many" } }, 1).blockedReason,
    ).toBe("Answer Name first.");
    expect(
      deriveQuestionProgress(
        asked(fields),
        { name: { customAnswer: "Ada" }, count: { customAnswer: "many" } },
        1,
      ).blockedReason,
    ).toBe("Answer Count with a whole number.");
  });

  it("shows no typed answer for a field that takes none", () => {
    const fieldsWithChoice = [{ key: "pick", type: "string", options: choices }];
    expect(
      deriveQuestionProgress(asked(fieldsWithChoice), { pick: { customAnswer: "typed" } }, 0),
    ).toMatchObject({ customAnswer: "", selectedOptionValues: [] });
  });
});

describe("toggleOption and typeAnswer", () => {
  const tags = asked([{ key: "tags", type: "multiselect", options: choices }]).fields[0]!;

  it("toggles options with the same label independently and clears the typed answer", () => {
    const first = toggleOption(tags, { customAnswer: "typed" }, " first\t");
    expect(first).toEqual({ customAnswer: "", selectedOptionValues: [" first\t"] });
    const both = toggleOption(tags, first, "second");
    expect(both.selectedOptionValues).toEqual([" first\t", "second"]);
    expect(toggleOption(tags, both, " first\t").selectedOptionValues).toEqual(["second"]);
  });

  it("drops the picked options once an answer is typed", () => {
    expect(typeAnswer({ selectedOptionValues: ["second"] }, "doesn't matter")).toEqual({
      customAnswer: "doesn't matter",
    });
    expect(typeAnswer({ selectedOptionValues: ["second"] }, " ")).toEqual({
      customAnswer: " ",
      selectedOptionValues: ["second"],
    });
  });
});

describe("carryDisplacedCustomAnswerIntoPrompt", () => {
  it("keeps the chat's draft when nothing was typed into the answer", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("draft", undefined)).toBe("draft");
    expect(carryDisplacedCustomAnswerIntoPrompt("draft", "   ")).toBe("draft");
  });

  it("moves the typed answer into an empty draft", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("", "also rename the flag ")).toBe(
      "also rename the flag",
    );
  });

  it("appends the typed answer after an existing draft", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("first half\n", "second half")).toBe(
      "first half\n\nsecond half",
    );
  });
});

describe("formAttachments", () => {
  it("sends files only with fields that take typed text", () => {
    const form = question([
      { key: "report", type: "string" },
      { key: "count", type: "number" },
      { key: "pick", type: "string", options: choices },
    ]).form;
    const file = {
      type: "file",
      id: "upload-1",
      name: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
    } as const;
    expect(
      formAttachments(
        form,
        new Map([
          ["report", [file]],
          ["count", [file]],
          ["pick", [file]],
        ]),
      ),
    ).toEqual({ report: [file] });
  });
});
