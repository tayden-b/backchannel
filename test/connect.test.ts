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
  drive: { enabled: true, docId: null, pollSeconds: 20 },
};

const DOC = "https://docs.google.com/document/d/abc123/edit";

describe("connectInstructions", () => {
  it("returns one entry per caller with tokenized MCP URL", () => {
    const { agents } = connectInstructions(config, {
      publicUrl: "https://abc.trycloudflare.com/",
      docUrl: DOC,
    });
    expect(agents).toHaveLength(2);
    const muse = agents.find((a) => a.name === "muse")!;
    expect(muse.mcpUrl).toBe("https://abc.trycloudflare.com/mcp/muse-token");
  });

  it("instinct text contains the doc URL and ASK instructions", () => {
    const { agents, drive } = connectInstructions(config, {
      publicUrl: "https://x.example.com",
      docUrl: DOC,
    });
    const instinct = agents.find((a) => a.name === "instinct")!;
    expect(instinct.pasteText).toContain(DOC);
    expect(instinct.pasteText).toContain("## ASK instinct");
    expect(instinct.pasteText).toContain("## ANSWER");
    expect(instinct.pasteText).toContain("what is this connection for");
    expect(drive.docUrl).toBe(DOC);
  });

  it("instinct text warns when the doc is not connected", () => {
    const { agents } = connectInstructions(config, {
      publicUrl: "https://x.example.com",
      docUrl: null,
    });
    const instinct = agents.find((a) => a.name === "instinct")!;
    expect(instinct.pasteText).toContain("not connected");
  });

  it("muse text points at spec.md and carries the token", () => {
    const { agents } = connectInstructions(config, {
      publicUrl: "https://x.example.com",
      docUrl: DOC,
    });
    const muse = agents.find((a) => a.name === "muse")!;
    expect(muse.pasteText).toContain("https://x.example.com/spec.md");
    expect(muse.pasteText).toContain("muse-token");
    expect(muse.pasteText).toContain("pending");
    expect(muse.pasteText).toContain("needs_human");
    expect(muse.pasteText).toContain("what is this connection for");
  });
});
