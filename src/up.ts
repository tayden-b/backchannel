import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { loadConfig } from "./config.js";
import { startServer } from "./index.js";
import { connectInstructions } from "./connect.js";
import { setPublicUrl } from "./state.js";

function onPath(bin: string): boolean {
  const r = spawnSync("sh", ["-c", `command -v "$1"`, "sh", bin], { stdio: "pipe" });
  return r.status === 0 && r.stdout.toString().trim().length > 0;
}

function preflight(config: ReturnType<typeof loadConfig>): void {
  if (config.responder.command) {
    const bin = config.responder.command.trim().split(/\s+/)[0];
    if (!onPath(bin)) {
      console.log(`warning: ${bin} CLI not found — running in manual mode: every question waits for you in the UI`);
      config.responder.command = null;
    }
  }
  if (config.responder.cwd && !existsSync(config.responder.cwd)) {
    console.log(`warning: responder cwd ${config.responder.cwd} does not exist — using ${os.homedir()}`);
    config.responder.cwd = os.homedir();
  }
}

function tailscaleFunnel(port: number): { url: string; mode: string } | null {
  if (!onPath("tailscale")) return null;
  const status = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8" });
  if (status.status !== 0) return null;
  try {
    const parsed = JSON.parse(status.stdout) as { BackendState?: string };
    if (parsed.BackendState !== "Running") return null;
  } catch {
    return null;
  }

  const up = spawnSync("tailscale", ["funnel", "--bg", String(port)], { encoding: "utf8" });
  if (up.status !== 0) {
    console.log(`warning: tailscale funnel failed: ${(up.stderr || "").slice(0, 200)}`);
    return null;
  }

  const json = spawnSync("tailscale", ["funnel", "status", "--json"], { encoding: "utf8" });
  try {
    const parsed = JSON.parse(json.stdout) as {
      Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
    };
    for (const [host, site] of Object.entries(parsed.Web ?? {})) {
      for (const handler of Object.values(site.Handlers ?? {})) {
        if (handler.Proxy?.includes(`:${port}`)) {
          return { url: `https://${host}`, mode: "Tailscale Funnel (stable URL)" };
        }
      }
    }
  } catch {
    /* fall through to text parsing */
  }
  const text = spawnSync("tailscale", ["funnel", "status"], { encoding: "utf8" }).stdout ?? "";
  const match = text.match(/https:\/\/[^\s"]+/);
  if (match) return { url: match[0], mode: "Tailscale Funnel (stable URL)" };
  return null;
}

function cloudflareTunnel(port: number): Promise<{ url: string; mode: string; child: ChildProcess } | null> {
  return new Promise((resolve) => {
    if (!onPath("cloudflared")) {
      resolve(null);
      return;
    }
    const child = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        clearTimeout(timer);
        resolve({ url: m[0], mode: "Cloudflare quick tunnel (URL changes on restart)", child });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => resolve(null), 30_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function main(): Promise<void> {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) {
    console.error("Install Node 24+ (https://nodejs.org)");
    process.exit(1);
  }

  const noTunnel = process.argv.includes("--no-tunnel");
  const envUrl = process.env.BACKCHANNEL_PUBLIC_URL;

  const config = loadConfig();
  preflight(config);
  const { server } = startServer(config);
  const localUrl = `http://127.0.0.1:${config.port}`;

  let tunnel: { url: string; mode: string; child?: ChildProcess } | null = null;
  if (envUrl) {
    tunnel = { url: envUrl.replace(/\/+$/, ""), mode: "BACKCHANNEL_PUBLIC_URL" };
  } else if (!noTunnel) {
    tunnel = tailscaleFunnel(config.port) ?? (await cloudflareTunnel(config.port));
    if (!tunnel) {
      console.log("no tunnel available. Install one of:");
      console.log("  Tailscale (stable URL): https://tailscale.com/download");
      console.log("  cloudflared (quick tunnel): brew install cloudflared  |  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
    }
  }

  setPublicUrl(tunnel?.url ?? localUrl, tunnel?.mode ?? "local only (no tunnel)");
  const publicUrl = tunnel?.url ?? localUrl;
  const mode = tunnel?.mode ?? "local only — not reachable by cloud agents";

  console.log("\nbackchannel is up");
  console.log(`  UI:  ${localUrl}`);
  console.log(`  MCP: ${publicUrl}/mcp   (${mode})`);

  const { agents } = connectInstructions(config, publicUrl);
  for (const agent of agents) {
    const label = agent.name.toUpperCase();
    console.log(`\n── Paste this to ${label} ──${"─".repeat(Math.max(0, 40 - label.length))}`);
    console.log(agent.pasteText);
  }
  console.log("");

  const shutdown = () => {
    tunnel?.child?.kill("SIGTERM");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
