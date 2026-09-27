import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { emitThread, runResponder, waitForThread } from "./responder.js";
import { BOOTSTRAP_ANSWER, BOOTSTRAP_QUESTION } from "./connect.js";

const DEDUPE_WINDOW_MS = 60_000;

export interface AskResult {
  thread_id?: string;
  status?: string;
  answer?: string;
  hint?: string;
  error?: string;
  deduplicated?: boolean;
}

function norm(q: string): string {
  return q.trim().toLowerCase().replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
}

export async function askCore(
  db: Db,
  config: Config,
  caller: string,
  question: string,
  thread_id?: string
): Promise<AskResult> {
  let thread;
  if (thread_id) {
    thread = db.getThread(thread_id);
    if (!thread || thread.caller !== caller) {
      return { error: `unknown thread_id ${thread_id}` };
    }
  }

  // Dedupe: identical question in the same thread within 60s returns current state.
  if (thread) {
    const last = db.lastCallerMessage(thread.id, caller);
    if (last && last.body === question && Date.now() - last.created_at < DEDUPE_WINDOW_MS) {
      const current = db.getThread(thread.id)!;
      const answer =
        current.status === "answered"
          ? db.getMessages(current.id).filter((m) => m.sender !== caller).at(-1)?.body
          : undefined;
      return { thread_id: current.id, status: current.status, answer, deduplicated: true };
    }
  }

  // Bootstrap probe: agents paste this to verify the connection works.
  if (norm(question) === BOOTSTRAP_QUESTION) {
    if (!thread) thread = db.createThread(caller, question);
    db.addMessage(thread.id, caller, question);
    db.addMessage(thread.id, "local", BOOTSTRAP_ANSWER);
    const answered = db.setStatus(thread.id, "answered")!;
    emitThread(answered);
    return { thread_id: thread.id, status: "answered", answer: BOOTSTRAP_ANSWER };
  }

  if (thread) {
    db.setStatus(thread.id, "pending");
  } else {
    thread = db.createThread(caller, question);
  }

  db.addMessage(thread.id, caller, question);
  emitThread(db.getThread(thread.id)!);

  void runResponder(db, config, thread.id);

  const done = await waitForThread(thread.id, config.askTimeoutMs);
  const current = done ?? db.getThread(thread.id)!;

  if (current.status === "answered") {
    const answer = db
      .getMessages(current.id)
      .filter((m) => m.sender !== caller)
      .at(-1)?.body;
    return { thread_id: current.id, status: "answered", answer };
  }
  if (current.status === "needs_human") {
    return {
      thread_id: current.id,
      status: "needs_human",
      hint: "waiting for Tayden to answer; check later",
    };
  }
  return {
    thread_id: current.id,
    status: "pending",
    hint: "Call check(thread_id) in ~20 seconds. Do not re-ask.",
  };
}
