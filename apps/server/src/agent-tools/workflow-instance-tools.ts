import { workflowTool, serve } from "./mcp-stdio.ts";

const workflow = { workflowId: process.env.T45_WORKFLOW_ID! };
serve({
  name: "workflow-instance-tools",
  tools: [
    workflowTool(
      "get_workflow",
      "workflows.getWorkflow",
      "Read this workflow and its current blueprint, including step and field IDs.",
      workflow,
    ),
    workflowTool(
      "list_tickets",
      "workflows.listTickets",
      "List up to 100 visible tickets, newest first; optionally search titles.",
      workflow,
    ),
    workflowTool(
      "get_ticket",
      "workflows.getTicket",
      "Read a visible ticket, including its steps, values and IDs.",
    ),
    workflowTool(
      "create_ticket",
      "workflows.startTicket",
      "Start a ticket using the member's permissions.",
      workflow,
    ),
    workflowTool(
      "set_field",
      "workflows.setStepField",
      "Set a field on an actionable step using the member's permissions.",
    ),
  ],
  failure: "The workflow operation could not complete.",
});
