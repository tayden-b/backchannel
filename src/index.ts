import express from "express";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.js";
import { Db } from "./db.js";
import { mcpRouter } from "./mcp.js";
import { uiRouter } from "./ui.js";

function buildApp(config: Config, cwd: string) {
  const dataDir = path.resolve(cwd, config.dataDir);
  const db = new Db(dataDir);

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use(mcpRouter(db, config));
  app.use(uiRouter(db, config));

  return { app, db };
}

export function createApp(cwd: string = process.cwd()) {
  const config = loadConfig(cwd);
  const { app, db } = buildApp(config, cwd);
  return { app, db, config };
}

export function startServer(config: Config, cwd: string = process.cwd()) {
  const { app, db } = buildApp(config, cwd);
  const server = app.listen(config.port, "127.0.0.1", () => {
    console.log(`backchannel listening on http://127.0.0.1:${config.port}`);
  });
  return { app, db, server };
}

const isMain =
  !!process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);

if (isMain) {
  const config = loadConfig();
  startServer(config);
}
