# omp-grill

Run design interviews with [OMP](https://github.com/can1357/oh-my-pi) in your browser or terminal. Grill presents questions with recommended answers and discussion threads, saves your drafts, and writes a local decision report when you finish.

![Task board interview](docs/interview.png)

Requires OMP 18.4.4 or later. Restart OMP after installing or updating.

## Install

```text
/marketplace add Shadorain/omp-grill
/marketplace install grill@omp-grill
```

Start an interview with `/grill <topic>` or `/grill tui <topic>`. To let the agent start interviews from a natural-language request, enable `allowAgentStart` below.

## Use

1. Open the URL printed by OMP. Keep the full URL private because it contains an access token.
2. Choose an option, write an answer, or add a discussion message. Grill saves these as drafts without sending them to the agent.
3. Click **Send N to agent**, or press Cmd/Ctrl+Enter, to send your drafts together.
4. Click **Finish** to save the interview as `report.md`.

Explore, Defer, Reopen, and visual requests reach the agent immediately rather than waiting for Send.

You can keep several interviews open. Use `/grill use <id>` to select the one that commands and agent replies should target.

| Command | Description |
| --- | --- |
| `/grill <topic>` | Start an interview. |
| `/grill tui` | Open the selected interview in the terminal. |
| `/grill tui <topic>` | Start an interview and open it in the terminal. |
| `/grill tui off` | Turn off the terminal view without closing the interview. |
| `/grill use <id>` | Select an open interview. |
| `/grill url` | Show its private URL. |
| `/grill questions` | List its questions. |
| `/grill answer <id> <option> [note]` | Record an option with an optional note. |
| `/grill answer <id> -- <text>` | Record a written answer. |
| `/grill reply <id> <text>` | Send a message about a question. |
| `/grill pause` | Pause the selected interview. |
| `/grill resume` | Resume a paused or errored interview. |
| `/grill history` | View a finished interview. |
| `/grill sessions` | List saved interviews for this project. |
| `/grill finish` | Finish the interview and save its report. |
| `/grill config` | Show settings; `/grill config <key> <value>` sets one. Keys and values autocomplete. |

Run `/grill` to list open interviews and commands. Tab completion suggests commands, interview IDs, questions, and options.

If an agent turn stops, the page shows its error and keeps the saved batch. Run `/grill resume` in the owning OMP session to retry it. Resuming an attached error keeps the same page URL; finished interviews are excluded from resume.

![Task board prototype](docs/prototype.png)

The Visual view can show a system diagram or an interactive screen prototype. Prototypes run in a sandbox, so clicking inside one does not call the agent. Use diagrams for flows and architecture, and prototypes to explore a screen design.

Recoverable drafts include server archives and copies saved by this browser. Restore an answer or message to stage it again; the archived copy stays available. If two tabs edit the same drafts, choose which copy to keep; the other remains recoverable.

Prototype labels and displayed text update as you edit their inputs, without losing input focus or the caret. Dialog actions must target the current screen, and select actions must use a declared option. Wide sequence diagrams scroll horizontally so actor labels stay readable; self-transitions and self-messages are rendered.

### `/grill tui`

Prefer the terminal? Run `/grill tui` to open the selected interview inside your OMP session. The browser remains available, so you can use either view.

![Session terminal](docs/tui.png)

Use `j`/`k` to move between questions and `a`-`d` to stage an option. Press `enter` to send, `e` to explore, `x` to defer, or `f` twice to finish. Use `tab` to view the discussion and `esc` or `q` to close the inspector. Closing the inspector leaves the interview open.

Starting with `/grill tui <topic>` also wakes the agent to publish the first questions. While a batch is pending, drafts stay editable, but Send, Explore, Defer, and Finish wait for acknowledgement.

## Configuration

Run `/grill config` in the session to show the current settings. Set a value with `/grill config <key> <value>` (tab completion suggests keys and values). Settings live in `settings.json`, which the command creates:

```text
/grill config host 127.0.0.1
/grill config port 43127
/grill config allowAgentStart true
```

You can also create `~/.omp/grill/settings.json` by hand to override the defaults:

```json
{
  "host": "127.0.0.1",
  "port": 43127,
  "allowAgentStart": false
}
```

| Setting | Default | Description |
| --- | --- | --- |
| `host` | `0.0.0.0` | The address the server listens on. |
| `port` | `0` | Use a free port. A fixed port applies to the first interview; later interviews use free ports. |
| `allowAgentStart` | `false` | Allow the agent to start interviews with `grill_publish`. Otherwise, start or resume an interview with `/grill` before its tools become available. |

With `allowAgentStart: false`, Grill tools and their descriptions stay out of the model's context until you start or resume an interview. Questions, replies, and visual requests work normally afterward. Pausing or finishing the last open interview hides the tools again. Set it to `true` to keep the tools available and allow natural-language starts.

Changing `allowAgentStart` takes effect immediately, without an OMP restart. If a fixed port is already in use, Grill reports an error. After changing `host` or `port`, pause and resume the interview to restart its server.

Set `OMP_GRILL_HOME` to store settings and sessions somewhere other than `~/.omp/grill`.

**Network safety:** The default address exposes Grill on all IPv4 interfaces. Use it only on a trusted LAN, never the public internet. HTTP is unencrypted. Set `host` to `127.0.0.1` for local access.

For a remote OMP host, forward the server's port over SSH:

```sh
ssh -N -L 43127:127.0.0.1:43127 user@omp-host
```

Replace `43127` with the actual server port.

Session files stay on your machine. The interface, draft storage, and report generation do not use model tokens. Questions, replies, and visual requests use your configured OMP provider.

## Development

```sh
git clone https://github.com/Shadorain/omp-grill.git
cd omp-grill
bun install
bun test
bun run demo
```

Run `bun run demo` to try Grill with a scripted local provider. Open the printed `DEMO_URL`. The demo uses no inference tokens, and Ctrl+C stops it and removes its temporary files.

Inspired by [grill-with-ui](https://github.com/jasonku09/grill-with-ui). Grill renders diagrams and prototypes from structured specs rather than running model-written HTML.

## License

[MIT](LICENSE)