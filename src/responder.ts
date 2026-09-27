import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { Config } from "./config.js";
import type { Db, Thread } from "./db.js";

export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emitThread(thread: Thread): void {
  bus.emit(`thread:${thread.id}`, thread);
  bus.emit("thread", thread);
}

const running = new Set<string>();

function buildPrompt(systemPrompt: string, messages: { sender: string; body: string }[]): string {
  const convo = messages.map((m) => `[${m.sender}]: ${m.body}`).join("\n");
  return `${systemPrompt}\n\nConversation so far:\n${convo}\n\nAnswer the latest question.`;
}

function runCommand(command: string, input: string, timeoutMs: number): Promise<{ stdout: string; error?: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, { shell: true });
    } catch (err) {
      resolve({ stdout: "", error: String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, error });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(`timeout after ${timeoutMs}ms`);
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => finish(String(err)));
    child.on("close", (code) => {
      if (code !== 0) finish(`exit ${code}: ${stderr.slice(0, 300)}`);
      else finish();
    });
    child.stdin.on("error", () => {});
    child.stdin.write(input);
    child.stdin.end();
  });
}

export async function runResponder(db: Db, config: Config, threadId: string): Promise<void> {
  if (running.has(threadId)) return;
  running.add(threadId);
  try {
    const thread = db.getThread(threadId);
    if (!thread) return;

    if (!config.responder.command) {
      const updated = db.setStatus(threadId, "needs_human");
      if (updated) emitThread(updated);
      return;
    }

    const messages = db.getMessages(threadId);
    const prompt = buildPrompt(config.responder.systemPrompt, messages);
    const { stdout, error } = await runCommand(config.responder.command, prompt, config.responder.timeoutMs);

    const answer = stdout.trim();
    if (error) {
      db.addMessage(threadId, "local", `responder error: ${error.slice(0, 200)}`);
      const updated = db.setStatus(threadId, "needs_human");
      if (updated) emitThread(updated);
      return;
    }
    if (!answer || answer === "NEEDS_HUMAN" || answer.startsWith("NEEDS_HUMAN")) {
      const updated = db.setStatus(threadId, "needs_human");
      if (updated) emitThread(updated);
      return;
    }
    db.addMessage(threadId, "local", answer);
    const updated = db.setStatus(threadId, "answered");
    if (updated) emitThread(updated);
  } catch (err) {
    try {
      db.addMessage(threadId, "local", `responder error: ${String(err).slice(0, 200)}`);
      const updated = db.setStatus(threadId, "needs_human");
      if (updated) emitThread(updated);
    } catch (dbErr) {
      try {
        const updated = db.setStatus(threadId, "error");
        if (updated) emitThread(updated);
      } catch {
        /* nothing left to do */
      }
      void dbErr;
    }
  } finally {
    running.delete(threadId);
  }
}

export function waitForThread(threadId: string, timeoutMs: number): Promise<Thread | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      bus.removeListener(`thread:${threadId}`, onChange);
      resolve(undefined);
    }, timeoutMs);
    function onChange(thread: Thread) {
      if (thread.status === "pending") return;
      clearTimeout(timer);
      resolve(thread);
    }
    bus.on(`thread:${threadId}`, onChange);
  });
}
