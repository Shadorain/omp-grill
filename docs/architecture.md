# Architecture

Grill is a single-file OMP extension (`src/extension.ts`) plus a token-gated local
server (`src/server.ts`), a durable per-interview store (`src/store.ts`), a
browser page (`web/`), and a terminal inspector (`src/tui.ts`).

## Data flow

```
agent ──grill_publish──▶ store ──poll──▶ browser page
agent ◀──submission───── server ◀──POST── page drafts (revision CAS)
```

The agent publishes questions; the page renders state. Draft edits autosave with
a revision check; submissions batch every action and wake the owning session.

## Invariants

Keep these true when touching shared code; each has a test.

- **Store is the only writer of durable state.** Server and page never write
  files; they call `store` methods.
- **Drafts use revision CAS.** A conflicting save must not destroy the other
  copy — it becomes a recovery entry (`DraftState.recovery`).
- **Submissions are durable before delivery.** `pending` is persisted, delivered
  on resume, acknowledged only by `handled` in a later publish. Batches are
  tracked per interview and sequence so concurrent grills can't ack each other.
- **Ownership follows the session.** Paused/errored interviews can be adopted by
  another session via `resumeStore`; live ones can't be stolen.
- **HTTP trust boundary.** Private fragment token on every `/api/*`, Host and
  Origin checks on POST, bounded body sizes. Pages carry no ambient auth.
- **Finish is zero-token.** Report generation is a local render, never a model
  call.
- **Tools stay hidden until needed.** `grill_publish`/`grill_state` activate on
  first open interview (or `allowAgentStart`) and deactivate after the last
  finish/pause.
- **Never generate UI at runtime.** The agent emits structured specs only;
  `web/`, `prototype.ts`, and `diagram.ts` render them. Prototype rendering is
  sandboxed (no network, no agent calls from clicks).

## Validation

`store.ts` validates all state transitions and caps sizes (threads, history,
context lists, total state). `settings.ts` validates `settings.json`
(`host`/`port`/`allowAgentStart`) the same way: single `validate*` function,
`fail()` produces `Invalid ... at <path>` errors. Follow that pattern — one
validator per file, called by both read and write paths.
