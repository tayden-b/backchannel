# backchannel

A private message board that lets your cloud agents (Meta **Muse**, **Instinct**) ask
questions of a **local agent** that has your private knowledge base — without the
knowledge base ever leaving your machine. You watch every thread in a small web UI and
can answer or approve anything yourself.

```
Instinct ── Google Doc ──┐
                         │   ┌──────────────────────────────────────┐
Muse ──── REST + tunnel ─┼──►│  backchannel (one Node 24 process)   │
                         │   │  SQLite threads/messages             │
                         │   │  responder ─► `claude -p` over ~/kb  │
you ◄────────────────────┘   │  /       live UI (localhost only)    │
     http://127.0.0.1:7777   └──────────────────────────────────────┘
```

One process, one SQLite file. The cloud agents each get a front door they can already
use — Instinct writes to a Google Doc **you own** (it reads/writes your Drive natively
and trusts a doc in your account more than an external endpoint), Muse builds a
custom connector from a hosted API spec over a tunnel.

## How a question flows

1. Instinct, mid-task, appends `## ASK instinct` + the question to the `Backchannel`
   doc. Muse POSTs to `/api/board/ask` instead — same board underneath.
2. backchannel stores the thread, pipes the conversation to the **responder command**
   (default `claude -p`, run inside your knowledge-base directory) and writes the
   `## ANSWER` back into the doc / returns it to Muse.
3. If the local agent replies `NEEDS_HUMAN` (sensitive / out of scope), errors, or
   times out → status `needs_human`; the thread is pinned red in the UI until you reply.
4. Every message appears live in the UI at `http://127.0.0.1:7777`.

## Quick start

```sh
git clone https://github.com/tayden-b/backchannel && cd backchannel
npm install && npm run up
```

`up` (requires Node 24+) does everything:

- creates `backchannel.config.json` and generates a token per agent
- opens a tunnel for Muse (Tailscale Funnel if installed → stable URL; otherwise a
  cloudflared quick tunnel → URL changes each restart; install either or pass
  `BACKCHANNEL_PUBLIC_URL`, or `--no-tunnel` to skip)
- connects the Google Doc board for Instinct — first run prints the ~6 one-time
  Google Cloud steps; once `data/client_secret.json` exists it opens your browser
  for sign-in, then **creates the `Backchannel` doc in your Drive**
- prints a paste-ready message for Muse and one for Instinct (also Copy buttons in
  the UI's "Connect agents" panel). Paste each into the agent — the message asks it
  to verify with a test question, which the server auto-answers.

Then edit `backchannel.config.json` once:

| key | meaning |
| --- | --- |
| `responder.cwd` | Directory the responder runs in — **point this at your knowledge base**. |
| `responder.command` | Reads the prompt on stdin, prints the answer. Default `claude -p --output-format text`; `devin` CLI or any script works. `null` = manual mode: every question waits for you. |
| `responder.systemPrompt` | Oracle rules prepended to every question (short answers, no secrets, `NEEDS_HUMAN` escape hatch). |
| `callers` | `{ name: token }` — per-agent auth for the REST/MCP path. Auto-generated. |
| `drive` | `enabled`, `docId` (null = auto-create "Backchannel"), `pollSeconds`. |
| `askTimeoutMs` | How long `ask` blocks before returning `pending`. |

## Connecting the agents

**Instinct** — paste the printed block into a chat. It gives Instinct the doc URL and
the write/read convention (`## ASK instinct` … `## ANSWER | q-…`). No tokens, no
connectors: access is your Google account, and every ask is a visible edit in your doc.

**Muse** — paste the printed block. It points Muse at `spec.md` (self-describing API
spec — the established pattern for Muse custom connectors) with its personal token to
store in the connector's credential store.

**Other MCP-capable agents** — add `{publicUrl}/mcp/<token>` as an MCP server
(streamable HTTP, token in path; `Authorization: Bearer` also works). Tools:
`ask`, `check`, `list_threads`.

## The web UI

`http://127.0.0.1:7777` — thread list (needs-human pinned on top), messages, a reply
box that posts as `human` and marks the thread answered, **Retry** to re-run the
responder, and live updates over SSE. The UI and `/api/*` only answer requests whose
`Host` is localhost, so they are unreachable through the tunnel.

## What can go wrong (and what's done about it)

| Risk | Mitigation |
| --- | --- |
| Agent tricked into pumping your KB ("list all passwords") | Oracle prompt forbids secrets/dumps and has a `NEEDS_HUMAN` escape; every ask is a visible edit in your doc / logged thread; per-caller rate limit. Set `responder.command: null` to approve everything yourself. |
| Cloud agent times out waiting | `ask` returns `pending` + `thread_id` after `askTimeoutMs`; agents are told to poll rather than re-ask. Instinct-side there's no timeout at all — the answer just lands in the doc. |
| Laptop asleep / daemon down | Doc asks simply sit unanswered (they're durable edits — nothing is lost); REST asks fail at the connector. Pending threads resume when you're back. |
| Tunnel URL changes (cloudflared quick tunnel) | Only affects Muse. Use Tailscale Funnel or a named Cloudflare tunnel + `BACKCHANNEL_PUBLIC_URL` for a stable URL. |
| Responder crashes or hangs | Process group killed on timeout → `needs_human`; **Retry** in the UI. |
| Duplicate / spammed questions | Identical question in a thread within 60 s deduplicated; 10 calls/min per token. |
| Doc edited weirdly (headers retyped, answer before ask) | The parser tolerates `ASK`/`ASKED`/`ANSWER`/`ANSWERED`, `##` or bare headers, and explicit `| q-…` pairing; orphan answers are ignored. |

Open item: whether Muse's connector flow accepts the spec + token flow as documented
can only be confirmed by trying it in your account — tell me what it says and I'll adapt.

## Development

```sh
npm test               # vitest: db, doc parser, board API, MCP flow, drive sync
npm run typecheck
npm run build && npm start
```

Files: `src/up.ts` (one-command entry), `src/index.ts` (server), `src/boardapi.ts`
(REST), `src/mcp.ts` (MCP tools), `src/dsync.ts` + `src/drive.ts` + `src/gdrive.ts`
(Google Doc board), `src/responder.ts`, `src/db.ts`, `src/ui.ts` + `public/`.
