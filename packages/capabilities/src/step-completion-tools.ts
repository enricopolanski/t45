import { rpcTool, serve } from "./mcp-stdio.ts";

serve({
  name: "step-completion-tools",
  tools: [
    rpcTool(
      "mark_done",
      "workflows.markStepDone",
      "Mark the current step done and move the ticket to its next step. The workflow checks that the step is complete and the next step can start.",
      { stepId: process.env.T45_STEP_ID! },
    ),
  ],
  failure: "The step could not be completed.",
});
