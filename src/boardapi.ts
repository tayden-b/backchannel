import { Router } from "express";
import type { Request, Response } from "express";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { askCore } from "./askcore.js";
import { makeRateLimiter } from "./mcp.js";

// Authenticated REST surface for callers without MCP support (e.g. Muse's
// connector builder). Same per-caller bearer/path-token auth as /mcp.
export function boardRouter(db: Db, config: Config): Router {
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

  const authed = (fn: (req: Request, res: Response, caller: string) => void | Promise<void>) =>
    async (req: Request, res: Response) => {
      const caller = authenticate(req, res);
      if (!caller) return;
      if (!rateOk(caller)) {
        res.status(429).json({ error: "rate limited" });
        return;
      }
      await fn(req, res, caller);
    };

  router.post(
    ["/api/board/ask", "/api/board/:token/ask"],
    authed(async (req, res, caller) => {
      const question = (req.body?.question ?? "") as string;
      if (!question.trim()) {
        res.status(400).json({ error: "question required" });
        return;
      }
      const result = await askCore(
        db,
        config,
        caller,
        question,
        (req.body?.thread_id as string | undefined) ?? undefined
      );
      res.status(result.error ? 404 : 200).json(result);
    })
  );

  router.get(
    ["/api/board/threads", "/api/board/:token/threads"],
    authed(async (_req, res, caller) => {
      const threads = db
        .listThreads(caller)
        .map((t) => ({ id: t.id, subject: t.subject, status: t.status, updated_at: t.updated_at }));
      res.json({ threads });
    })
  );

  router.get(
    ["/api/board/threads/:id", "/api/board/:token/threads/:id"],
    authed(async (req, res, caller) => {
      const thread = db.getThread(req.params.id);
      if (!thread || thread.caller !== caller) {
        res.status(404).json({ error: "unknown thread" });
        return;
      }
      res.json({ thread: { ...thread, messages: db.getMessages(thread.id) } });
    })
  );

  return router;
}
