# backchannel

A single local Node 24 process that lets cloud personal agents (Meta Muse, Instinct) ask questions of a local agent that has the user's private knowledge base, via MCP. The user watches every thread in a tiny web UI and can answer or approve manually. Zero external services.

> Placeholder README — full docs coming.

## Quick start

```sh
cp backchannel.config.example.json backchannel.config.json   # optional; auto-created with generated tokens on first run
npm install
npm run dev          # http://127.0.0.1:7777
```

- `GET /health` — `{ok:true}`
- `POST /mcp` (or `POST /mcp/:token`) — MCP endpoint, `Authorization: Bearer <caller-token>`
- `GET /` — local web UI for watching and answering threads

The server binds to `127.0.0.1` only. Remote callers reach it through a tunnel that proxies to localhost; MCP access is gated by per-caller bearer tokens, so the UI shares the same bind.
