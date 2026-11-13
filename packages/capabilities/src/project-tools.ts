import { rpcTool, serve } from "./mcp-stdio.ts";

const project = { projectId: process.env.T45_PROJECT_ID! };
serve({
  name: "project-tools",
  tools: [
    rpcTool(
      "get_workflow",
      "workflows.getProjectWorkflow",
      "Read this project and its current workflow, including step and field IDs.",
      project,
    ),
    rpcTool(
      "list_tickets",
      "workflows.listTickets",
      "List up to 100 visible tickets, newest first; optionally search titles.",
      project,
    ),
    rpcTool(
      "get_ticket",
      "workflows.getTicket",
      "Read a visible ticket, including its steps, values and IDs.",
    ),
    rpcTool(
      "create_ticket",
      "workflows.startTicket",
      "Start a ticket using the member's permissions.",
      project,
    ),
    rpcTool(
      "set_field",
      "workflows.setStepField",
      "Set a field on an actionable step using the member's permissions.",
    ),
  ],
  failure: "The project operation could not complete.",
});
