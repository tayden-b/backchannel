import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { createApp } from "../src/index.js";

const MUSE = "muse-token";
const OTHER = "other-token";

function writeConfig(dir: string) {
  writeFileSync(
    path.join(dir, "backchannel.config.json"),
    JSON.stringify({
      port: 0,
      dataDir: "./data",
      callers: { muse: MUSE, instinct: OTHER },
      askTimeoutMs: 8000,
      responder: {
        command: `sh -c 'cat >/dev/null; echo "the answer is 42"'`,
        timeoutMs: 10000,
        systemPrompt: "test oracle",
      },
      rateLimit: { perCallerPerMinute: 30 },
    })
  );
}

describe("board REST api", () => {
  let ctx: { dir: string; server: Server; base: string; db: { close(): void } };
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "backchannel-api-"));
    writeConfig(dir);
    const { app, db } = createApp(dir);
    const server: Server = await new Promise((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    const port = (server.address() as { port: number }).port;
    ctx = { dir, server, base: `http://127.0.0.1:${port}`, db };
  });
  afterAll(async () => {
    ctx.db.close();
    ctx.server.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  const ask = (body: unknown, token = MUSE) =>
    fetch(`${ctx.base}/api/board/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  it("rejects missing/wrong token with 401", async () => {
    expect((await ask({ question: "hi" }, "nope")).status).toBe(401);
    const unauth = await fetch(`${ctx.base}/api/board/threads`);
    expect(unauth.status).toBe(401);
  });

  it("ask → answered, then check returns messages", async () => {
    const res = await ask({ question: "board me" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; thread_id: string; answer?: string };
    expect(data.status).toBe("answered");
    expect(data.answer).toContain("42");

    const detail = await fetch(`${ctx.base}/api/board/threads/${data.thread_id}`, {
      headers: { Authorization: `Bearer ${MUSE}` },
    });
    const { thread } = (await detail.json()) as { thread: { status: string; messages: unknown[] } };
    expect(thread.status).toBe("answered");
    expect(thread.messages.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts token in path", async () => {
    const res = await fetch(`${ctx.base}/api/board/${MUSE}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "path token" }),
    });
    expect(res.status).toBe(200);
  });

  it("scopes threads per caller", async () => {
    const res = await fetch(`${ctx.base}/api/board/threads`, {
      headers: { Authorization: `Bearer ${OTHER}` },
    });
    const { threads } = (await res.json()) as { threads: { subject: string }[] };
    expect(threads.find((t) => t.subject.includes("board me"))).toBeUndefined();

    // and can't read muse's thread directly
    const list = await (await fetch(`${ctx.base}/api/board/threads`, {
      headers: { Authorization: `Bearer ${MUSE}` },
    })).json() as { threads: { id: string }[] };
    const museThread = list.threads[0].id;
    const stolen = await fetch(`${ctx.base}/api/board/threads/${museThread}`, {
      headers: { Authorization: `Bearer ${OTHER}` },
    });
    expect(stolen.status).toBe(404);
  });

  it("spec.md is public and lists the endpoints", async () => {
    const res = await fetch(`${ctx.base}/spec.md`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("/api/board/ask");
    expect(body).toContain("Bearer");
    expect(body).not.toContain(MUSE);
  });
});
