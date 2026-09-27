import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type ThreadStatus = "pending" | "answered" | "needs_human" | "error";

export interface Thread {
  id: string;
  caller: string;
  subject: string;
  status: ThreadStatus;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: number;
  thread_id: string;
  sender: string;
  body: string;
  created_at: number;
}

export function shortId(): string {
  return randomBytes(5).toString("hex").slice(0, 8);
}

export class Db {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "backchannel.db"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        caller TEXT NOT NULL,
        subject TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','answered','needs_human','error')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_threads_caller ON threads(caller, updated_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  createThread(caller: string, firstQuestion: string): Thread {
    const now = Date.now();
    const thread: Thread = {
      id: shortId(),
      caller,
      subject: firstQuestion.slice(0, 80),
      status: "pending",
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        "INSERT INTO threads (id, caller, subject, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(thread.id, thread.caller, thread.subject, thread.status, thread.created_at, thread.updated_at);
    return thread;
  }

  getThread(id: string): Thread | undefined {
    return this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Thread | undefined;
  }

  setStatus(id: string, status: ThreadStatus): Thread | undefined {
    this.db
      .prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, Date.now(), id);
    return this.getThread(id);
  }

  addMessage(threadId: string, sender: string, body: string): Message {
    const now = Date.now();
    const result = this.db
      .prepare("INSERT INTO messages (thread_id, sender, body, created_at) VALUES (?, ?, ?, ?)")
      .run(threadId, sender, body, now);
    this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(now, threadId);
    return {
      id: Number(result.lastInsertRowid),
      thread_id: threadId,
      sender,
      body,
      created_at: now,
    };
  }

  getMessages(threadId: string): Message[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY id ASC")
      .all(threadId) as unknown as Message[];
  }

  lastCallerMessage(threadId: string, caller: string): Message | undefined {
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE thread_id = ? AND sender = ? ORDER BY id DESC LIMIT 1"
      )
      .get(threadId, caller) as Message | undefined;
  }

  listThreads(caller?: string): Thread[] {
    if (caller) {
      return this.db
        .prepare("SELECT * FROM threads WHERE caller = ? ORDER BY updated_at DESC")
        .all(caller) as unknown as Thread[];
    }
    return this.db.prepare("SELECT * FROM threads ORDER BY updated_at DESC").all() as unknown as Thread[];
  }
}
