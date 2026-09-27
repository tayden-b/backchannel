import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import type { Db, Thread } from "./db.js";
import { askCore } from "./askcore.js";

export function makeRateLimiter(perMinute: number) {
  const hits = new Map<string, number[]>();
  return (caller: string): boolean => {
    const now = Date.now();
    const window = hits.get(caller) ?? [];
    const recent = window.filter((t) => now - t < 60_000);
    if (recent.length >= perMinute) {
      hits.set(caller, recent);
      return false;
    }
    recent.push(now);
    hits.set(caller, recent);
    return true;
  };
}

function text(text: string, extra: Record<string, unknown> = {}, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: extra,
    ...(isError ? { isError: true } : {}),
  };
}

function threadSnapshot(db: Db, thread: Thread) {
  return {
    thread_id: thread.id,
    status: thread.status,
    subject: thread.subject,
    updated_at: thread.updated_at,
    messages: db.getMessages(thread.id),
  };
}

function buildServer(db: Db, config: Config, caller: string, rateOk: () => boolean): McpServer {
  const server = new McpServer({ name: "backchannel", version: "0.1.0" });

  server.registerTool(
    "ask",
    {
      title: "Ask the local knowledge base",
      description:
        "Ask Tayden's local knowledge oracle a question. Creates a new thread, or appends to an existing thread when thread_id is given. " +
        "Waits briefly for an answer. If the result is still 'pending', DO NOT re-ask: call check(thread_id) after ~20 seconds. " +
        "If the status is 'needs_human', a human must answer — check back later.",
      inputSchema: {
        question: z.string().describe("The question to ask the local knowledge base"),
        thread_id: z
          .string()
          .optional()
          .describe("Existing thread id to continue; omit to start a new thread"),
      },
    },
    async ({ question, thread_id }) => {
      if (!rateOk()) {
        return text("rate limited", { error: "rate limited" }, true);
      }
      const result = await askCore(db, config, caller, question, thread_id);
      const extra = { ...result } as Record<string, unknown>;
      if (result.error) return text(result.error, extra, true);
      return text(JSON.stringify(result), extra);
    }
  );

  server.registerTool(
    "check",
    {
      title: "Check a thread",
      description:
        "Return the status and full message history of one of your threads. Use this to poll for an answer after ask() returns 'pending' or 'needs_human'.",
      inputSchema: {
        thread_id: z.string().describe("Thread id returned by ask()"),
      },
    },
    async ({ thread_id }) => {
      if (!rateOk()) {
        return text("rate limited", { error: "rate limited" }, true);
      }
      const thread = db.getThread(thread_id);
      if (!thread || thread.caller !== caller) {
        return text(`unknown thread_id ${thread_id}`, { error: "unknown thread" }, true);
      }
      const snapshot = threadSnapshot(db, thread);
      return text(JSON.stringify(snapshot), snapshot);
    }
  );

  server.registerTool(
    "list_threads",
    {
      title: "List your threads",
      description: "List your own threads (id, subject, status, updated_at), newest first.",
      inputSchema: {
        limit: z.number().int().positive().optional().describe("Max threads to return"),
      },
    },
    async ({ limit }) => {
      if (!rateOk()) {
        return text("rate limited", { error: "rate limited" }, true);
      }
      const threads = db
        .listThreads(caller)
        .slice(0, limit ?? 50)
        .map((t) => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
          updated_at: t.updated_at,
        }));
      return text(JSON.stringify({ threads }), { threads });
    }
  );

  return server;
}

export function mcpRouter(db: Db, config: Config): Router {
  const router = Router();
  const rateOk = makeRateLimiter(config.rateLimit.perCallerPerMinute);

  const tokenToCaller = new Map<string, string>();
  for (const [name, token] of Object.entries(config.callers)) {
    tokenToCaller.set(token, name);
  }

  function authenticate(req: Request, res: Response): string | undefined {
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const token = bearer ?? (req.params.token as string | undefined);
    const caller = token ? tokenToCaller.get(token) : undefined;
    if (!caller) {
      res.status(401).json({ error: "unauthorized" });
      return undefined;
    }
    return caller;
  }

  const handler = async (req: Request, res: Response) => {
    const caller = authenticate(req, res);
    if (!caller) return;
    const server = buildServer(db, config, caller, () => rateOk(caller));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  router.post("/mcp", handler);
  router.post("/mcp/:token", handler);
  router.get("/mcp", handler);
  router.get("/mcp/:token", handler);
  router.delete("/mcp", handler);
  router.delete("/mcp/:token", handler);

  return router;
}
