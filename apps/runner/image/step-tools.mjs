#!/usr/bin/env node
// The step tools inside a chat's VM: a stdio MCP server, `step` to OpenCode, that admins give the
// agents that work steps. T45 reads each receipt, validates it and applies it to the step.
// An invalid write ends the task and reports the error on the step. An attach is a snapshot
// of the file under .t45/attached in the working
// folder, which T45 reads by the name the reply gives.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { refuse, serve } from "./mcp-stdio.mjs";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const WORK = process.env.T45_WORK_DIR ?? "/work";

const APPLIED =
  "T45 validates and applies the call. An invalid write ends your run and reports the error to the responsible person.";

const TOOLS = {
  set_field: {
    description:
      "Fill one of the step's fields by its key in the step's JSON in your first message: text and dates (YYYY-MM-DD) as strings, numbers as numbers, yes/no as booleans, selects as one of the field's options; null clears it. A field inside a group has a dotted key. A repeatable group's value is its row ids in order: add a row by setting the group to its ids plus a new one (letters, digits, - and _), then fill that row's fields as group.rowId.field.",
    inputSchema: {
      type: "object",
      properties: { fieldKey: { type: "string" }, value: {} },
      required: ["fieldKey", "value"],
    },
  },
  comment: {
    description:
      "Post a comment on the step assigned to you: progress, a question for the people on it, or your result.",
    inputSchema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
  },
  attach: {
    description:
      "Attach a file from your working folder to the step assigned to you, by its path relative to that folder. Give fieldKey to make it the value of a file field.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, fieldKey: { type: "string" } },
      required: ["path"],
    },
  },
  done: {
    description:
      "Signal that your contribution is finished, even if the shared step still has missing fields or unfinished sub-steps. Explain any gaps with comment first. This ends your run and releases your sandbox; T45 checks step completion separately. Stop after calling it.",
    inputSchema: { type: "object", properties: {} },
  },
  give_up: {
    description:
      "Fail this task when you cannot finish its contribution. Fill what you can first, then explain what is missing and why. The responsible person is notified; other tasks continue. Stop after calling it.",
    inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  },
};

const handlers = {
  set_field: ({ fieldKey }) => {
    if (typeof fieldKey !== "string") refuse("Give the field's key.");
  },
  comment: ({ body }) => {
    if (typeof body !== "string" || !body.trim()) refuse("A comment needs a body.");
  },
  attach: ({ path }) => {
    if (typeof path !== "string") refuse("Give the file's path.");
    let target;
    try {
      target = NodeFS.realpathSync(NodePath.resolve(WORK, path));
    } catch {
      refuse(`No file at ${path}.`);
    }
    if (!target.startsWith(`${NodeFS.realpathSync(WORK)}/`))
      refuse("The file must be in your working folder.");
    const info = NodeFS.statSync(target);
    if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES)
      refuse("Attach a file of at most 25 MB.");
    // A random name can't meet an earlier snapshot, even after the VM restarts.
    const file = `.t45/attached/${NodeCrypto.randomUUID()}`;
    NodeFS.mkdirSync(`${WORK}/.t45/attached`, { recursive: true });
    NodeFS.copyFileSync(target, `${WORK}/${file}`);
    return { name: NodePath.basename(target), file };
  },
  done: () => {},
  give_up: ({ note }) => {
    if (typeof note !== "string" || !note.trim()) refuse("Say what is missing and why.");
  },
};

const tools = Object.entries(TOOLS).map(([name, tool]) => ({
  name,
  description: `${tool.description} ${APPLIED}`,
  inputSchema: tool.inputSchema,
}));

const call = (name, args) => {
  if (!Object.hasOwn(handlers, name)) refuse(`${name} is not a tool here.`);
  return JSON.stringify({ ok: true, ...handlers[name](args) }, null, 2);
};

serve({ name: "step-tools", tools, call, failure: "The step tool failed." });
