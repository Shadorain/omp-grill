# Testing

`bun test` runs everything; `bun run typecheck` (`tsc --noEmit`) must stay clean.
`bun run demo` launches a scripted local provider for manual browser checks.

## Layout

| File | Covers |
|---|---|
| `tests/store.test.ts` | State transitions, validation, caps, export guards |
| `tests/server.test.ts` | Token/Origin/Host enforcement, drafts CAS, delivery failures, binding |
| `tests/extension.test.ts` | Command dispatch, tool activation lifecycle, resume, finish |
| `tests/completions.test.ts` | `/grill` argument autocomplete |
| `tests/prototype.test.ts`, `tests/tui.test.ts`, `tests/sessions.test.ts` | Renderer and session-list behavior |

## Conventions

- Fixtures use `mkdtempSync` + `rmSync` in `afterEach`; never touch the real
  `~/.omp/grill`. `tests/extension.test.ts` redirects it via `OMP_GRILL_HOME`.
- The extension fixture stubs `ExtensionAPI`/`ExtensionContext` by hand and calls
  `command.handler` directly — drive commands through `app.command(...)` rather
  than reaching into internals.
- Tests assert behavior over HTTP or store state (`fetch` with `X-Grill-Token`),
  not implementation details.
- New commands need three tests: dispatch happy path, validation errors,
  completion output.
