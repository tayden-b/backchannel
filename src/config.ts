import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

export interface RateLimitConfig {
  perCallerPerMinute: number;
}

export interface ResponderConfig {
  command: string | null;
  timeoutMs: number;
  systemPrompt: string;
}

export interface Config {
  port: number;
  dataDir: string;
  callers: Record<string, string>;
  askTimeoutMs: number;
  responder: ResponderConfig;
  rateLimit: RateLimitConfig;
}

const CONFIG_FILE = "backchannel.config.json";
const EXAMPLE_FILE = "backchannel.config.example.json";

function randomToken(): string {
  return randomBytes(24).toString("base64url");
}

export function loadConfig(cwd: string = process.cwd()): Config {
  const configPath = path.join(cwd, CONFIG_FILE);
  const examplePath = path.join(cwd, EXAMPLE_FILE);

  if (!existsSync(configPath)) {
    copyFileSync(examplePath, configPath);
    console.log(`created ${CONFIG_FILE} from ${EXAMPLE_FILE}`);
  }

  const raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<Config>;

  const callers: Record<string, string> = {};
  for (const [name, token] of Object.entries(raw.callers ?? {})) {
    if (token && token !== "REPLACE_WITH_RANDOM_TOKEN") callers[name] = token;
  }
  if (Object.keys(callers).length === 0) {
    callers.muse = randomToken();
    callers.instinct = randomToken();
    raw.callers = callers;
    writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");
    console.log("generated caller tokens (also written to backchannel.config.json):");
    for (const [name, token] of Object.entries(callers)) {
      console.log(`  ${name}: ${token}`);
    }
  }

  const config: Config = {
    port: Number(process.env.BACKCHANNEL_PORT ?? raw.port ?? 7777),
    dataDir: process.env.BACKCHANNEL_DATA_DIR ?? raw.dataDir ?? "./data",
    callers,
    askTimeoutMs: Number(raw.askTimeoutMs ?? 25000),
    responder: {
      command: raw.responder?.command ?? null,
      timeoutMs: Number(raw.responder?.timeoutMs ?? 90000),
      systemPrompt: raw.responder?.systemPrompt ?? "",
    },
    rateLimit: {
      perCallerPerMinute: Number(raw.rateLimit?.perCallerPerMinute ?? 10),
    },
  };

  return config;
}
