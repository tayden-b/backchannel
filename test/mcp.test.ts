import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import http from "node:http";
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

  it("authenticated GET /mcp is handled by the transport (not express 404)", async () => {
    const res = await fetch(`${ctx.base}/mcp`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json, text/event-stream" },
    });
    // Stateless transport may answer 405 or open an SSE stream — either way not 404.
    expect(res.status).not.toBe(404);
    expect([200, 405]).toContain(res.status);
    const unauth = await fetch(`${ctx.base}/mcp`);
    expect(unauth.status).toBe(401);
  });

  it("replying to an answered thread appends a human message and stays answered", async () => {
    const client = await mcpClient(ctx.base);
    const asked = structured(await client.callTool({ name: "ask", arguments: { question: "reply target" } }));
    expect(asked.status).toBe("answered");

    const res = await fetch(`${ctx.base}/api/threads/${asked.thread_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "correction from Tayden" }),
    });
    expect(res.status).toBe(200);

    const checked = structured(
      await client.callTool({ name: "check", arguments: { thread_id: asked.thread_id } })
    );
    expect(checked.status).toBe("answered");
    const msgs = checked.messages as { sender: string; body: string }[];
    expect(msgs.at(-1)?.sender).toBe("human");
    expect(msgs.at(-1)?.body).toBe("correction from Tayden");
    await client.close();
  });

  it("auto-answers the bootstrap question without the responder", async () => {
    const client = await mcpClient(ctx.base);
    const result = await client.callTool({
      name: "ask",
      arguments: { question: "  What is this connection for?! " },
    });
    const sc = structured(result);
    expect(sc.status).toBe("answered");
    expect(String(sc.answer)).toContain("private backchannel");

    const checked = structured(
      await client.callTool({ name: "check", arguments: { thread_id: sc.thread_id } })
    );
    const msgs = checked.messages as { sender: string; body: string }[];
    expect(msgs.at(-1)?.sender).toBe("local");
    expect(msgs.at(-1)?.body).toContain("knowledge base");
    await client.close();
  });

  it("rejects non-localhost Host headers on the UI API", async () => {
    // fetch() won't send a custom Host header; use http.request directly.
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL(`${ctx.base}/api/threads`);
      const req = http.request(
        { hostname: url.hostname, port: url.port, path: url.pathname, headers: { Host: "example.trycloudflare.com" } },
        (r) => {
          let body = "";
          r.on("data", (d) => (body += d));
          r.on("end", () => resolve({ status: r.statusCode ?? 0, body }));
        }
      );
      req.on("error", reject);
      req.end();
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toBe("ui is local-only");

    const ok = await fetch(`${ctx.base}/api/threads`);
    expect(ok.status).toBe(200);
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

describe("responder rerun queue", () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    ctx = await startServer({
      responder: {
        command: `sh -c 'cat >/dev/null; sleep 1; echo ok'`,
        timeoutMs: 15000,
        systemPrompt: "test",
      },
      askTimeoutMs: 10000,
    });
  });
  afterAll(async () => {
    ctx.db.close();
    ctx.server.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it("re-runs the responder when a message arrives mid-run", async () => {
    const client = await mcpClient(ctx.base);
    const first = structured(await client.callTool({ name: "ask", arguments: { question: "q1" } }));
    const threadId = first.thread_id as string;
    expect(first.status).toBe("answered");

    const p2 = client.callTool({ name: "ask", arguments: { question: "q2", thread_id: threadId } });
    await new Promise((r) => setTimeout(r, 200));
    const p3 = client.callTool({ name: "ask", arguments: { question: "q3", thread_id: threadId } });
    await Promise.all([p2, p3]);

    await vi.waitFor(
      () => {
        const msgs = ctx.db.getMessages(threadId);
        // q3 arrives while the q2 run is in flight, so its caller message lands
        // before q2's reply; the queued rerun must still produce a reply after q3.
        const senders = msgs.map((m) => m.sender);
        expect(senders).toEqual(["muse", "local", "muse", "muse", "local", "local"]);
        expect(msgs[3].body).toBe("q3");
        expect(msgs.at(-1)?.sender).toBe("local");
      },
      { timeout: 10000, interval: 100 }
    );

    const checked = structured(await client.callTool({ name: "check", arguments: { thread_id: threadId } }));
    expect(checked.status).toBe("answered");
    await client.close();
  }, 15000);
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
