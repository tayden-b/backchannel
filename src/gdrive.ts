import http from "node:http";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";

export class DriveError extends Error {
  kind: "unauth" | "api";
  constructor(kind: "unauth" | "api", message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface GApi {
  exportText(docId: string): Promise<string>;
  appendText(docId: string, text: string): Promise<void>;
  createDoc(name: string): Promise<string>;
  docUrl(docId: string): string;
}

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export const GCP_SETUP_STEPS = [
  "console.cloud.google.com → create a project (any name)",
  "APIs & Services → Library → enable \"Google Drive API\"",
  "OAuth consent screen → External → app name + your email → Save",
  "Audience → Test users → add your Gmail",
  "Credentials → Create Credentials → OAuth client ID → Application type: Desktop app → Download JSON",
  "Save it as data/client_secret.json in this repo, then re-run `npm run up`",
];

function installedCredentials(secretPath: string): {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
} {
  const raw = JSON.parse(readFileSync(secretPath, "utf8"));
  const c = raw.installed ?? raw.web ?? raw;
  if (!c.client_id || !c.client_secret) throw new DriveError("unauth", "client_secret.json missing client_id/client_secret");
  return { client_id: c.client_id, client_secret: c.client_secret, redirect_uri: "http://127.0.0.1" };
}

async function waitForCode(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const code = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h3>backchannel authorized — you can close this tab.</h3>");
      srv.close();
      if (code) resolve(code);
      else reject(new DriveError("unauth", `oauth error: ${err ?? "no code"}`));
    });
    srv.listen(port, "127.0.0.1");
    setTimeout(() => {
      srv.close();
      reject(new DriveError("unauth", "oauth timed out after 5 minutes"));
    }, 300_000).unref();
  });
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  execFile(cmd, [url], () => {});
}

export async function ensureAuthed(
  config: Config,
  dataDir: string,
  log: (line: string) => void = console.log
): Promise<GApi | null> {
  const secretPath = path.join(dataDir, "client_secret.json");
  const tokenPath = path.join(dataDir, "token.json");
  if (!existsSync(secretPath)) {
    log("\nTo connect the Google Doc board (needed for Instinct):");
    GCP_SETUP_STEPS.forEach((s, i) => log(` ${i + 1}. ${s}`));
    return null;
  }

  const { google } = await import("googleapis");
  const creds = installedCredentials(secretPath);
  const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret);

  if (existsSync(tokenPath)) {
    try {
      oauth2.setCredentials(JSON.parse(readFileSync(tokenPath, "utf8")));
      // force a refresh check
      await oauth2.getAccessToken();
    } catch (err) {
      log(`stored Google token invalid (${String(err).slice(0, 120)}) — re-authenticating`);
    }
  }

  if (!oauth2.credentials.access_token && !oauth2.credentials.refresh_token) {
    // loopback flow on an ephemeral port; tell Google to redirect to it
    const probe = http.createServer().listen(0, "127.0.0.1");
    const port = (probe.address() as { port: number }).port;
    probe.close();
    const oauth2Loopback = new google.auth.OAuth2(
      creds.client_id,
      creds.client_secret,
      `http://127.0.0.1:${port}`
    );
    const authUrl = oauth2Loopback.generateAuthUrl({ access_type: "offline", scope: [DRIVE_SCOPE], prompt: "consent" });
    log("Google sign-in: opening browser…");
    openBrowser(authUrl);
    const code = await waitForCode(port);
    const { tokens } = await oauth2Loopback.getToken(code);
    oauth2.setCredentials(tokens);
    writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
    try { chmodSync(tokenPath, 0o600); } catch { /* best effort */ }
    log("Google authorized (token saved to data/token.json)");
  }

  const drive = google.drive({ version: "v3", auth: oauth2 });
  const docs = google.docs({ version: "v1", auth: oauth2 });

  const wrap = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (err) {
      const msg = String(err);
      if (/401|invalid_grant|unauthorized/i.test(msg)) throw new DriveError("unauth", msg);
      throw new DriveError("api", msg.slice(0, 300));
    }
  };

  return {
    docUrl: (docId: string) => `https://docs.google.com/document/d/${docId}/edit`,
    createDoc: async (name) =>
      String(
        (
          await wrap(
            drive.files.create({
              requestBody: { name, mimeType: "application/vnd.google-apps.document" },
              fields: "id",
            })
          )
        ).data.id
      ),
    exportText: async (docId) =>
      String((await wrap(drive.files.export({ fileId: docId, mimeType: "text/plain" }))).data),
    appendText: async (docId, text) => {
      const doc = await wrap(docs.documents.get({ documentId: docId }));
      const body = doc.data.body;
      const endIndex =
        Math.max(...(body?.content ?? []).map((e) => e.endIndex ?? 1), 1) - 1;
      await wrap(
        docs.documents.batchUpdate({
          documentId: docId,
          requestBody: {
            requests: [{ insertText: { location: { index: endIndex }, text: `\n${text}` } }],
          },
        })
      );
    },
  };
}

export async function resolveDoc(
  gapi: GApi,
  config: Config,
  dataDir: string,
  log: (line: string) => void = console.log
): Promise<string> {
  const idFile = path.join(dataDir, "drive_doc_id.txt");
  const configured = config.drive.docId ?? (existsSync(idFile) ? readFileSync(idFile, "utf8").trim() : null);
  if (configured) {
    try {
      await gapi.exportText(configured);
      return configured;
    } catch (err) {
      throw new DriveError("api", `cannot open doc ${configured}: ${String(err).slice(0, 200)} — share it with the Google account you authorized, or clear drive.docId`);
    }
  }
  const docId = await gapi.createDoc("Backchannel");
  writeFileSync(idFile, docId);
  log(`created Backchannel doc: ${gapi.docUrl(docId)}`);
  return docId;
}
