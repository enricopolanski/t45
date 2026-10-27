import type { Form } from "@opencode/schema/form";
import type { ChatAttachment } from "@t45/contracts/models/Attachment";
import type { Question } from "@t45/contracts/resources/Chats";

import type { QuestionAnswer } from "../../questionDrafts";

type FormField = Form.Info["fields"][number];
type FormOption = NonNullable<Extract<FormField, { type: "string" }>["options"]>[number];
/** A native form's answers, by field key, as OpenCode takes them. */
type FormAnswer = Form.Answer;
type FormAnswerValue = FormAnswer[string];

/** What the member has entered for one field so far, with the state of its files. */
export interface FieldDraft extends QuestionAnswer {
  readonly attachmentCount?: number;
  readonly attachmentsBlocked?: boolean;
}

/** One field of an agent's question, as the composer shows it. */
export interface QuestionField {
  /** The form field's key. */
  readonly key: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<FormOption>;
  readonly multiSelect: boolean;
  readonly allowCustomAnswer: boolean;
  /** Whether files can go with the answer, and answer it alone. */
  readonly acceptsAttachments: boolean;
}

/** An agent's question waiting in the composer: one native form, its fields asked one by one. */
export interface AskedQuestion {
  /** `<session>:<form>`, unique across the chat's sessions. */
  readonly key: string;
  readonly question: Question;
  /** The fields to ask now: hidden fields and those whose conditions fail are left out. */
  readonly fields: ReadonlyArray<QuestionField>;
  /** False when a field needs a step outside the chat, so the form can only be dismissed. */
  readonly answerable: boolean;
}

export const questionKey = (question: Question) => `${question.sessionId}:${question.form.id}`;

const BOOLEAN_OPTIONS: ReadonlyArray<FormOption> = [
  { label: "Yes", value: "true" },
  { label: "No", value: "false" },
];

const fieldOptions = (field: FormField): ReadonlyArray<FormOption> =>
  field.type === "string" || field.type === "multiselect"
    ? (field.options ?? [])
    : field.type === "boolean"
      ? BOOLEAN_OPTIONS
      : [];

const allowsCustomAnswer = (field: FormField) =>
  field.type === "string"
    ? field.options === undefined || field.custom === true
    : field.type === "multiselect"
      ? field.custom === true
      : field.type === "number" || field.type === "integer";

/** Files go with a typed answer, so only text fields that take one carry them. */
const acceptsAttachments = (field: FormField) =>
  field.type === "string" && allowsCustomAnswer(field);

function questionField(form: Form.Info, field: FormField): QuestionField {
  const text = field.description ?? field.title ?? form.title;
  return {
    key: field.key,
    header: field.title ?? form.title,
    question: field.type === "external" ? [text, field.url].join("\n") : text,
    options: fieldOptions(field),
    multiSelect: field.type === "multiselect",
    allowCustomAnswer: allowsCustomAnswer(field),
    acceptsAttachments: acceptsAttachments(field),
  };
}

const isEmptyAnswer = (value: FormAnswerValue | undefined) =>
  value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

const parsesAs = (field: FormField, value: number) =>
  Number.isFinite(value) && (field.type !== "integer" || Number.isInteger(value));

/**
 * The field's draft in its native type, or undefined when it has none or it doesn't parse. Typed
 * text outranks picked options, and a pick counts only when it is one of the field's options.
 */
function draftValue(field: FormField, draft: FieldDraft | undefined): FormAnswerValue | undefined {
  const typed = allowsCustomAnswer(field) ? (draft?.customAnswer?.trim() ?? "") : "";
  const options = fieldOptions(field);
  const picked = (draft?.selectedOptionValues ?? []).filter((value) =>
    options.some((option) => option.value === value),
  );
  switch (field.type) {
    case "string":
      return typed || picked[0];
    case "multiselect":
      return typed ? [typed] : picked.length > 0 ? picked : undefined;
    case "boolean":
      return picked[0] === undefined ? undefined : picked[0] === "true";
    case "number":
    case "integer": {
      const value = Number(typed);
      return typed !== "" && parsesAs(field, value) ? value : undefined;
    }
    case "external":
      return undefined;
  }
}

