import { describe, it, expect } from "vitest";
import { connectInstructions } from "../src/connect.js";
import type { Config } from "../src/config.js";

const config: Config = {
  port: 7777,
  dataDir: "./data",
  callers: { muse: "muse-token", instinct: "instinct-token" },
  askTimeoutMs: 25000,
  responder: { command: "echo hi", cwd: null, timeoutMs: 90000, systemPrompt: "" },
  rateLimit: { perCallerPerMinute: 10 },
};

describe("connectInstructions", () => {
  it("returns one entry per caller with tokenized MCP URL", () => {
    const { agents } = connectInstructions(config, "https://abc.trycloudflare.com/");
    expect(agents).toHaveLength(2);
    const muse = agents.find((a) => a.name === "muse")!;
    const instinct = agents.find((a) => a.name === "instinct")!;
    expect(muse.mcpUrl).toBe("https://abc.trycloudflare.com/mcp/muse-token");
    expect(instinct.mcpUrl).toBe("https://abc.trycloudflare.com/mcp/instinct-token");
  });

  it("paste text contains the URL, tool names, and bootstrap question", () => {
    const { agents } = connectInstructions(config, "https://x.example.com");
    for (const a of agents) {
      expect(a.pasteText).toContain(a.mcpUrl);
      expect(a.pasteText).toContain("`ask`");
      expect(a.pasteText).toContain("what is this connection for");
    }
  });

  it("instinct gets the 'Add this MCP server' first line", () => {
    const { agents } = connectInstructions(config, "https://x.example.com");
    const instinct = agents.find((a) => a.name === "instinct")!;
    const muse = agents.find((a) => a.name === "muse")!;
    expect(instinct.pasteText.startsWith("Add this MCP server as a connection named backchannel:")).toBe(true);
    expect(muse.pasteText.startsWith("Please add a custom connector")).toBe(true);
  });
});
