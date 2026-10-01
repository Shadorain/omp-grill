# Changelog

## Unreleased

- Add `allowAgentStart` (default `false`). Grill tools stay inactive until a user command opens or resumes an interview, and are hidden again when the last open interview is paused or finished. Set it to `true` to allow agent-started interviews.
- Replace the manual outbox with draft-on-edit: answers and messages autosave to the server with revision CAS, survive reload and resume, and go out together with one Send.
- Add request-idempotent `/api/send` retries, per-question answer history, and recovery entries for cleared drafts.
- Add intent/glossary/facts/risks context (`/api/context`), a live report preview (`/api/report`), deterministic SVG system diagrams (`/api/diagram`, `visualize`/`visual-feedback` actions), and explicit project export (`/api/export`) with symlink/traversal guards.
- Add per-session server leases, `/grill sessions`, and a `/grill resume` picker that can adopt paused or errored sessions without stealing live ones.
- Add sandboxed interactive prototypes (`/api/prototype`) alongside diagrams in a Visual view, with feedback-driven regeneration and stale marking when decisions change.
- Redesign the browser page as three columns (question list, question, discussion) with a bottom send bar, modeled on upstream grill-with-ui: lettered options with the recommendation outlined, staged discussion messages, one `Send N to agent` button (⌘/Ctrl+Enter), click-to-change recorded answers, `after Qn` dependency links, and Notes/Report as header drawers. The review dialog, decision map, and four-tab layout are gone.
- Notes: facts no longer require a source, risks no longer require a mitigation, and saved glossary terms, facts, and risks can be removed.
- On the last question, Next becomes Send while anything is staged, and Finish once every question is recorded. Answered questions show a check and stay changeable; a different option stages a replacement rather than erasing the recorded answer. When the agent has no further questions, the status reads Ready to finish instead of leaving Next disabled.
- Scope saved sessions to the repository (git common directory) instead of the checkout path, so `/grill sessions`, `history`, and `resume` work from any worktree. Exports still resolve against the interview's original checkout; sessions saved before this change are backfilled on load.
 - Visual defaults to a diagram, which fits any topic. A prototype is offered only as a screen preview. The page has a favicon.
 - Add `/grill history`: pick a finished interview and open its locked browser view. It does not replace a live grill.
- Several grills can be open at once. Each has its own page. `/grill use <id>` selects which one commands and agent publishes target. Pause, finish, and history affect only the selected grill.
- `/grill` arguments autocomplete. `/grill tui [topic]` opens the interview in the session terminal; `off` leaves that view. The browser page still works.
- Commands before any grill exists say `No grill is open. Start one with /grill <topic>.` A missing grill home is an empty list, not a filesystem error.
- `/grill`'s command menu description is the purpose only. Autocomplete lists the commands.
- Fix `/grill resume` of another session's paused grill failing on its own server lease.
- Fix sent drafts reappearing when their text had leading or trailing whitespace, and `/grill finish` failing on stored drafts with empty text.
- Fix explore, defer, reopen, and preview requests racing autosave into false "drafts changed" conflicts.
- Fix clicks being dropped while polling or autosave rebuilt the question list and options.
- Fix the resume picker always choosing the newest of several sessions with the same topic.
- Fix the missing `GET /api/diagram` route, question bodies never showing, and a browser draft with an unselected option being rejected by the server.
- Cap per-question threads (200), answer history (50), and glossary/facts/risks (200 each) so long sessions stay under the state size limit.
- Make `bun run demo` exit when OMP exits instead of hanging on stdin.
- Fix error resume reloading a stale store underneath a live browser. Reuse attached runtimes, resume attached errors with the bare command, and skip finished interviews.
- Track running agent batches by interview and sequence, including CLI submissions, so interleaved interviews cannot acknowledge or fail each other's work.
- Wake the agent when starting from `/grill tui <topic>`, guard terminal submission actions while a batch is pending, and hide Grill tools immediately after the last interview finishes from either UI.
- Show durable server recovery entries and agent error hints in the browser. Make both conflict choices safe to activate repeatedly and preserve the alternate draft copy.
- Release retry requests after definitive client rejections so corrected input can be sent. Keep ambiguous timeouts, server errors, and network failures retryable with their original request.
- Allow unsourced facts through the tool schema as well as the store.
- Interpolate prototype form labels and update dependent displays in place, preserving focus and caret. Synchronize values after actions, reject cross-screen dialog actions, and reject select values outside the declared options.
- Render diagram self-loops and sequence self-messages. Space sequence actors without overlap and scroll wide diagrams instead of shrinking their labels.
- Fix the scripted demo's URL capture so `DEMO_URL` prints the current interview's private link.
- Add `/grill config` to show `settings.json` in the session and set `host`, `port`, or `allowAgentStart` with autocompleted keys and values. `allowAgentStart` changes apply immediately; `host` and `port` apply the next time a server starts.

## 1.0.0

- Ship Grill as an OMP extension with `/grill` commands and natural-language startup through `grill_publish`.
- Add a static browser interview UI with staged answers, discussion threads, option analysis, and a decision dependency map.
- Deliver browser submissions directly into the owning OMP session and persist failed deliveries for explicit resume.
- Export native decision records locally without generating documents with a model call at Finish.
- Support optional host and port settings in `settings.json`, stored alongside session data and honored on start or resume.
- Support staged draft IDs on unencrypted LAN origins without secure-context-only browser APIs.
- Add an isolated scripted demo that exercises OMP and the browser without inference tokens.
- Add extension-only package metadata and an OMP marketplace manifest; omit the bundled skill.
- Protect the browser API with a private fragment token, Host/Origin checks, bounded inputs, and owner-isolated state.
