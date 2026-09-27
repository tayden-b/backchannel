import { Router } from "express";
import type { Request, Response } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { bus, emitThread, runResponder } from "./responder.js";

const INDEX_HTML = readFileSync(
  fileURLToPath(new URL("../public/index.html", import.meta.url)),
  "utf8"
);

function threadWithMessages(db: Db, threadId: string) {
  const thread = db.getThread(threadId);
  if (!thread) return undefined;
  return { ...thread, messages: db.getMessages(threadId) };
}

export function uiRouter(db: Db, config: Config): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.type("html").send(INDEX_HTML);
  });

  router.get("/api/threads", (_req, res) => {
    const threads = db
      .listThreads()
      .map((t) => ({ ...t, messages: db.getMessages(t.id) }));
    res.json({ threads });
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
