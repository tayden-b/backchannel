import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Db } from "../src/db.js";
import { startDocSync } from "../src/dsync.js";
import type { Config } from "../src/config.js";
import type { GApi } from "../src/gdrive.js";

let dir: string;
let db: Db;
let config: Config;

function fakeConfig(command: string | null): Config {
  return {
    port: 0,
    dataDir: dir,
    callers: {},
    askTimeoutMs: 100,
    responder: { command, cwd: null, timeoutMs: 5000, systemPrompt: "" },
    rateLimit: { perCallerPerMinute: 100 },
    drive: { enabled: true, docId: "doc1", pollSeconds: 3600 },
  };
}

function fakeGapi(doc: { text: string; appended: string[] }): GApi {
  return {
    docUrl: (id) => `https://docs/${id}`,
    exportText: async () => doc.text,
    appendText: async (_id, t) => {
      doc.appended.push(t);
      doc.text += "\n" + t;
    },
    createDoc: async () => "newdoc",
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "bc-dsync-"));
  db = new Db(dir);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("dsync", () => {
  it("ingests an ASK, runs responder, writes the answer back once", async () => {
    config = fakeConfig(`sh -c 'cat >/dev/null; echo "oat milk lattes"'`);
    const doc = { text: "## ASK instinct\nwhat coffee?", appended: [] as string[] };
    const sync = startDocSync(db, config, fakeGapi(doc), "doc1", dir, () => {}, {
      autoStart: false,
    });

    await sync.pollOnce();
    const threads = db.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0].caller).toBe("doc:instinct");
    expect(threads[0].status).toBe("pending");

    // let the responder finish, then sync the answer
    await new Promise((r) => setTimeout(r, 300));
    await sync.pollOnce();
    expect(db.getThread(threads[0].id)!.status).toBe("answered");
    expect(doc.appended).toHaveLength(1);
    expect(doc.appended[0]).toMatch(/## ANSWER \| q-[0-9a-f]{8}\noat milk lattes/);

    // subsequent polls do not re-append
    await sync.pollOnce();
    expect(doc.appended).toHaveLength(1);
  });

  it("does not run the responder for already-answered asks", async () => {
    config = fakeConfig(`sh -c 'cat >/dev/null; echo "SHOULD NOT RUN"'`);
    const doc = {
      text: "## ASK instinct\nq?\n## ANSWER | q-x\nalready handled",
      appended: [] as string[],
    };
    const sync = startDocSync(db, config, fakeGapi(doc), "doc1", dir, () => {}, {
      autoStart: false,
    });
    await sync.pollOnce();
    const threads = db.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0].status).toBe("answered");
    expect(doc.appended).toHaveLength(0);
  });

  it("ignores orphan answers and preamble", async () => {
    config = fakeConfig(null);
    const doc = {
      text: "BACKCHANNEL preamble\n> ## ASK example\n## ANSWER\nstray",
      appended: [] as string[],
    };
    const sync = startDocSync(db, config, fakeGapi(doc), "doc1", dir, () => {}, {
      autoStart: false,
    });
    await sync.pollOnce();
    expect(db.listThreads()).toHaveLength(0);
  });
});
