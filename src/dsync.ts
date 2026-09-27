import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { GApi } from "./gdrive.js";
import { DriveError } from "./gdrive.js";
import { parseDoc, pairBlocks, buildAppendAnswer, buildPreamble } from "./drive.js";
import { emitThread, runResponder } from "./responder.js";
import { setDrive } from "./state.js";

interface SyncEntry {
  threadId: string;
  synced: boolean;
}

interface SyncState {
  [qid: string]: SyncEntry;
}

const STATE_FILE = "doc_sync.json";

export interface DocSync {
  stop(): void;
  pollOnce(): Promise<void>;
}

export function startDocSync(
  db: Db,
  config: Config,
  gapi: GApi,
  docId: string,
  dataDir: string,
  log: (line: string) => void = console.log,
  opts: { autoStart?: boolean } = {}
): DocSync {
  const statePath = path.join(dataDir, STATE_FILE);
  const seen: SyncState = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, "utf8")) as SyncState)
    : {};
  const persist = () => writeFileSync(statePath, JSON.stringify(seen, null, 2));

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function pollOnce(): Promise<void> {
    let text: string;
    try {
      text = await gapi.exportText(docId);
    } catch (err) {
      setDrive({ lastError: String(err).slice(0, 200), lastPollAt: Date.now() });
      if (err instanceof DriveError && err.kind === "unauth") {
        log("Drive auth lost — run `npm run auth` to re-authenticate. Polling stopped.");
        setDrive({ connected: false });
        stopped = true;
        if (timer) clearTimeout(timer);
      }
      return;
    }
    const pairs = pairBlocks(parseDoc(text));
    let open = 0;

    for (const pair of pairs) {
      if (pair.orphan) {
        log(`doc: ignoring orphan answer block (${(pair.answer?.text ?? "").slice(0, 60)}…)`);
        continue;
      }
      const ask = pair.ask!;
      const qid = ask.qid!;
      const agent = ask.agent ?? "unknown";

      if (!seen[qid]) {
        const thread = db.createThread(`doc:${agent}`, ask.text);
        db.addMessage(thread.id, agent, ask.text);
        if (pair.answer) {
          db.addMessage(thread.id, "doc", pair.answer.text);
          db.setStatus(thread.id, "answered");
          seen[qid] = { threadId: thread.id, synced: true };
          persist();
          emitThread(db.getThread(thread.id)!);
          continue;
        }
        seen[qid] = { threadId: thread.id, synced: false };
        persist();
        emitThread(thread);
        void runResponder(db, config, thread.id);
      }

      const entry = seen[qid];
      if (pair.answer) {
        // someone (agent or human) already answered in the doc; mark seen so we
        // don't double-answer, and reflect it locally if we haven't answered
        if (!entry.synced) {
          entry.synced = true;
          persist();
          const thread = db.getThread(entry.threadId);
          if (thread && thread.status !== "answered") {
            db.addMessage(thread.id, "doc", pair.answer.text);
            const updated = db.setStatus(thread.id, "answered")!;
            emitThread(updated);
          }
        }
        continue;
      }

      open++;
      // answered locally but not yet written back to the doc
      if (!entry.synced) {
        const thread = db.getThread(entry.threadId);
        if (thread?.status === "answered") {
          const answer = db
            .getMessages(thread.id)
            .filter((m) => m.sender !== agent)
            .at(-1)?.body;
          if (answer) {
            try {
              await gapi.appendText(docId, buildAppendAnswer(qid, answer));
              entry.synced = true;
              persist();
            } catch (err) {
              setDrive({ lastError: `append failed: ${String(err).slice(0, 160)}` });
            }
          }
        }
      }
    }

    setDrive({ connected: true, lastPollAt: Date.now(), lastError: null, openQuestions: open });
  }

  async function loop(): Promise<void> {
    await pollOnce().catch((err) => setDrive({ lastError: String(err).slice(0, 200) }));
    if (!stopped) timer = setTimeout(loop, config.drive.pollSeconds * 1000);
  }

  // seed preamble if the doc is empty
  const seed = async () => {
    try {
      const text = await gapi.exportText(docId);
      if (!text.trim()) await gapi.appendText(docId, buildPreamble());
    } catch (err) {
      setDrive({ lastError: String(err).slice(0, 200) });
    }
  };

  if (opts.autoStart !== false) {
    void (async () => {
      await seed();
      void loop();
    })();
  }

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    pollOnce,
  };
}
