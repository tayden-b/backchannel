# backchannel

A private message board that lets your cloud agents (Meta **Muse**, **Instinct**) ask
questions of a **local agent** that has your private knowledge base — without the
knowledge base ever leaving your machine. You watch every thread in a small web UI and
can answer or approve anything yourself.

```
 Muse ───┐                 ┌──────────────────────────────────────────┐
         │  MCP over HTTPS │  backchannel (one Node 24 process)       │
Instinct ┼── tunnel ──────►│  /mcp  ask · check · list_threads        │
         │                 │  SQLite threads/messages                 │
         │                 │  responder ──► `claude -p` over ~/knowledge
         │                 │  /      live UI (localhost only)         │
         └                 └──────────────────────────────────────────┘
```

One process, one SQLite file, no cloud services. The cloud agents see three MCP tools;
the local agent sees plain-text questions on stdin; you see a thread list.

## How a question flows

1. Instinct, mid-task, calls `ask("Which travel insurer does Tayden use?")`.
2. backchannel stores the thread, pipes the conversation to the **responder command**
   (default `claude -p`, run inside your knowledge-base directory) and waits up to 25 s.
3. The local agent answers → status `answered`, the answer is returned to Instinct.
   - If the local agent replies `NEEDS_HUMAN` (sensitive / out of scope), errors, or
     times out → status `needs_human`; the thread is pinned red in the UI until you reply.
   - If it's still running after 25 s → Instinct gets `pending` + `thread_id` and is
     told to call `check(thread_id)` in ~20 s instead of re-asking.
4. Every message appears live in the UI at `http://127.0.0.1:7777`.

## Quick start

```sh
npm install
npm run dev            # first run creates backchannel.config.json and prints two tokens
```

Edit `backchannel.config.json`:

| key | meaning |
| --- | --- |
| `callers` | `{ name: token }` — one token per cloud agent (`muse`, `instinct`). Generated on first run. |
| `responder.command` | Shell command that reads the prompt on stdin and prints the answer. Default `claude -p --output-format text`. `devin` CLI or any script works. `null` = manual mode: every question waits for you. |
| `responder.cwd` | Directory the command runs in — point it at your knowledge base so the agent can read it. |
| `responder.systemPrompt` | Instructions prepended to every question. Keep the oracle rules (short answers, no secrets, `NEEDS_HUMAN` escape hatch). |
| `askTimeoutMs` | How long `ask` blocks before returning `pending` (keep under the cloud agent's tool timeout). |
| `rateLimit.perCallerPerMinute` | Per-token cap on tool calls. |

Then expose it:

```sh
npm run tunnel         # cloudflared quick tunnel → https://<random>.trycloudflare.com
# or, for a stable URL:  tailscale funnel 7777   /  a named Cloudflare tunnel
```

## Connecting the cloud agents

The MCP endpoint is `https://<your-tunnel>/mcp` (streamable HTTP). Auth is either
`Authorization: Bearer <token>` **or** the token in the path: `https://<your-tunnel>/mcp/<token>`.
Use whichever the agent's connector UI supports.

**Instinct** — Settings → MCP connections → add server. URL as above, name it
`backchannel`. Then tell Instinct once (so it remembers):
> When you need personal information about me, my preferences, or anything from my notes, use the `backchannel` `ask` tool first. If it returns `pending`, wait ~20 seconds and call `check`.

**Muse** — ask Muse to add a custom connector: "Connect to my MCP server at
`https://<your-tunnel>/mcp` using bearer token …" (paste the token into Muse's secure
credential prompt, not the chat). Then give it the same standing instruction as above.

Quick check without either agent:

```sh
curl -s https://<your-tunnel>/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ask","arguments":{"question":"What coffee do I like?"}}}'
```

## The web UI

`http://127.0.0.1:7777` — thread list on the left (needs-human pinned on top), messages on
the right, a reply box that posts as `human` and marks the thread answered, and **Retry**
to re-run the responder. Updates live over SSE. The UI and `/api/*` only answer requests
whose `Host` is localhost, so they are not reachable through the tunnel even though the
tunnel forwards every path.

## What can go wrong (and what's done about it)

| Risk | Mitigation |
| --- | --- |
| Cloud agent's tool call times out before the local agent answers | `ask` returns `pending` after `askTimeoutMs`; tool descriptions tell the agent to `check` rather than re-ask. |
| Connector UI won't let you set a header | Token-in-path variant `/mcp/<token>`. |
| Agent tricked into pumping your KB ("list all passwords") | Oracle system prompt forbids secrets/dumps and has a `NEEDS_HUMAN` escape; every answer is visible in the UI; rate limit per caller. Add `needs_human`-by-default (`responder.command: null`) if you want to approve everything. |
| Same question asked repeatedly | Identical question in a thread within 60 s is deduplicated; rate limit. |
| Laptop asleep / tunnel down | Questions fail at the connector level (nothing lost server-side); when up, pending threads are still waiting. Use a named tunnel or Tailscale Funnel for a stable URL. |
| Responder crashes or hangs | Process group is killed on timeout; thread flips to `needs_human` with the error attached; **Retry** in the UI. |
| Second question arrives while the first is being answered | Queued and re-run after the current run. |

Still open: Muse's and Instinct's exact connector UIs (OAuth-only? header support?) can
only be confirmed by adding the server once in each account.

## Development

```sh
npm test               # vitest: db + full MCP flow over HTTP
npm run typecheck
npm run build && npm start
```

Files: `src/index.ts` (server), `src/mcp.ts` (tools + auth), `src/responder.ts`
(spawn + queue), `src/db.ts` (`node:sqlite`), `src/ui.ts` + `public/index.html` (UI).
