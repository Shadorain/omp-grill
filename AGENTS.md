# omp-grill

OMP extension: browser/terminal design interviews. Agent publishes questions via
`grill_publish`; user answers on a token-gated local page or in the TUI; drafts
autosave; finish writes a local report. Single extension entry:
`src/extension.ts`.

## Commands

- `bun test` — suite (must stay green)
- `bun run typecheck` — `tsc --noEmit` (must stay clean)
- `bun run demo` — scripted provider, prints `DEMO_URL`; no inference tokens

## Layout

- `src/` — extension, server, store, renderers (prototype/diagram), TUI
- `web/` — browser page (plain HTML/CSS/JS, no build)
- `tests/` — `bun:test` files mirroring `src/`
- `examples/demo.ts` — scripted end-to-end demo
- `docs/` — screenshots plus reference docs below

## Conventions

- Plain TypeScript on Bun. No framework, no build step for `web/`.
- One validator per file (`validate*`), shared by read and write paths; errors
  name the file and field.
- Settings live in `$OMP_GRILL_HOME/settings.json` — always through
  `src/settings.ts` helpers, never ad-hoc JSON parsing.
- Behavior changes ship with tests; test behavior (HTTP/store state), not
  internals.

## Commits

- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:` …
- Commit per work slice — land a coherent unit, not a session dump.
- Committing is fine without asking. Wait for approval before `git push`
  unless the task directed it.

## Reference docs

## Reference docs

Read on trigger, not up front:

| Trigger | File |
|---|---|
| Data flow, invariants (drafts CAS, pending batches, ownership, token boundary) | `docs/architecture.md` |
| Adding or changing a `/grill` command, settings, notifications | `docs/commands.md` |
| Writing/running tests, fixtures, coverage expectations | `docs/testing.md` |

## Hard rules

- Agent output is structured specs only — never emit HTML/CSS/JS at runtime.
- Report/finish paths are zero-token; no model calls on save.
- Every `/api/*` route keeps the fragment-token + Host/Origin checks.
