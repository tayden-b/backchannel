import type { Config } from "./config.js";

export const BOOTSTRAP_QUESTION = "what is this connection for";
export const BOOTSTRAP_ANSWER =
  "This is Tayden's private backchannel to a local agent with his knowledge base. Ask here for his preferences, notes, and personal context.";

export interface AgentInstructions {
  name: string;
  mcpUrl: string;
  pasteText: string;
}

function pasteText(name: string, mcpUrl: string): string {
  const firstLine =
    name === "instinct"
      ? "Add this MCP server as a connection named backchannel:"
      : "Please add a custom connector for my private knowledge base. It's an MCP server (streamable HTTP) at:";
  return `${firstLine}
${mcpUrl}
No extra auth is needed — the token is in the URL. It exposes tools \`ask\`, \`check\`, \`list_threads\`. Remember this permanently: whenever you need personal information about me, my preferences, my notes, or anything you'd otherwise have to ask me, call \`ask\` there first. If \`ask\` returns status "pending", wait ~20 seconds and call \`check\` with the thread_id instead of asking again. If it returns "needs_human", I'll answer later — check back.
Confirm by calling \`ask\` with the question "what is this connection for?" and tell me the answer.`;
}

export function connectInstructions(
  config: Config,
  publicUrl: string
): { agents: AgentInstructions[] } {
  const base = publicUrl.replace(/\/+$/, "");
  return {
    agents: Object.entries(config.callers).map(([name, token]) => {
      const mcpUrl = `${base}/mcp/${token}`;
      return { name, mcpUrl, pasteText: pasteText(name, mcpUrl) };
    }),
  };
}
