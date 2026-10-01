# Adding a `/grill` command

Four touch points, all required:

1. **Dispatch** — `src/extension.ts`, in the command handler. Exact-name check
   first (`command === "x"`), then `command.startsWith("x ")` for arguments.
   Throw `Error` with a `Usage:` string on bad input; the TUI surfaces it.
2. **Completion** — `src/completions.ts`. Add to `SUBS`, then a `verb` branch.
   Handle partial-token state (`rest.endsWith(" ")`) so completing a value
   doesn't re-offer keys. Return `null` when nothing matches.
3. **Help** — the `commandHelp()` string in `extension.ts` lists the command
   and its usage.
4. **Docs** — row in the README command table; detail paragraphs only when
   behavior is non-obvious.

## Reading or changing settings

Use `readServerSettings` / `writeServerSettings` (`src/settings.ts`) — never
parse `settings.json` ad hoc. Validation errors already name the file and field.

- `allowAgentStart` is read into memory at `session_start` and refreshed by
  `/grill config`; changing it calls `syncTools()` to flip tool availability
  without restart.
- `host`/`port` are read per `startServer` call, so changes apply on the next
  serve (pause + resume restarts a live one).

## Notifying the user

- `ctx.ui.notify(text, "info"|"error")` — transient results (URLs, selections,
  errors).
- `pi.sendMessage({ customType, content, display: true }, { triggerTurn: false })`
  — persistent content the user may scroll back to (config display, reports).
  Never `triggerTurn: true` for display-only output.
