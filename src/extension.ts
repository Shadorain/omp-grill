import { homedir } from "node:os";
import { join } from "node:path";
 import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Text } from "@oh-my-pi/pi-tui";
 import { grillCompletions } from "./completions.ts";
 import {
   createStore,
   loadStore,
   compactState,
   compactSubmission,
   readContext,
 } from "./store.ts";
 import { startServer } from "./server.ts";
 import { listSessions, resumeStore } from "./sessions.ts";
 import { createGrillInspector, createGrillWidget, grillWidgetTitle, type GrillTheme } from "./tui.ts";
 import type { Action, DraftAnswer, GrillServer, InterviewContext, Publish, SessionSummary, Store, Submission } from "./types.ts";
import {
  displaySettingsPath,
  formatServerSettings,
  readServerSettings,
  validateServerSettings,
  writeServerSettings,
} from "./settings.ts";
import { createPublishSchemas } from "./publish-schema";
import { runSpecialist } from "./models";
import { actionRole, submissionSummary } from "./messages";
import { sameAnswer, selectedOptions, toggleOption } from "./answers";
import { type ExportKind, EXPORT_DEFAULTS, EXPORT_KINDS } from "./exports.ts";
function grillHome() {
  return process.env.OMP_GRILL_HOME || join(homedir(), ".omp", "grill");
}

const ENTRY = "omp-grill.session";
const instruction = `The extension owns the interview UI, durable state, event delivery, prototype interactions and reports. Never generate UI files, session JSON, polling scripts, HTML, CSS or JavaScript. Publish compact structured data, then end your turn; explicit browser sends wake this session.

Publish 1-3 independent frontier questions through grill_publish. Include topic only when starting a user-requested interview. Each question has a stable id, short consequential title/body, 2-4 options {id,label}, and recommendation {option,reason} naming the real tradeoff. Free-text-only questions use empty options and omit the recommended option. dependsOn names answered prerequisites. Mark durable only when hard to reverse, surprising without context, and a real tradeoff. Record verified vocabulary, facts and risks in context {terms,facts,risks,intent}; never claim facts you did not verify. A defer action may carry until — the concrete condition that makes the question worth revisiting — shown in the report's Deferred section.
Use multiSelect:true only when options are independent and can be combined (select all that apply). Omit it for mutually exclusive choices. Multi-select recommendations use options:[ids] rather than option; answers carry options:[ids] and optional text. Never treat omitted multi-select choices as approved.

Challenge assumptions, outcomes, failure cases and tradeoffs. Research code/docs instead of asking the user for facts. Do not seek confirmation for routine implementation choices or reopen settled decisions without a conflict. Do not implement the topic during the interview.

Browser and terminal answers are already persisted. Reply using replies:[{q,text}]. Explicit Explore requests use explorations:[{q,rows:[{option,pros,cons}]}], with specific honest pros and cons for every option. Visualize actions name kind: diagram or prototype. Diagram requests use diagram {title,kind,nodes,edges} plus diagramReply. Prototype requests use prototype {title,start,app,theme,screens} plus prototypeReply. Research the existing app's route, chrome and theme before representing an existing-app change. Screens contain native blocks (heading,text,button,input,select,checkbox,table,list,card,dialog); buttons use action {type:navigate|set|toggle|open|close|submit,target,value?}. Use real screen/component IDs, meaningful clickable flows and local form state. No arbitrary code, fake backends or model requests for prototype clicks. Nest card/dialog children no deeper than three block levels. Regenerate and visual-feedback explicitly require an updated artifact reflecting all current settled decisions and feedback, not just a reply. Preserve settled answers; if feedback conflicts, explain the conflict in that question's thread and request a user decision. Ordinary answer turns never redraw visuals. Publish replies, artifacts and any next frontier in one call, with handled equal to incoming sequence. Always acknowledge the batch. Once consequential branches settle, add no filler questions; direct the user to Finish.

For unresolved choices, draw from the recommendation and label the result assumed inside the artifact; never imply user approval. Prototype form labels and text can include {{component-id}} to display local input state. Prototype value and options are strings; checkbox value is "true" or "false". A list uses options for its items. Renderer state is ephemeral; never promise production persistence or network integration.

 Use grill_state only for context recovery; it omits full historical discussion. Finish is a native zero-model operation. Finish records known decisions, not an invented build specification. Prefer a diagram unless the topic is a user-facing screen. Diagram kind is architecture, flow, sequence, or state. Do not invent a prototype for APIs, data, policy, or process topics. When no consequential question remains, set note to one sentence saying the interview can finish. Do not invent further questions to fill the page. Several grills may be open. A browser wake includes id. Pass that id to grill_publish. Do not write one grill's answers onto another.`;