/** Why a field's draft can't be sent yet, given its value after defaults, or null when it can. */
function fieldProblem(
  field: FormField,
  draft: FieldDraft | undefined,
  value: FormAnswerValue | undefined,
): string | null {
  if (field.type === "external") return null;
  const label = field.title ?? field.key;
  if (draft?.attachmentsBlocked) {
    return "Wait for attachments to finish uploading, or remove failed uploads.";
  }
  const typed = draft?.customAnswer?.trim() ?? "";
  if ((field.type === "number" || field.type === "integer") && typed !== "") {
    if (!parsesAs(field, Number(typed))) {
      return `Answer ${label} with ${field.type === "integer" ? "a whole number" : "a number"}.`;
    }
  }
  const filesAnswer = acceptsAttachments(field) && (draft?.attachmentCount ?? 0) > 0;
  if (field.required === true && isEmptyAnswer(value) && !filesAnswer) {
    return `Answer ${label} first.`;
  }
  if (field.type === "multiselect" && Array.isArray(value)) {
    if (
      (field.minItems !== undefined && value.length < field.minItems) ||
      (field.maxItems !== undefined && value.length > field.maxItems)
    ) {
      return `Check how many choices ${label} takes.`;
    }
  }
  return null;
}

/** A field's `when` conditions against the answers so far; an unanswered field fails both ops. */
function conditionsHold(field: FormField, answers: FormAnswer): boolean {
  if (field.type === "external" || field.when === undefined) return true;
  return field.when.every((condition) => {
    const value = answers[condition.key];
    if (value === undefined) return false;
    const equal = Array.isArray(value)
      ? typeof condition.value === "string" && value.includes(condition.value)
      : value === condition.value;
    return condition.op === "eq" ? equal : !equal;
  });
}

/**
 * Walks the form in order, as its conditions may only look back: which fields are asked now, why
 * each can't be sent yet, and what each answered or defaulted field holds so far.
 */
function walkForm(form: Form.Info, drafts: Record<string, FieldDraft>) {
  const answers: Record<string, FormAnswerValue> = {};
  const visible: Array<{ readonly field: FormField; readonly problem: string | null }> = [];
  for (const field of form.fields) {
    const hidden = field.type !== "external" && field.hidden === true;
    if (!hidden && !conditionsHold(field, answers)) continue;
    const draft = drafts[field.key];
    const value =
      (hidden ? undefined : draftValue(field, draft)) ??
      (field.type === "external" ? undefined : field.default);
    if (value !== undefined) answers[field.key] = value;
    if (!hidden) visible.push({ field, problem: fieldProblem(field, draft, value) });
  }
  return { answers, visible };
}

/** The questions waiting in the chat, oldest first, each with the fields its answers so far open. */
export function deriveAskedQuestions(
  questions: ReadonlyArray<Question>,
  draftsByQuestion: Record<string, Record<string, FieldDraft>>,
): AskedQuestion[] {
  return questions.map((question) => {
    const key = questionKey(question);
    const { visible } = walkForm(question.form, draftsByQuestion[key] ?? {});
    return {
      key,
      question,
      fields: visible.map(({ field }) => questionField(question.form, field)),
      answerable: !visible.some(({ field }) => field.type === "external"),
    };
  });
}

export interface QuestionProgress {
  fieldIndex: number;
  field: QuestionField | null;
  selectedOptionValues: ReadonlyArray<string>;
  customAnswer: string;
  isLastField: boolean;
  /** Why the member can't go on yet: the field on screen, or on the last one the whole form. */
  blockedReason: string | null;
}

