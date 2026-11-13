import { rpcTool, serve } from "./mcp-stdio.ts";

serve({
  name: "progress-reporting",
  tools: [
    rpcTool(
      "report",
      "chats.report",
      "Report briefly what you are doing now. Each call updates the progress shown for your run.",
    ),
  ],
  failure: "Could not report progress.",
});
