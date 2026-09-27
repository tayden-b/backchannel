import { Router } from "express";
import type { Request, Response } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { bus, emitThread, runResponder } from "./responder.js";
import { connectInstructions } from "./connect.js";
import { state } from "./state.js";

const INDEX_HTML = readFileSync(
  fileURLToPath(new URL("../public/index.html", import.meta.url)),
  "utf8"
);

function threadWithMessages(db: Db, threadId: string) {
  const thread = db.getThread(threadId);
  if (!thread) return undefined;
  return { ...thread, messages: db.getMessages(threadId) };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function uiRouter(db: Db, config: Config): Router {
  const router = Router();

  // The tunnel proxies every path; the UI must stay local-only.
  router.use((req, res, next) => {
    const raw = (req.headers.host ?? "").toLowerCase();
    const host = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.split(":")[0];
    const bare = host.replace(/^\[|\]$/g, "");
    if (!LOCAL_HOSTS.has(host) && !LOCAL_HOSTS.has(bare)) {
      res.status(403).json({ error: "ui is local-only" });
      return;
    }
    next();
  });

  router.get("/", (_req, res) => {
    res.type("html").send(INDEX_HTML);
  });

  router.get("/api/threads", (_req, res) => {
    const threads = db
      .listThreads()
      .map((t) => ({ ...t, messages: db.getMessages(t.id) }));
    res.json({ threads });
  });

  router.get("/api/connect", (_req, res) => {
    if (!state.publicUrl) {
      res.json({ publicUrl: null, tunnelMode: null, agents: [], drive: state.drive });
      return;
    }
    res.json({
      publicUrl: state.publicUrl,
      tunnelMode: state.tunnelMode,
      ...connectInstructions(config, { publicUrl: state.publicUrl, docUrl: state.drive.docUrl }),
      drive: state.drive,
    });
  });

  router.get("/api/events", (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const onThread = (thread: { id: string }) => {
      const full = threadWithMessages(db, thread.id);
      if (full) res.write(`data: ${JSON.stringify({ type: "thread", thread: full })}\n\n`);
    };
    bus.on("thread", onThread);
    req.on("close", () => bus.removeListener("thread", onThread));
  });

  router.post("/api/threads/:id/reply", (req: Request, res: Response) => {
    const body = (req.body?.body ?? "") as string;
    if (!body.trim()) {
      res.status(400).json({ error: "body required" });
      return;
    }
    const thread = db.getThread(req.params.id);
    if (!thread) {
      res.status(404).json({ error: "not found" });
      return;
    }
    db.addMessage(thread.id, "human", body);
    const updated = db.setStatus(thread.id, "answered")!;
    emitThread(updated);
    res.json({ thread: threadWithMessages(db, thread.id) });
  });

  router.post("/api/threads/:id/retry", (req: Request, res: Response) => {
    const thread = db.getThread(req.params.id);
    if (!thread) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const updated = db.setStatus(thread.id, "pending")!;
    emitThread(updated);
    void runResponder(db, config, thread.id);
    res.json({ thread: threadWithMessages(db, thread.id) });
  });

  return router;
}