export default function grillExtension(pi: ExtensionAPI) {
  const z = pi.zod;
  const schemas = createPublishSchemas(z);
  type Runtime = {
    store: Store;
    owner: string;
    server?: GrillServer;
    ctx: ExtensionContext;
    specialist?: AbortController;
    showReadyUrl?: boolean;
  };
  const attached = new Map<string, Runtime>();
   let currentId: string | undefined;
   const runningBatches = new Map<string, number>();
   let projectDir = process.cwd();
   let expanded = false;
   let overlayTui: { requestRender(): void } | undefined;
  let allowAgentStart = false;

  async function syncTools() {
    const names = ["grill_publish", "grill_state"];
    const active = pi.getActiveTools();
    const enabled = allowAgentStart || [...attached.values()].some(
      (runtime) => runtime.store.state.status !== "finished",
    );
    if (names.every((name) => active.includes(name) === enabled)) return;
    await pi.setActiveTools([
      ...active.filter((name) => !names.includes(name)),
      ...(enabled ? names : []),
    ]);
  }

  function runtimeOf(id: string | undefined) {
    return id ? attached.get(id) : undefined;
  }
  function owned(ctx: ExtensionContext) {
    if (ctx.agent.kind === "sub")
      throw new Error("Grills belong to the main OMP session.");
    const runtime = runtimeOf(currentId);
    if (!runtime || runtime.owner !== ctx.sessionManager.getSessionId())
      throw new Error("No grill is open. Start one with /grill <topic>.");
    return runtime;
  }
  function select(runtime: Runtime) {
    currentId = runtime.store.state.id;
    attached.set(currentId, runtime);
  }
  function findAttached(query: string): Runtime | undefined {
    const exact = attached.get(query);
    if (exact) return exact;
    const matches = [...attached.values()].filter(
      (runtime) =>
        runtime.store.state.id.startsWith(query) ||
        runtime.store.state.topic === query,
    );
    if (matches.length > 1)
      throw new Error("That matches more than one grill. Use the id.");
    return matches[0];
  }
  function resumeRuntime(session: SessionSummary, ctx: ExtensionContext): Runtime {
    const existing = attached.get(session.id);
    const owner = ctx.sessionManager.getSessionId();
    if (existing) {
      if (existing.owner !== owner)
        throw new Error("Grill attached to another OMP session.");
      return existing;
    }
    return {
      store: session.owner === owner ? loadStore(session.dir, owner) : resumeStore(session.dir, owner),
      owner,
      ctx,
    };
  }
  async function closeOne(id: string, pause: boolean) {
    const runtime = attached.get(id);
    if (!runtime) return;
    runtime.specialist?.abort();
    attached.delete(id);
    if (currentId === id) currentId = attached.keys().next().value;
    runningBatches.delete(id);
    if (pause && runtime.store.state.status !== "finished")
      runtime.store.setStatus("paused");
    await runtime.server?.close();
    await syncTools();
    if (attached.size) status();
    else {
      runtime.ctx.ui.setWidget("omp-grill", undefined);
      runtime.ctx.ui.setStatus("omp-grill", undefined);
    }
  }
  async function closeAll() {
    for (const id of [...attached.keys()]) await closeOne(id, true);
  }
  function status() {
    const runtime = runtimeOf(currentId);
    overlayTui?.requestRender();
    if (!runtime) return;
    const { store, ctx } = runtime;
    void syncTools().catch((error) => ctx.ui.notify(String(error), "error"));
    ctx.ui.setStatus("omp-grill", undefined);
    syncWidget(ctx);
  }
  async function serve(runtime: Runtime) {
    if (runtime.server) return runtime.server.url;
    const another = [...attached.values()].some((item) => item.server);
    runtime.server = await startServer({
      store: runtime.store,
      ...(another ? { port: 0 } : {}),
      onChange: status,
      onSubmit: (submission) => {
        if (
          !attached.has(runtime.store.state.id) ||
          runtime.ctx.sessionManager.getSessionId() !== runtime.owner
        )
          throw new Error(
            "Grill detached from its OMP session. Resume it from that session.",
          );
        return wake(runtime, submission);
      },
    });
    status();
    return runtime.server.url;
  }
  function notifyUrl(ctx: ExtensionContext, url: string, runtime?: Runtime) {
    const name = runtime
      ? `${grillWidgetTitle(runtime.store.state)} · ${runtime.store.state.id.slice(0, 8)}\n`
      : "";
    ctx.ui.notify(
      `Grill ${name}${url}\nKeep the full URL private. HTTP is unencrypted; use a trusted network or SSH tunnel.`,
      "info",
    );
  }
  async function start(topic: string, ctx: ExtensionContext, context?: InterviewContext) {
    if (ctx.agent.kind === "sub")
      throw new Error("Grills belong to the main OMP session.");
    const owner = ctx.sessionManager.getSessionId();
    const store = createStore({
      home: grillHome(),
      owner,
      project: ctx.cwd,
      topic,
      ...(context ? { context } : {}),
    });
    const runtime: Runtime = { store, owner, ctx };
    select(runtime);
    pi.appendEntry(ENTRY, { dir: store.dir });
    const url = await serve(runtime);
    await syncTools();
    store.setStatus("working");
    status();
    notifyUrl(ctx, url, runtime);
    return runtime;
  }
  function startTurn(runtime: Runtime) {
    runningBatches.set(runtime.store.state.id, 0);
    pi.sendMessage(
      {
        customType: "omp-grill.start",
        content: `Start grill ${runtime.store.state.id} for ${JSON.stringify(runtime.store.state.topic)}. Publish the first frontier with that id; omit topic and handled (no pending submission). Then end the turn without repeating the questions in chat.`,
        display: false,
        attribution: "agent",
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }
  function commandHelp() {
    const open = [...attached.values()]
      .map((runtime) => {
        const mark = runtime.store.state.id === currentId ? "*" : " ";
        const id = runtime.store.state.id.slice(0, 8);
        return `${mark} ${runtime.store.state.topic} · ${id} · ${runtime.store.state.status}`;
      })
      .join("\n");
    return `${open ? `Open:\n${open}\n\n` : ""}/grill <topic>          start another interview; others stay open
/grill use <id>         select which open grill commands target
/grill url              print the selected grill's private URL
/grill questions        list the selected grill's questions
/grill answer <id> <option> [note]
                        record an option, or comma-separated IDs for select-all questions
/grill answer <id> -- <text>
                        free-text answer on the selected grill
/grill reply <id> <text>
                        message the agent about a question
/grill pause            pause the selected grill; others stay up
/grill resume           open a paused or errored grill alongside the others
/grill history          open a finished grill's locked page alongside the others
/grill sessions         list saved grills for this project
 /grill finish           finish the selected grill and write report.md
 /grill export <kind>    write report, adr, beads, diagram or prototype into the project
 /grill fork [id]        start a new interview carrying a finished grill's context
 /grill config           show settings; config <key> <value> sets one
 /grill tui [topic|off]  open this interview in the session terminal`;
  }
  function syncWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (!runtimeOf(currentId) || runtimeOf(currentId)?.store.state.status === "finished") {
      ctx.ui.setWidget("omp-grill", undefined);
      return;
    }
    ctx.ui.setWidget(
      "omp-grill",
      (_tui, theme) => createGrillWidget(
        () => runtimeOf(currentId)?.store.state,
        theme as GrillTheme,
        () => ({ expanded, url: runtimeOf(currentId)?.server?.url }),
      ),
      { placement: "aboveEditor" },
    );
  }
  function stageDraft(runtime: Runtime, questionId: string, optionId: string) {
    const state = runtime.store.state;
    const question = state.questions.find((item) => item.id === questionId);
    if (!question || state.status === "finished") return;
    const draft = toggleOption(question, state.drafts.answers[questionId] ?? question.answer, optionId);
    runtime.store.saveDrafts({
      revision: state.drafts.revision,
      answers: {
        [questionId]: sameAnswer(draft, question.answer) || (!question.multiSelect && !draft.option && !draft.text) ? null : draft,
      },
    });
  }
  function writeDraft(runtime: Runtime, questionId: string, kind: "answer" | "thread", text: string) {
    const state = runtime.store.state;
    const question = state.questions.find((item) => item.id === questionId);
    if (!question || state.status === "finished") return;
    if (kind === "thread") {
      runtime.store.saveDrafts({ revision: state.drafts.revision, threads: { [questionId]: text || null } });
      return;
    }
    const base = state.drafts.answers[questionId] ?? question.answer ?? {};
    const draft: DraftAnswer = {
      ...(question.multiSelect ? { options: selectedOptions(base) } : base.option ? { option: base.option } : {}),
      ...(text.trim() ? { text: text.trim() } : {}),
    };
    runtime.store.saveDrafts({
      revision: state.drafts.revision,
      answers: {
        [questionId]: sameAnswer(draft, question.answer) || (!question.multiSelect && !draft.option && !draft.text) ? null : draft,
      },
    });
  }
  function draftActions(runtime: Runtime): Action[] {
    const actions: Action[] = [];
    for (const question of runtime.store.state.questions) {
      const draft = runtime.store.state.drafts.answers[question.id];
      const text = draft?.text?.trim();
      if (selectedOptions(draft).length || text)
        actions.push({
          type: "answer",
          q: question.id,
          ...(draft?.option ? { option: draft.option } : {}),
          ...(draft?.options !== undefined ? { options: draft.options } : {}),
          ...(text ? { text } : {}),
        });
      const message = runtime.store.state.drafts.threads[question.id]?.trim();
      if (message) actions.push({ type: "thread", q: question.id, text: message });
    }
    return actions;
  }
  async function wake(runtime: Runtime, submission: Submission) {
    if (runtime.specialist) return;
    const controller = new AbortController();
    runtime.specialist = controller;
    try {
      select(runtime);
      status();
      const settings = await readServerSettings(grillHome());

      for (const role of ["discussion", "diagram", "prototype"] as const) {
        const selector = settings[`${role}Model`];
        if (!selector || runtime.store.state.pending?.completed?.includes(role) || !submission.actions.some((action) => actionRole(action) === role)) continue;
        const patch = await runSpecialist({
          ctx: runtime.ctx, selector, role, state: runtime.store.state, submission,
          parameters: schemas.specialists[role], signal: controller.signal, instruction,
        });
        if (controller.signal.aborted || !attached.has(runtime.store.state.id)) return;
        if (runtime.store.state.pending?.seq !== submission.seq) return;
        runtime.store.publish({ ...patch, specialist: { seq: submission.seq, role } });
        status();
      }
      if (controller.signal.aborted || !attached.has(runtime.store.state.id)) return;
      const pending = runtime.store.state.pending;
      if (!pending || pending.seq !== submission.seq) return;
      runningBatches.set(runtime.store.state.id, submission.seq);
      pi.sendMessage({
        customType: "omp-grill.submission",
        content: compactSubmission(runtime.store.state, pending),
        details: { summary: submissionSummary(runtime.store.state, pending) },
        display: true,
        attribution: "user",
      }, { triggerTurn: true, deliverAs: "followUp" });
    } catch (error) {
      if (
        !controller.signal.aborted &&
        attached.has(runtime.store.state.id) &&
        runtime.store.state.pending?.seq === submission.seq
      ) {
        runtime.store.setStatus("error", String(error));
        runtime.ctx.ui.notify(`Grill: ${String(error)}. Saved batch retained; /grill resume retries it.`, "error");
      }
    } finally {
      if (runtime.specialist === controller) runtime.specialist = undefined;
      status();
    }
  }
  function sendDrafts(runtime: Runtime) {
    const actions = draftActions(runtime);
    if (!actions.length) return false;
    void wake(runtime, runtime.store.submit(actions, { draftRevision: runtime.store.state.drafts.revision }));
    return true;
  }
  function finishRuntime(runtime: Runtime) {
    if (runtime.store.state.pending)
      throw new Error("A submission still needs acknowledgement. Resume it before finishing.");
    const actions = draftActions(runtime);
    if (actions.length)
      runtime.store.submit([...actions, { type: "finish" }], {
        draftRevision: runtime.store.state.drafts.revision,
      });
    return runtime.store.finish();
  }
  async function configure(ctx: ExtensionContext, command: string) {
    const rest = command === "config" ? "" : command.slice(7).trim();
    const home = grillHome();
    const where = displaySettingsPath(home);
    if (!rest) {
      const settings = await readServerSettings(home);
      await pi.sendMessage({
        customType: "omp-grill:config",
        content: formatServerSettings(settings, where),
        display: true,
      }, { triggerTurn: false });
      return;
    }
    const parts = rest.split(/\s+/);
    const [key, value] = parts;
    const usage =
      "Usage: /grill config <host|port|allowAgentStart|discussionModel|diagramModel|prototypeModel> <value>; models use provider/model-id or main";
    if (parts.length !== 2 || !key || !value || !["host", "port", "allowAgentStart", "discussionModel", "diagramModel", "prototypeModel"].includes(key))
      throw new Error(usage);
    const current = await readServerSettings(home);
    const candidate: Record<string, unknown> = { ...current };
    if (key === "host") candidate.host = value;
    else if (key === "port") candidate.port = Number(value);
    else if (key === "allowAgentStart")
      candidate.allowAgentStart = value === "true" ? true : value === "false" ? false : value;
    else candidate[key] = value;
    const next = validateServerSettings(candidate, where);
    if (key.endsWith("Model") && value !== "main") {
      const slash = value.indexOf("/");
      if (!ctx.modelRegistry.find(value.slice(0, slash), value.slice(slash + 1)))
        throw new Error(`Unknown Grill model: ${value}`);
    }
    await writeServerSettings(home, next);
    if (key === "allowAgentStart") {
      allowAgentStart = next.allowAgentStart;
      await syncTools();
    }
    const applies =
      key === "host" || key === "port"
        ? ". Applies when a server next starts; /grill pause then /grill resume restarts it"
        : "";
    ctx.ui.notify(`Grill configuration set at ${where}: ${key} ${candidate[key]}${applies}`, "info");
  }
  async function openTui(ctx: ExtensionContext) {
    if (!ctx.hasUI) throw new Error("Session TUI needs the interactive terminal.");
    owned(ctx);
    syncWidget(ctx);
    await ctx.ui.custom((tui, theme, keys, done) => {
      overlayTui = tui;
      return createGrillInspector(
        () => runtimeOf(currentId)?.store.state,
        {
          close: () => done(undefined),
          stage: (questionId, optionId) => {
            const current = runtimeOf(currentId);
            if (current) stageDraft(current, questionId, optionId);
            tui.requestRender();
          },
          write: (questionId, kind, text) => {
            const current = runtimeOf(currentId);
            if (current) writeDraft(current, questionId, kind, text);
            tui.requestRender();
          },
          send: () => {
            const current = runtimeOf(currentId);
            if (current) sendDrafts(current);
            tui.requestRender();
          },
          finish: () => {
            const current = runtimeOf(currentId);
            if (!current) return;
            finishRuntime(current);
            status();
            tui.requestRender();
          },
          explore: (questionId) => {
            const current = runtimeOf(currentId);
            if (!current) return;
            wake(current, current.store.submit([{ type: "explore", q: questionId }]));
            tui.requestRender();
          },
          defer: (questionId, until) => {
            const current = runtimeOf(currentId);
            if (!current) return;
            wake(current, current.store.submit([{ type: "defer", q: questionId, ...(until ? { until } : {}) }]));
            tui.requestRender();
          },
        },
        () => tui.terminal.rows,
        theme as GrillTheme,
        keys,
      );
    });
    overlayTui = undefined;
  }

  pi.registerCommand("grill", {
    description: "Design interview in the browser or the session terminal.",
    getArgumentCompletions(argumentPrefix: string) {
      const current = runtimeOf(currentId);
      let saved: { id: string; topic: string; status: string }[] = [];
      try {
        saved = listSessions(grillHome(), projectDir).map((session) => ({
          id: session.id,
          topic: session.topic,
          status: session.status,
        }));
      } catch {
        saved = [];
      }
      return grillCompletions(argumentPrefix, {
        open: [...attached.values()].map((runtime) => ({
          id: runtime.store.state.id,
          topic: runtime.store.state.topic,
          status: runtime.store.state.status,
        })),
        saved,
        questions: (current?.store.state.questions ?? []).map((question) => ({
          id: question.id,
          title: question.title,
          options: question.options,
          multiSelect: question.multiSelect,
        })),
      });
    },
    handler: async (args, ctx) => {
      if (ctx.agent.kind === "sub")
        throw new Error("Use /grill in the main session.");
      const command = args.trim();
      projectDir = ctx.cwd;
      if (!command) {
        ctx.ui.notify(commandHelp(), "info");
        return;
      }
      if (command === "questions") {
        const questions = owned(ctx).store.state.questions;
        ctx.ui.notify(questions.length
          ? questions.map((question) =>
              `${question.id} [${question.status}] ${question.title}${question.multiSelect ? " · Select all that apply (comma-separated IDs)" : ""}${question.options.length ? `\n${question.options.map((option) => `  ${option.id}: ${option.label}`).join("\n")}` : "\n  Free text: answer <id> -- <text>"}`
            ).join("\n\n")
          : "The agent has not published questions yet.", "info");
        return;
      }
      if (/^(answer|reply)(?:\s|$)/.test(command)) {
        const runtime = owned(ctx);
        const answer = /^answer\s+(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(command);
        const reply = /^reply\s+(\S+)\s+([\s\S]+)$/.exec(command);
        if (!answer && !reply)
          throw new Error("Use answer <question-id> <option-id[,option-id]> [note], answer <question-id> -- <text>, or reply <question-id> <text>.");
        const submission = answer
          ? runtime.store.submit([{
              type: "answer",
              q: answer[1],
              ...(answer[2] === "--"
                ? { text: answer[3] ?? "" }
                : { ...(runtime.store.state.questions.find((question) => question.id === answer[1])?.multiSelect ? { options: answer[2].split(",") } : { option: answer[2] }), ...(answer[3] ? { text: answer[3] } : {}) }),
            }])
          : runtime.store.submit([{ type: "thread", q: reply![1], text: reply![2] }]);
        await wake(runtime, submission);
        ctx.ui.notify(`Submitted ${answer ? "answer" : "message"} to the agent. Continue in the browser or terminal.`, "info");
        return;
      }
      if (command === "sessions") {
        const sessions = listSessions(grillHome(), ctx.cwd);
        if (!sessions.length) {
          ctx.ui.notify("No saved grills for this project.", "info");
          return;
        }
        ctx.ui.notify(
          sessions
            .map(
              (s) =>
                `${s.topic} — ${s.status} · ${s.answered} answered · ${s.open} open · ${s.id}`,
            )
            .join("\n"),
          "info",
        );
        return;
      }
      if (command === "config" || command.startsWith("config ")) {
        await configure(ctx, command);
        return;
      }
      if (command === "use" || command.startsWith("use ")) {
        const query = command === "use" ? "" : command.slice(4).trim();
        if (!query) throw new Error(attached.size ? "Which grill? /grill use <id>." : "No grill is open. Start one with /grill <topic>.");
        const runtime = findAttached(query);
        if (!runtime) throw new Error(attached.size ? "No open grill matches that id." : "No grill is open. Start one with /grill <topic>.");
        select(runtime);
        status();
        ctx.ui.notify(
          `Selected ${runtime.store.state.topic} · ${runtime.store.state.id.slice(0, 8)}.`,
          "info",
        );
        return;
      }
      if (command === "history" || command.startsWith("history ")) {
        const query = command === "history" ? "" : command.slice(8).trim();
        const finished = listSessions(grillHome(), ctx.cwd).filter(
          (s) => s.status === "finished",
        );
        if (!finished.length) {
          ctx.ui.notify("No finished grills yet.", "info");
          return;
        }
        const matches = query
          ? finished.filter((session) => session.id.startsWith(query) || session.topic === query)
          : finished;
        if (query && matches.length !== 1)
          throw new Error(matches.length ? "That matches more than one finished grill." : "No finished grill matches that id.");
        let picked = matches[0];
        if (!query) {
          const labels = finished.map((s) => `${s.topic} · ${s.id.slice(0, 8)}`);
          const label = await ctx.ui.select(
            "Open which finished grill?",
            finished.map((s, index) => ({
              label: labels[index],
              description: `${s.answered} answered`,
            })),
          );
          if (!label) return;
          picked = finished[labels.indexOf(label)];
        }
        if (!picked) return;
        const already = [...attached.values()].find(
          (runtime) => runtime.store.dir === picked.dir,
        );
        if (already?.server) {
          select(already);
          status();
          notifyUrl(ctx, already.server.url, already);
          return;
        }
        const owner = ctx.sessionManager.getSessionId();
        const store =
          picked.owner === owner
            ? loadStore(picked.dir, owner)
            : resumeStore(picked.dir, owner);
        if (store.state.status !== "finished")
          throw new Error("That grill is not finished.");
        const runtime: Runtime = { store, owner, ctx };
        select(runtime);
        const url = await serve(runtime);
        notifyUrl(ctx, url, runtime);
        status();
        return;
      }
      if (command === "pause") {
        const runtime = owned(ctx);
        const topic = runtime.store.state.topic;
        await closeOne(runtime.store.state.id, true);
        ctx.ui.notify(
          `${topic} paused. Other open grills stay up. /grill resume opens it again.`,
          "info",
        );
        return;
      }
      if (command === "finish") {
        const runtime = owned(ctx);
        const report = finishRuntime(runtime);
        await syncTools();
        status();
        ctx.ui.notify(`Grill finished: ${report}`, "info");
        return;
      }
      if (command === "export" || command.startsWith("export ")) {
        const runtime = owned(ctx);
        const rest = command === "export" ? "" : command.slice(7).trim();
        const words = rest.split(/\s+/).filter(Boolean);
        const force = words.includes("--force");
        const [word = "", ...tail] = words.filter((item) => item !== "--force");
        const kind = (word || "report") as ExportKind;
        if (!(EXPORT_KINDS as readonly string[]).includes(kind))
          throw new Error(`Unknown export kind. Use ${EXPORT_KINDS.join(", ")}.`);
        if (runtime.store.state.status !== "finished")
          throw new Error("Export needs a finished grill. Run /grill finish first.");
        const target = tail.join(" ") || EXPORT_DEFAULTS[kind];
        const written = runtime.store.exportArtifact(kind, target, force);
        const hint = kind === "beads" ? `\nApply it with: bd create --graph ${written[0]}` : "";
        ctx.ui.notify(`Exported ${kind}: ${written.join(", ")}${hint}`, "info");
        return;
      }
      if (command === "url") {
        const runtime = owned(ctx);
        if (!runtime.server)
          throw new Error("Grill is paused. Run /grill resume.");
        notifyUrl(ctx, runtime.server.url);
        return;
      }
      if (command === "resume" || command.startsWith("resume ")) {
        const query = command === "resume" ? "" : command.slice(7).trim();
        const resumable = listSessions(grillHome(), ctx.cwd).filter(
          (session) => session.status === "paused" || session.status === "error",
        );
        let picked: Runtime | undefined;
        if (query) {
          const matches = resumable.filter(
            (session) => session.id.startsWith(query) || session.topic === query,
          );
          if (matches.length !== 1)
            throw new Error(matches.length ? "That matches more than one paused grill." : "No paused grill matches that id.");
          picked = resumeRuntime(matches[0]!, ctx);
        } else {
          const current = runtimeOf(currentId);
          if (current?.store.state.status === "error")
            picked = current;
          else if (!attached.size) {
            const entry = [...ctx.sessionManager.getBranch()].reverse().find(
              (entry) => entry.type === "custom" && entry.customType === ENTRY,
            );
            if (entry?.type === "custom" && entry.data && typeof entry.data === "object" && "dir" in entry.data) {
              const dir = entry.data.dir;
              if (typeof dir === "string") {
                const session = resumable.find((session) => session.dir === dir);
                if (session) picked = resumeRuntime(session, ctx);
              }
            }
          }
        }
        if (!picked) {
          if (!resumable.length) throw new Error("No paused grills.");
          if (resumable.length === 1) picked = resumeRuntime(resumable[0]!, ctx);
          else {
            const labels = resumable.map((session) => `${session.topic} · ${session.id.slice(0, 8)}`);
            const label = await ctx.ui.select(
              "Resume which grill?",
              resumable.map((session, index) => ({
                label: labels[index],
                description: `${session.status} · ${session.answered} answered · ${session.open} open`,
              })),
            );
            if (!label) return;
            const chosen = resumable[labels.indexOf(label)];
            if (!chosen) return;
            picked = resumeRuntime(chosen, ctx);
          }
        }
        select(picked);
        picked.ctx = ctx;
        picked.store.setStatus(picked.store.state.pending ? "working" : "waiting");
        const url = await serve(picked);
        await syncTools();
        notifyUrl(ctx, url, picked);
        if (picked.store.state.pending)
          await wake(picked, picked.store.state.pending);
        else if (!picked.store.state.questions.length) {
          picked.store.setStatus("working");
          startTurn(picked);
        }
        status();
        return;
      }
      if (command === "tui" || command.startsWith("tui ")) {
        const topic = command === "tui" ? "" : command.slice(4).trim();
        if (topic === "off") {
          expanded = false;
          syncWidget(ctx);
          ctx.ui.notify("Session interview closed. The grill stays open.", "info");
          return;
        }
        if (topic) startTurn(await start(topic, ctx));
        await openTui(ctx);
        return;
      }
      if (command === "fork" || command.startsWith("fork ")) {
        const query = command === "fork" ? "" : command.slice(5).trim();
        const done = listSessions(grillHome(), ctx.cwd).filter((s) => s.status === "finished");
        if (!done.length) throw new Error("No finished grills to fork.");
        let source = query
          ? done.find((s) => s.id.startsWith(query) || s.topic === query)
          : undefined;
        if (!source) {
          if (!query && done.length === 1) source = done[0];
          else {
            const labels = done.map((s) => `${s.topic} · ${s.id.slice(0, 8)}`);
            const label = await ctx.ui.select(
              "Fork which grill's context?",
              done.map((s, index) => ({ label: labels[index]! })),
            );
            if (!label) return;
            source = done[labels.indexOf(label)];
            if (!source) return;
          }
        }
        const prior = readContext(source.dir);
        const runtime = await start(`${source.topic} (fork)`, ctx, prior);
        ctx.ui.notify(`Carried ${prior.terms.length} terms, ${prior.facts.length} facts, ${prior.risks.length} risks from ${source.topic}.`, "info");
        startTurn(runtime);
        return;
      }
      startTurn(await start(command, ctx));
    },
  });

  pi.registerTool({
    name: "grill_publish",
    defaultInactive: true,
    label: "Grill questions",
    description:
      "Publish compact questions/replies, then end the turn without a chat recap. Use id for an existing grill; topic only starts a new interview. Omit handled at startup; otherwise copy the pending submission's positive seq. Use grill_state only after context loss. Never generate UI files.",
    approval: "write",
    parameters: schemas.publish,
    renderCall(params, options) {
      if (options.expanded) return new Text(JSON.stringify(params, null, 2), 0, 0);
      const patch = params as Publish & { id?: string };
      const parts = [
        patch.questions?.length ? `${patch.questions.length} questions` : "",
        patch.replies?.length ? `${patch.replies.length} replies` : "",
        patch.explorations?.length ? `${patch.explorations.length} explorations` : "",
        patch.diagram ? "diagram" : "",
        patch.prototype ? "prototype" : "",
        patch.handled !== undefined ? `ack ${patch.handled}` : "",
      ].filter(Boolean);
      return new Text(`Grill · ${parts.join(" · ") || "update"}${patch.id ? ` · ${patch.id.slice(0, 8)}` : ""}`, 0, 0);
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      // OMP validates the injected schema, whose compatibility types infer unknown.
      const { topic, id, ...patch } = params as Publish & { topic?: string; id?: string };
      if (id) {
        const runtime = findAttached(id);
        if (!runtime) throw new Error(`No open grill matches ${id}.`);
        select(runtime);
      } else if (topic !== undefined) {
        const matches = [...attached.values()].filter(
          (runtime) =>
            runtime.store.state.status !== "finished" &&
            runtime.store.state.topic === topic,
        );
        if (matches.length > 1)
          throw new Error("Several open grills share that topic. Pass id.");
        if (matches.length === 1) select(matches[0]);
        else {
          if (!allowAgentStart)
            throw new Error("Start an interview with /grill <topic>.");
          if (!patch.questions?.length)
            throw new Error("Starting a grill requires its first questions.");
          await start(topic, ctx);
        }
      }
      const { store } = owned(ctx);
      const firstPublish = store.state.questions.length === 0;
      store.publish(patch);
      if (firstPublish && store.state.questions.length) owned(ctx).showReadyUrl = true;
      status();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              published: patch.questions?.length || 0,
              ...(patch.handled !== undefined ? { handled: store.state.handled } : {}),
              open: store.state.questions
                .filter((q) => q.status === "open")
                .map((q) => q.id),
            }),
          },
        ],
        details: {},
      };
    },
  });
  pi.registerTool({
    name: "grill_state",
    defaultInactive: true,
    label: "Grill decisions",
    description:
      "Read compact decisions, open questions and pending batch after context loss. No HTML or full state replay.",
    approval: "read",
    parameters: z.object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      return {
        content: [{ type: "text", text: compactState(owned(ctx).store.state) }],
        details: {},
      };
    },
  });

  pi.registerMessageRenderer<{ summary: string }>("omp-grill.submission", (message, options, theme) =>
    new Text(options.expanded
      ? (typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2))
      : theme.fg("accent", message.details?.summary ?? "Grill submission"), 0, 0));
  pi.registerMessageRenderer<{ title: string; url: string }>("omp-grill.ready", (message, _options, theme) =>
    new Text(`${theme.fg("success", `Grill ready · ${message.details?.title ?? ""}`)}\n${message.details?.url ?? ""}`, 0, 0));
  pi.registerShortcut("ctrl+alt+g", {
    description: "Expand Grill status and private URL",
    handler(ctx) {
      if (ctx.agent.kind === "sub" || !runtimeOf(currentId)) return;
      expanded = !expanded;
      syncWidget(ctx);
    },
  });
  pi.on("session_start", async () => {
    ({ allowAgentStart } = await readServerSettings(grillHome()));
    await syncTools();
  });
  pi.on("before_agent_start", async (event, ctx) => {
    await syncTools();
    if (ctx.agent.kind === "sub") return;
    let working = false;
    for (const runtime of attached.values()) {
      if (!runtime.specialist && runtime.owner === ctx.sessionManager.getSessionId() && runtime.store.state.status === "working") {
        runningBatches.set(runtime.store.state.id, runtime.store.state.pending?.seq ?? 0);
        working = true;
      }
    }
    if (!working) return;
    return { systemPrompt: [...event.systemPrompt, instruction] };
  });
  pi.on("agent_end", (_event, ctx) => {
    if (ctx.agent.kind === "sub" || ctx.hasPendingMessages()) return;
    for (const [id, seq] of runningBatches) {
      const runtime = attached.get(id);
      if (!runtime || runtime.owner !== ctx.sessionManager.getSessionId()) continue;
      if (runtime.specialist) continue;
      if (runtime.store.state.status === "working" && (runtime.store.state.pending?.seq ?? 0) === seq)
        runtime.store.setStatus(
          "error",
          "Agent stopped without publishing. Use /grill resume to retry the saved batch.",
        );
      runningBatches.delete(id);
    }
    for (const runtime of attached.values()) {
      if (!runtime.showReadyUrl || !runtime.server || runtime.owner !== ctx.sessionManager.getSessionId()) continue;
      runtime.showReadyUrl = false;
      pi.sendMessage({
        customType: "omp-grill.ready",
        content: "Grill questions are ready.",
        details: { title: grillWidgetTitle(runtime.store.state), url: runtime.server.url },
        display: true,
      }, { triggerTurn: false, deliverAs: "aside" });
      notifyUrl(ctx, runtime.server.url, runtime);
    }
    status();
  });
  pi.on("session_switch", async () => {
    await closeAll();
  });
  pi.on("session_branch", async () => {
    await closeAll();
  });
  pi.on("session_tree", async () => {
    await closeAll();
  });
  pi.on("session_shutdown", async () => {
    await closeAll();
  });
}
