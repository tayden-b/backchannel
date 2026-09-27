import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Db } from "../src/db.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "backchannel-test-"));
  db = new Db(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("db", () => {
  it("creates a thread with an 8-char id and subject truncated to 80 chars", () => {
    const t = db.createThread("muse", "x".repeat(120));
    expect(t.id).toHaveLength(8);
    expect(t.caller).toBe("muse");
    expect(t.subject).toHaveLength(80);
    expect(t.status).toBe("pending");
  });

  it("adds messages and retrieves them in order", () => {
    const t = db.createThread("muse", "hello?");
    db.addMessage(t.id, "muse", "hello?");
    db.addMessage(t.id, "local", "hi there");
    const msgs = db.getMessages(t.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].sender).toBe("muse");
    expect(msgs[1].body).toBe("hi there");
  });

  it("transitions status", () => {
    const t = db.createThread("muse", "q");
    const updated = db.setStatus(t.id, "needs_human");
    expect(updated?.status).toBe("needs_human");
    expect(db.setStatus(t.id, "answered")?.status).toBe("answered");
  });

  it("rejects invalid status at the DB level", () => {
    const t = db.createThread("muse", "q");
    expect(() =>
      // @ts-expect-error deliberate invalid status
      db.setStatus(t.id, "bogus")
    ).toThrow();
  });

  it("lists threads newest first, optionally filtered by caller", () => {
    const a = db.createThread("muse", "a");
    const b = db.createThread("instinct", "b");
    db.setStatus(a.id, "answered"); // bumps updated_at
    const all = db.listThreads();
    expect(all[0].id).toBe(a.id);
    const museOnly = db.listThreads("muse");
    expect(museOnly).toHaveLength(1);
    expect(museOnly[0].id).toBe(a.id);
    expect(b.id).not.toBe(a.id);
  });
});