/** Where the member is in a question's fields, and whether they can go on. */
export function deriveQuestionProgress(
  asked: AskedQuestion,
  drafts: Record<string, FieldDraft>,
  fieldIndex: number,
): QuestionProgress {
  const { fields } = asked;
  const index = Math.max(0, Math.min(fieldIndex, fields.length - 1));
  const field = fields[index] ?? null;
  const draft = field ? drafts[field.key] : undefined;
  const isLastField = index >= fields.length - 1;
  const { visible } = walkForm(asked.question.form, drafts);
  const blockedReason = isLastField
    ? (visible.find(({ problem }) => problem !== null)?.problem ?? null)
    : (visible.find((entry) => entry.field.key === field?.key)?.problem ?? null);
  return {
    fieldIndex: index,
    field,
    selectedOptionValues: draft?.selectedOptionValues ?? [],
    customAnswer: field?.allowCustomAnswer ? (draft?.customAnswer ?? "") : "",
    isLastField,
    blockedReason,
  };
}

/** Typing an answer drops the picked options, which typed text would outrank anyway. */
export function typeAnswer(draft: FieldDraft | undefined, customAnswer: string): FieldDraft {
  const selectedOptionValues =
    customAnswer.trim().length > 0 ? undefined : draft?.selectedOptionValues;
  return {
    customAnswer,
    ...(selectedOptionValues && selectedOptionValues.length > 0 ? { selectedOptionValues } : {}),
  };
}

/** Picking an option clears the typed answer; a multi-select field toggles it among the others. */
export function toggleOption(
  field: QuestionField,
  draft: FieldDraft | undefined,
  optionValue: string,
): FieldDraft {
  if (!field.multiSelect) return { customAnswer: "", selectedOptionValues: [optionValue] };
  const selected = draft?.selectedOptionValues ?? [];
  const next = selected.includes(optionValue)
    ? selected.filter((value) => value !== optionValue)
    : [...selected, optionValue];
  return { customAnswer: "", ...(next.length > 0 ? { selectedOptionValues: next } : {}) };
}

/**
 * Picking an option replaces the typed answer. Text the member typed into the answer field must
 * not vanish on that click: it moves back into the chat's draft, after whatever was already there.
 */
export function carryDisplacedCustomAnswerIntoPrompt(
  prompt: string,
  customAnswer: string | undefined,
): string {
  const displaced = customAnswer?.trim() ?? "";
  if (displaced.length === 0) return prompt;
  if (prompt.trim().length === 0) return displaced;
  return `${prompt.trimEnd()}\n\n${displaced}`;
}

export type FormAnswerResult =
  | { readonly _tag: "answer"; readonly answers: FormAnswer }
  | { readonly _tag: "invalid"; readonly message: string };

/**
 * The form's answer from the member's drafts: each asked field in its native type, hidden and
 * unanswered fields at their defaults, or the first reason a field can't be sent yet.
 */
export function formAnswerFromDrafts(
  form: Form.Info,
  drafts: Record<string, FieldDraft>,
): FormAnswerResult {
  const { answers, visible } = walkForm(form, drafts);
  const problem = visible.find((entry) => entry.problem !== null)?.problem;
  return problem ? { _tag: "invalid", message: problem } : { _tag: "answer", answers };
}

/** The files to send with a form's answer: only fields that take typed text carry them. */
export function formAttachments(
  form: Form.Info,
  attachmentsByFieldKey: ReadonlyMap<string, ReadonlyArray<ChatAttachment>>,
): Record<string, ReadonlyArray<ChatAttachment>> {
  const result: Record<string, ReadonlyArray<ChatAttachment>> = {};
  for (const field of form.fields) {
    const attachments = attachmentsByFieldKey.get(field.key);
    if (acceptsAttachments(field) && attachments !== undefined && attachments.length > 0) {
      result[field.key] = attachments;
    }
  }
  return result;
}
