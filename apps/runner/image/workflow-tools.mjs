#!/usr/bin/env node
// The workflow drafting tool inside a chat's VM: a stdio MCP server with one tool, `draft`. It
// reaches nothing: it checks the draft the way T45 checks a saved one, so the agent can fix a
// mistake, and answers. T45 sees the call in the chat and shows the draft to the member, who
// creates the workflow as their own; T45 checks it again then.
import { refuse, serve } from "./mcp-stdio.mjs";

const KEY = /^[A-Za-z0-9_-]{1,64}$/u;
const FIELD_TYPES = ["text", "number", "yes_no", "date", "file", "select", "group"];

/** A field's JSON schema; `depth` counts the groups around it, and only two levels of groups nest. */
const fieldSchema = (depth) => {
  const base = {
    key: { type: "string", description: "Letters, digits, - and _; unique in the workflow." },
    label: { type: "string" },
    description: { type: "string", description: "What to put in it, shown under the label." },
  };
  return {
    oneOf: [
      ...["text", "number", "yes_no", "date", "file"].map((type) => ({
        type: "object",
        properties: { ...base, type: { const: type } },
        required: ["key", "label", "type"],
        additionalProperties: false,
      })),
      {
        type: "object",
        properties: {
          ...base,
          type: { const: "select" },
          options: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["key", "label", "type", "options"],
        additionalProperties: false,
      },
      ...(depth < 2
        ? [
            {
              type: "object",
              properties: {
                ...base,
                type: { const: "group" },
                fields: { type: "array", items: fieldSchema(depth + 1), minItems: 1 },
                repeatable: {
                  type: "boolean",
                  description: "Whether the group is filled in as rows.",
                },
              },
              required: ["key", "label", "type", "fields", "repeatable"],
              additionalProperties: false,
            },
          ]
        : []),
    ],
  };
};

const stepSchema = {
  type: "object",
  properties: {
    key: { type: "string", description: "Letters, digits, - and _; unique in the workflow." },
    name: { type: "string" },
    instructions: {
      type: "string",
      description: "What to do: guidance for a person, the brief for an agent.",
    },
    fields: { type: "array", items: fieldSchema(0) },
    subSteps: {
      type: "array",
      items: { type: "object" },
      description:
        "Sub-steps, each a step of this same shape (key, name, instructions, fields, subSteps). They all start with their step, which is done only once each is approved.",
    },
  },
  required: ["key", "name", "instructions", "fields", "subSteps"],
};

const DRAFT = {
  description:
    "Draft a workflow for the person you're chatting with. A workflow is a repeatable process: each item (a case, a request) passes its steps in order, and every step is approved before the next starts. A step has instructions, fields with key, label, optional description and type (text, number, yes_no, date, file, select with options, or group with fields and repeatable: a group holds other fields, a group inside a group holds no group, and a repeatable group is filled as rows), and optional sub-steps. Who works and approves each step is set later. The draft appears in the chat with a button to create it; call again with the whole draft to revise it.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The workflow's name." },
      steps: { type: "array", items: stepSchema, description: "The steps, in order." },
    },
    required: ["name", "steps"],
  },
};

const isText = (value) => typeof value === "string" && value.trim() !== "";

/** Why a field can't be saved, or null: what T45's structure check refuses, said plainly. */
const fieldProblem = (field, depth, where) => {
  if (typeof field !== "object" || field === null) return `${where}: a field must be an object.`;
  const at = `${where}, field "${field.key ?? "?"}"`;
  if (typeof field.key !== "string" || !KEY.test(field.key)) {
    return `${at}: a key is 1 to 64 letters, digits, - or _.`;
  }
  if (!isText(field.label)) return `${at}: it needs a label.`;
  if (field.description !== undefined && typeof field.description !== "string") {
    return `${at}: a description is text.`;
  }
  if (!FIELD_TYPES.includes(field.type))
    return `${at}: its type is one of ${FIELD_TYPES.join(", ")}.`;
  const allowed =
    field.type === "select"
      ? ["key", "label", "description", "type", "options"]
      : field.type === "group"
        ? ["key", "label", "description", "type", "fields", "repeatable"]
        : ["key", "label", "description", "type"];
  if (Object.keys(field).some((key) => !allowed.includes(key))) {
    return `${at}: a field of this type only takes ${allowed.join(", ")}.`;
  }
  if (field.type === "select") {
    const options = field.options;
    if (!Array.isArray(options) || options.length === 0) return `${at}: a select needs options.`;
    if (options.some((option) => !isText(option))) return `${at}: options are a list of texts.`;
    if (new Set(options.map((option) => option.trim())).size !== options.length) {
      return `${at}: its options must differ.`;
    }
  }
  if (field.type !== "group") return null;
  const children = field.fields;
  if (!Array.isArray(children)) return `${at}: fields are a list.`;
  if (typeof field.repeatable !== "boolean") return `${at}: repeatable is true or false.`;
  if (depth >= 2) return `${at}: a group inside a group holds no group.`;
  if (children.length === 0) return `${at}: a group needs fields.`;
  for (const child of children) {
    const problem = fieldProblem(child, depth + 1, at);
    if (problem !== null) return problem;
  }
  return null;
};

/** Why a draft can't be saved, or null; collects every key into `keys` to check they differ. */
const stepProblem = (step, where, keys) => {
  if (typeof step !== "object" || step === null) return `${where}: a step must be an object.`;
  const at = `${where} "${step.key ?? "?"}"`;
  if (typeof step.key !== "string" || !KEY.test(step.key)) {
    return `${at}: a key is 1 to 64 letters, digits, - or _.`;
  }
  if (!isText(step.name)) return `${at}: it needs a name.`;
  if (typeof step.instructions !== "string") return `${at}: instructions are text.`;
  if (!Array.isArray(step.fields)) return `${at}: fields are a list.`;
  if (!Array.isArray(step.subSteps)) return `${at}: subSteps are a list.`;
  keys.push(step.key);
  const collect = (fields) => {
    for (const field of fields) {
      keys.push(field.key);
      if (field.type === "group") collect(field.fields);
    }
  };
  for (const field of step.fields) {
    const problem = fieldProblem(field, 0, at);
    if (problem !== null) return problem;
  }
  collect(step.fields);
  for (const child of step.subSteps) {
    const problem = stepProblem(child, `${at}, sub-step`, keys);
    if (problem !== null) return problem;
  }
  return null;
};

const draft = (args) => {
  if (!isText(args.name)) refuse("The workflow needs a name.");
  if (!Array.isArray(args.steps) || args.steps.length === 0) refuse("Draft at least one step.");
  const keys = [];
  for (const step of args.steps) {
    const problem = stepProblem(step, "Step", keys);
    if (problem !== null) refuse(`${problem} Fix it and draft again.`);
  }
  const repeated = keys.find((key, index) => keys.indexOf(key) !== index);
  if (repeated !== undefined) {
    refuse(`The key "${repeated}" is used twice; every step and field needs its own. Draft again.`);
  }
  return `Drafted "${args.name.trim()}". It shows in the chat with a button to create it; once created, its admins set who works and approves each step, then publish it.`;
};

const tools = [{ name: "draft", ...DRAFT }];

const call = (name, args) => {
  if (name !== "draft") refuse(`${name} is not a tool here.`);
  return draft(args);
};

serve({ name: "workflow-tools", tools, call, failure: "The draft could not be checked." });
