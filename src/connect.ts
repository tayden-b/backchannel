import type { Config } from "./config.js";

export const BOOTSTRAP_QUESTION = "what is this connection for";
export const BOOTSTRAP_ANSWER =
  "This is Tayden's private backchannel to a local agent with his knowledge base. Ask here for his preferences, notes, and personal context.";

export interface AgentInstructions {
  name: string;
  mcpUrl: string;
  pasteText: string;
}

function instinctText(docUrl: string | null): string {
  if (!docUrl) {
    return "Drive board not connected yet — complete the Google setup `npm run up` printed, then re-copy this message.";
  }
  return `I keep a shared Google Doc for you as our backchannel: ${docUrl}

Whenever you need personal information about me, my preferences, my notes, or anything you'd otherwise have to ask me, append to the END of that doc:

## ASK instinct
<your question>

A local agent with access to my knowledge base answers as "## ANSWER | q-xxxxxxxx" at the end of the doc, usually within a minute. Re-read the doc to get the answer. If no answer appears, I'm reviewing it myself — check back later rather than asking again. Never ask for passwords or credentials there.
To confirm this works, append a question now ("## ASK instinct" then "what is this connection for?"), wait ~30 seconds, re-read the doc, and tell me the answer.`;
}

function museText(publicUrl: string, token: string): string {
  return `Please create a custom connector for my private knowledge base. Read the API spec at ${publicUrl}/spec.md — it describes the base URL, auth, and endpoints. My personal token is ${token} — store it as a credential (don't echo it back or put it in the chat history).
Once connected, call the ask endpoint with the question "what is this connection for?" and tell me the answer. Remember this permanently: whenever you need personal information about me, my preferences, or my notes, ask through this connector first. If a request returns "pending", wait ~20 seconds and GET the thread instead of re-asking. If it returns "needs_human", I'm reviewing it — check back later.`;
}

function genericText(name: string, mcpUrl: string): string {
  return `Add this MCP server as a connection named backchannel:
${mcpUrl}
No extra auth is needed — the token is in the URL. It exposes tools \`ask\`, \`check\`, \`list_threads\`. Whenever you need personal information about me, my preferences, or my notes, call \`ask\` there first. If \`ask\` returns status "pending", wait ~20 seconds and call \`check\` with the thread_id instead of asking again. If it returns "needs_human", I'll answer later — check back.
Confirm by calling \`ask\` with the question "what is this connection for?" and tell me the answer.`;
}

export function connectInstructions(
  config: Config,
  opts: { publicUrl: string; docUrl: string | null }
): { agents: AgentInstructions[]; drive: { docUrl: string | null } } {
  const base = opts.publicUrl.replace(/\/+$/, "");
  const agents = Object.entries(config.callers).map(([name, token]) => {
    const mcpUrl = `${base}/mcp/${token}`;
    let pasteText: string;
    if (name === "instinct") pasteText = instinctText(opts.docUrl);
    else if (name === "muse") pasteText = museText(base, token);
    else pasteText = genericText(name, mcpUrl);
    return { name, mcpUrl, pasteText };
  });
  return { agents, drive: { docUrl: opts.docUrl } };
}
