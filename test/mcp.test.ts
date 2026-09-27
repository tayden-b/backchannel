import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/index.js";

const TOKEN = "test-token-123";

function writeConfig(dir: string, overrides: Record<string, unknown> = {}) {
  const config = {
    port: 0,
    dataDir: "./data",
    callers: { muse: TOKEN },
    askTimeoutMs: 8000,
    responder: {
      command: `sh -c 'cat >/dev/null; echo "the answer is 42"'`,
      timeoutMs: 10000,
      systemPrompt: "test oracle",
    },
    rateLimit: { perCallerPerMinute: 10 },
    ...overrides,
  };
  writeFileSync(path.join(dir, "backchannel.config.json"), JSON.stringify(config));
  return config;
}

async function startServer(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "backchannel-it-"));
  writeConfig(dir, overrides);
  const { app, db, config } = createApp(dir);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  return { dir, server, db, config, base: `http://127.0.0.1:${port}` };
}

async function mcpClient(base: string, token = TOKEN) {
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

describe("mcp flow", () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    ctx = await startServer();
  });
  afterAll(async () => {
    ctx.db.close();
    ctx.server.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it("responds to initialize over HTTP", async () => {
    const client = await mcpClient(ctx.base);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["ask", "check", "list_threads"]);
    await client.close();
  });

  it("rejects a wrong token with 401", async () => {
    const res = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts a token in the path", async () => {
    const client = new Client({ name: "t", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${ctx.base}/mcp/${TOKEN}`));
    await client.connect(transport);
    await client.close();
  });

  it("ask returns an answered result", async () => {
    const client = await mcpClient(ctx.base);
    const result = await client.callTool({ name: "ask", arguments: { question: "what is the answer?" } });
    const sc = structured(result);
    expect(sc.status).toBe("answered");
    expect(String(sc.answer)).toContain("42");
    expect(sc.thread_id).toBeTypeOf("string");
    await client.close();
  });

  it("check returns messages for own thread, 404-ish for others", async () => {
    const client = await mcpClient(ctx.base);
    const asked = structured(await client.callTool({ name: "ask", arguments: { question: "check me" } }));
    const checked = structured(
      await client.callTool({ name: "check", arguments: { thread_id: asked.thread_id } })
    );
    expect(checked.status).toBe("answered");
    expect((checked.messages as unknown[]).length).toBeGreaterThanOrEqual(2);

    const other = await client.callTool({ name: "check", arguments: { thread_id: "nonexist" } });
    expect((other as { isError?: boolean }).isError).toBe(true);
    await client.close();
  });

  it("list_threads returns only the caller's threads", async () => {
    const client = await mcpClient(ctx.base);
    const listed = structured(await client.callTool({ name: "list_threads", arguments: {} }));
    const threads = listed.threads as { subject: string }[];
    expect(threads.length).toBeGreaterThanOrEqual(2);
    await client.close();
  });
});

describe("needs_human flow", () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    ctx = await startServer({
      responder: {
        command: `sh -c 'cat >/dev/null; echo NEEDS_HUMAN'`,
        timeoutMs: 10000,
        systemPrompt: "test",
      },
    });
  });
  afterAll(async () => {
    ctx.db.close();
    ctx.server.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it("needs_human then human reply flips to answered", async () => {
    const client = await mcpClient(ctx.base);
    const asked = structured(await client.callTool({ name: "ask", arguments: { question: "secret stuff?" } }));
    expect(asked.status).toBe("needs_human");
    expect(String(asked.hint)).toContain("Tayden");

    const res = await fetch(`${ctx.base}/api/threads/${asked.thread_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "yes, but only on tuesdays" }),
    });
    expect(res.status).toBe(200);

    const checked = structured(
      await client.callTool({ name: "check", arguments: { thread_id: asked.thread_id } })
    );
    expect(checked.status).toBe("answered");
    const msgs = checked.messages as { sender: string; body: string }[];
    expect(msgs.at(-1)?.sender).toBe("human");
    await client.close();
  });
});

describe("rate limit", () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    ctx = await startServer({ rateLimit: { perCallerPerMinute: 2 } });
  });
  afterAll(async () => {
    ctx.db.close();
    ctx.server.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it("errors after the per-minute limit", async () => {
    const client = await mcpClient(ctx.base);
    await client.callTool({ name: "list_threads", arguments: {} });
    await client.callTool({ name: "list_threads", arguments: {} });
    const third = await client.callTool({ name: "list_threads", arguments: {} });
    expect((third as { isError?: boolean }).isError).toBe(true);
    expect((third as { content: { text: string }[] }).content[0].text).toBe("rate limited");
    await client.close();
  });
});
