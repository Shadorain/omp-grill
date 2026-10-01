import { homedir } from "node:os";
import { join } from "node:path";
 import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
 import { grillCompletions } from "./completions.ts";
 import {
   createStore,
   loadStore,
   compactState,
   compactSubmission,
 } from "./store.ts";
 import { startServer } from "./server.ts";
 import { listSessions, resumeStore } from "./sessions.ts";
 import { createGrillInspector, createGrillWidget, type GrillTheme } from "./tui.ts";
 import type { Action, GrillServer, Publish, Store } from "./types.ts";
import { readServerSettings } from "./settings.ts";

function grillHome() {
  return process.env.OMP_GRILL_HOME || join(homedir(), ".omp", "grill");
}

const ENTRY = "omp-grill.session";
const instruction = `The extension owns the interview UI, durable state, event delivery, prototype interactions and reports. Never generate UI files, session JSON, polling scripts, HTML, CSS or JavaScript. Publish compact structured data, then end your turn; explicit browser sends wake this session.

Publish 1-3 independent frontier questions through grill_publish. Include topic only when starting a user-requested interview. Each question has a stable id, short consequential title/body, 2-4 options {id,label}, and recommendation {option,reason} naming the real tradeoff. Free-text-only questions use empty options and omit the recommended option. dependsOn names answered prerequisites. Mark durable only when hard to reverse, surprising without context, and a real tradeoff. Record verified vocabulary, facts and risks in context {terms,facts,risks,intent}; never claim facts you did not verify.

Challenge assumptions, outcomes, failure cases and tradeoffs. Research code/docs instead of asking the user for facts. Do not seek confirmation for routine implementation choices or reopen settled decisions without a conflict. Do not implement the topic during the interview.

Browser and terminal answers are already persisted. Reply using replies:[{q,text}]. Explicit Explore requests use explorations:[{q,rows:[{option,pros,cons}]}], with specific honest pros and cons for every option. Visualize actions name kind: diagram or prototype. Diagram requests use diagram {title,kind,nodes,edges} plus diagramReply. Prototype requests use prototype {title,start,app,theme,screens} plus prototypeReply. Research the existing app's route, chrome and theme before representing an existing-app change. Screens contain native blocks (heading,text,button,input,select,checkbox,table,list,card,dialog); buttons use action {type:navigate|set|toggle|open|close|submit,target,value?}. Use real screen/component IDs, meaningful clickable flows and local form state. No arbitrary code, fake backends or model requests for prototype clicks. Nest card/dialog children no deeper than three block levels. Regenerate and visual-feedback explicitly require an updated artifact reflecting all current settled decisions and feedback, not just a reply. Preserve settled answers; if feedback conflicts, explain the conflict in that question's thread and request a user decision. Ordinary answer turns never redraw visuals. Publish replies, artifacts and any next frontier in one call, with handled equal to incoming sequence. Always acknowledge the batch. Once consequential branches settle, add no filler questions; direct the user to Finish.

For unresolved choices, draw from the recommendation and label the result assumed inside the artifact; never imply user approval. Prototype form labels and text can include {{component-id}} to display local input state. Prototype value and options are strings; checkbox value is "true" or "false". A list uses options for its items. Renderer state is ephemeral; never promise production persistence or network integration.

 Use grill_state only for context recovery; it omits full historical discussion. Finish is a native zero-model operation. Finish records known decisions, not an invented build specification. Prefer a diagram unless the topic is a user-facing screen. Diagram kind is architecture, flow, sequence, or state. Do not invent a prototype for APIs, data, policy, or process topics. When no consequential question remains, set note to one sentence saying the interview can finish. Do not invent further questions to fill the page. Several grills may be open. A browser wake includes id. Pass that id to grill_publish. Do not write one grill's answers onto another.`;

export default function grillExtension(pi: ExtensionAPI) {
  const z = pi.zod;
  const prototypeFields = {
    id: z.string(),
    kind: z.enum(["heading", "text", "button", "input", "select", "checkbox", "table", "list", "card", "dialog"]),
    label: z.string().optional(),
    text: z.string().optional(),
    value: z.string().optional(),
    options: z.array(z.string()).optional(),
    columns: z.array(z.string()).optional(),
    rows: z.array(z.array(z.string())).optional(),
    action: z.object({
      type: z.enum(["navigate", "set", "toggle", "open", "close", "submit"]),
      target: z.string(),
      value: z.string().optional(),
    }).optional(),
  };
  const prototypeLeaf = z.object(prototypeFields);
  const prototypeGroup = z.object({
    ...prototypeFields,
    children: z.array(prototypeLeaf).optional(),
  });
  const prototypeBlock = z.object({
    ...prototypeFields,
    children: z.array(prototypeGroup).optional(),
  });
  type Runtime = {
    store: Store;
    owner: string;
    server?: GrillServer;
    ctx: ExtensionContext;
  };
  const attached = new Map<string, Runtime>();
   let currentId: string | undefined;
   let runningBatch: { id: string; seq: number } | undefined;
   let projectDir = process.cwd();
   let tuiMode = false;
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
  async function closeOne(id: string, pause: boolean) {
    const runtime = attached.get(id);
    if (!runtime) return;
    attached.delete(id);
    if (currentId === id) currentId = attached.keys().next().value;
    if (runningBatch?.id === id) runningBatch = undefined;
    if (pause && runtime.store.state.status !== "finished")
      runtime.store.setStatus("paused");
    await runtime.server?.close();
    await syncTools();
    if (attached.size) status();
    else {
      tuiMode = false;
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
    const answered = store.state.questions.filter(
      (q) => q.status === "answered",
    ).length;
    const prefix = attached.size > 1 ? `grills ${attached.size} · ` : "grill ";
    ctx.ui.setStatus(
      "omp-grill",
      `${prefix}${store.state.topic} · ${answered}/${store.state.questions.length} · ${store.state.status}`,
    );
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
        select(runtime);
        runningBatch = { id: runtime.store.state.id, seq: submission.seq };
        pi.sendUserMessage(compactSubmission(runtime.store.state, submission), {
          deliverAs: "followUp",
        });
        status();
      },
    });
    status();
    return runtime.server.url;
  }
  function notifyUrl(ctx: ExtensionContext, url: string, runtime?: Runtime) {
    const name = runtime
      ? `${runtime.store.state.topic} · ${runtime.store.state.id.slice(0, 8)}\n`
      : "";
    ctx.ui.notify(
      `Grill ${name}${url}\nKeep the full URL private. HTTP is unencrypted; use a trusted network or SSH tunnel.`,
      "info",
    );
  }
  async function start(topic: string, ctx: ExtensionContext) {
    if (ctx.agent.kind === "sub")
      throw new Error("Grills belong to the main OMP session.");
    const owner = ctx.sessionManager.getSessionId();
    const store = createStore({
      home: grillHome(),
      owner,
      project: ctx.cwd,
      topic,
    });
    const runtime: Runtime = { store, owner, ctx };
    select(runtime);
    pi.appendEntry(ENTRY, { dir: store.dir });
    const url = await serve(runtime);
    await syncTools();
    store.setStatus("working");
    status();
    notifyUrl(ctx, url, runtime);
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
                        record an option on the selected grill
/grill answer <id> -- <text>
                        free-text answer on the selected grill
/grill reply <id> <text>
                        message the agent about a question
/grill pause            pause the selected grill; others stay up
/grill resume           open a paused or errored grill alongside the others
/grill history          open a finished grill's locked page alongside the others
/grill sessions         list saved grills for this project
 /grill finish           finish the selected grill and write report.md
 /grill tui [topic|off]  open this interview in the session terminal`;
  }
  function syncWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (!tuiMode || !runtimeOf(currentId)) {
      ctx.ui.setWidget("omp-grill", undefined);
      return;
    }
    ctx.ui.setWidget(
      "omp-grill",
      (_tui, theme) => createGrillWidget(() => runtimeOf(currentId)?.store.state, theme as GrillTheme),
      { placement: "aboveEditor" },
    );
  }
  function stageDraft(runtime: Runtime, questionId: string, optionId: string) {
    const state = runtime.store.state;
    const question = state.questions.find((item) => item.id === questionId);
    if (!question || state.status === "finished") return;
    const draft = state.drafts.answers[questionId];
    const base = { ...(question.answer ?? {}), ...(draft ?? {}) };
    const option = base.option === optionId ? undefined : optionId;
    const text = base.text?.trim();
    const same = (option || "") === (question.answer?.option || "") && (text || "") === (question.answer?.text || "");
    runtime.store.saveDrafts({
      revision: state.drafts.revision,
      answers: {
        [questionId]: same || (!option && !text) ? null : { ...(option ? { option } : {}), ...(text ? { text } : {}) },
      },
    });
  }
  function draftActions(runtime: Runtime): Action[] {
    const actions: Action[] = [];
    for (const question of runtime.store.state.questions) {
      const draft = runtime.store.state.drafts.answers[question.id];
      const text = draft?.text?.trim();
      if (draft?.option || text)
        actions.push({
          type: "answer",
          q: question.id,
          ...(draft?.option ? { option: draft.option } : {}),
          ...(text ? { text } : {}),
        });
      const message = runtime.store.state.drafts.threads[question.id]?.trim();
      if (message) actions.push({ type: "thread", q: question.id, text: message });
    }
    return actions;
  }
  function wake(runtime: Runtime, submission: { seq: number; actions: Action[] }) {
    select(runtime);
    runningBatch = { id: runtime.store.state.id, seq: submission.seq };
    pi.sendUserMessage(compactSubmission(runtime.store.state, submission), {
      deliverAs: "followUp",
    });
    status();
  }
  function sendDrafts(runtime: Runtime) {
    const actions = draftActions(runtime);
    if (!actions.length) return false;
    wake(runtime, runtime.store.submit(actions, { draftRevision: runtime.store.state.drafts.revision }));
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
  async function openTui(ctx: ExtensionContext) {
    if (!ctx.hasUI) throw new Error("Session TUI needs the interactive terminal.");
    owned(ctx);
    tuiMode = true;
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
          defer: (questionId) => {
            const current = runtimeOf(currentId);
            if (!current) return;
            wake(current, current.store.submit([{ type: "defer", q: questionId }]));
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
              `${question.id} [${question.status}] ${question.title}${question.options.length ? `\n${question.options.map((option) => `  ${option.id}: ${option.label}`).join("\n")}` : "\n  Free text: answer <id> -- <text>"}`
            ).join("\n\n")
          : "The agent has not published questions yet.", "info");
        return;
      }
      if (/^(answer|reply)(?:\s|$)/.test(command)) {
        const runtime = owned(ctx);
        const answer = /^answer\s+(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(command);
        const reply = /^reply\s+(\S+)\s+([\s\S]+)$/.exec(command);
        if (!answer && !reply)
          throw new Error("Use answer <question-id> <option-id> [note], answer <question-id> -- <text>, or reply <question-id> <text>.");
        const submission = answer
          ? runtime.store.submit([{
              type: "answer",
              q: answer[1],
              ...(answer[2] === "--"
                ? { text: answer[3] ?? "" }
                : { option: answer[2], ...(answer[3] ? { text: answer[3] } : {}) }),
            }])
          : runtime.store.submit([{ type: "thread", q: reply![1], text: reply![2] }]);
        pi.sendUserMessage(compactSubmission(runtime.store.state, submission), {
          deliverAs: "followUp",
        });
        status();
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
        if (runtime.store.state.pending)
          throw new Error(
            "A submission still needs acknowledgement. Resume it before finishing.",
          );
        const actions: Action[] = [];
        const snapshot = runtime.store.state;
        for (const question of snapshot.questions) {
          const draft = snapshot.drafts.answers[question.id];
          const text = draft?.text?.trim();
          if (draft?.option || text)
            actions.push({
              type: "answer",
              q: question.id,
              ...(draft?.option ? { option: draft.option } : {}),
              ...(text ? { text } : {}),
            });
          const message = snapshot.drafts.threads[question.id]?.trim();
          if (message)
            actions.push({ type: "thread", q: question.id, text: message });
        }
        if (actions.length)
          runtime.store.submit([...actions, { type: "finish" }], {
            draftRevision: snapshot.drafts.revision,
          });
        const report = runtime.store.finish();
        await syncTools();
        status();
        ctx.ui.notify(`Grill finished: ${report}`, "info");
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
        const owner = ctx.sessionManager.getSessionId();
        let picked: Runtime | undefined;
        if (query) {
          const matches = listSessions(grillHome(), ctx.cwd).filter(
            (session) =>
              (session.status === "paused" || session.status === "error") &&
              (session.id.startsWith(query) || session.topic === query),
          );
          if (matches.length !== 1)
            throw new Error(matches.length ? "That matches more than one paused grill." : "No paused grill matches that id.");
          const chosen = matches[0];
          if (!chosen) return;
          picked = {
            store: chosen.owner === owner ? loadStore(chosen.dir, owner) : resumeStore(chosen.dir, owner),
            owner,
            ctx,
          };
        } else if (!attached.size) {
          const entries = ctx.sessionManager.getBranch();
          const entry = [...entries]
            .reverse()
            .find((e) => e.type === "custom" && e.customType === ENTRY);
          if (entry?.type === "custom" && entry.data) {
            const data = entry.data;
            if (
              typeof data === "object" &&
              "dir" in data &&
              typeof data.dir === "string"
            ) {
              const summary = listSessions(grillHome(), ctx.cwd).find(
                (s) => s.dir === data.dir,
              );
              const store =
                !summary || summary.owner === owner
                  ? loadStore(data.dir, owner)
                  : resumeStore(data.dir, owner);
              picked = { store, owner, ctx };
            }
          }
        }
        if (!picked) {
          const resumable = listSessions(grillHome(), ctx.cwd).filter(
            (s) =>
              (s.status === "paused" || s.status === "error") &&
              ![...attached.values()].some((runtime) => runtime.store.dir === s.dir),
          );
          if (!resumable.length)
            throw new Error("No paused grills.");
          const labels = resumable.map((s) => `${s.topic} · ${s.id.slice(0, 8)}`);
          const label = await ctx.ui.select(
            "Resume which grill?",
            resumable.map((s, index) => ({
              label: labels[index],
              description: `${s.status} · ${s.answered} answered · ${s.open} open`,
            })),
          );
          if (!label) return;
          const chosen = resumable[labels.indexOf(label)];
          if (!chosen) return;
          picked = {
            store:
              chosen.owner === owner
                ? loadStore(chosen.dir, owner)
                : resumeStore(chosen.dir, owner),
            owner,
            ctx,
          };
        }
        select(picked);
        picked.ctx = ctx;
        if (picked.store.state.status !== "finished")
          picked.store.setStatus(
            picked.store.state.pending ? "working" : "waiting",
          );
        const url = await serve(picked);
        await syncTools();
        notifyUrl(ctx, url, picked);
        if (picked.store.state.pending) {
          runningBatch = {
            id: picked.store.state.id,
            seq: picked.store.state.pending.seq,
          };
          pi.sendUserMessage(
            compactSubmission(picked.store.state, picked.store.state.pending),
            { deliverAs: "followUp" },
          );
        } else if (
          !picked.store.state.questions.length &&
          picked.store.state.status !== "finished"
        ) {
          picked.store.setStatus("working");
          pi.sendMessage(
            {
              customType: "omp-grill.start",
              content: `Start grill ${picked.store.state.id} for ${JSON.stringify(picked.store.state.topic)}. Call grill_publish with the first frontier and that id.`,
              display: true,
              attribution: "agent",
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        }
        status();
        return;
      }
      if (command === "tui" || command.startsWith("tui ")) {
        const topic = command === "tui" ? "" : command.slice(4).trim();
        if (topic === "off") {
          tuiMode = false;
          syncWidget(ctx);
          ctx.ui.notify("Session interview closed. The grill stays open.", "info");
          return;
        }
        if (topic) await start(topic, ctx);
        await openTui(ctx);
        return;
      }
      await start(command, ctx);
      pi.sendMessage(
        {
          customType: "omp-grill.start",
          content: `Start grill for ${JSON.stringify(command)}. Call grill_publish with topic and the first frontier. Other open grills stay open.`,
          display: true,
          attribution: "agent",
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  });

  pi.registerTool({
    name: "grill_publish",
    defaultInactive: true,
    label: "Grill questions",
    description:
      "Start another interview with topic and 1-3 questions, or publish to the grill named by id. Several grills may be open. Acknowledge browser batches with handled. Never generate UI files.",
    approval: "write",
    parameters: z.object({
      topic: z.string().optional(),
      id: z.string().optional(),
      handled: z.number().optional(),
      questions: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            body: z.string().optional(),
            options: z.array(z.object({ id: z.string(), label: z.string() })),
            recommendation: z.object({
              option: z.string().optional(),
              reason: z.string(),
            }),
            dependsOn: z.array(z.string()).optional(),
            durable: z.boolean().optional(),
          }),
        )
        .optional(),
      replies: z
        .array(z.object({ q: z.string(), text: z.string() }))
        .optional(),
      explorations: z
        .array(
          z.object({
            q: z.string(),
            rows: z.array(
              z.object({
                option: z.string(),
                pros: z.array(z.string()),
                cons: z.array(z.string()),
              }),
            ),
          }),
        )
        .optional(),
      note: z.string().optional(),
      context: z
        .object({
          intent: z.string().optional(),
          docPath: z.string().optional(),
          terms: z
            .array(
              z.object({
                term: z.string(),
                definition: z.string(),
                avoid: z.array(z.string()).optional(),
              }),
            )
            .optional(),
          facts: z
            .array(
              z.object({
                id: z.string(),
                text: z.string(),
                source: z.string(),
              }),
            )
            .optional(),
          risks: z
            .array(
              z.object({
                id: z.string(),
                text: z.string(),
                mitigation: z.string().optional(),
              }),
            )
            .optional(),
        })
        .optional(),
      diagram: z
        .object({
          title: z.string(),
          kind: z.enum(["architecture", "flow", "sequence", "state"]),
          nodes: z.array(
            z.object({
              id: z.string(),
              label: z.string(),
              detail: z.string().optional(),
            }),
          ),
          edges: z.array(
            z.object({
              from: z.string(),
              to: z.string(),
              label: z.string().optional(),
            }),
          ),
        })
        .optional(),
      diagramReply: z.string().optional(),
      prototype: z.object({
        title: z.string(),
        start: z.string(),
        app: z.object({
          name: z.string(),
          route: z.string().optional(),
          chrome: z.array(z.string()).optional(),
        }).optional(),
        theme: z.object({
          background: z.string().optional(),
          surface: z.string().optional(),
          text: z.string().optional(),
          accent: z.string().optional(),
          radius: z.number().optional(),
          font: z.enum(["sans", "serif", "mono"]).optional(),
        }).optional(),
        screens: z.array(z.object({
          id: z.string(),
          title: z.string(),
          layout: z.enum(["dashboard", "split", "form", "content"]).optional(),
          blocks: z.array(prototypeBlock),
        })),
      }).optional(),
      prototypeReply: z.string().optional(),
    }),
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
      store.publish(patch);
      status();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              published: patch.questions?.length || 0,
              handled: store.state.handled,
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

  pi.on("session_start", async () => {
    ({ allowAgentStart } = await readServerSettings(grillHome()));
    await syncTools();
  });
  pi.on("before_agent_start", async (event, ctx) => {
    await syncTools();
    const runtime = runtimeOf(currentId);
    if (
      ctx.agent.kind === "sub" ||
      !runtime ||
      runtime.owner !== ctx.sessionManager.getSessionId() ||
      runtime.store.state.status !== "working"
    )
      return;
    if (!runningBatch || runningBatch.id !== runtime.store.state.id)
      runningBatch = {
        id: runtime.store.state.id,
        seq: runtime.store.state.pending?.seq ?? 0,
      };
    return { systemPrompt: [...event.systemPrompt, instruction] };
  });
  pi.on("agent_end", (_event, ctx) => {
    const runtime = runningBatch ? attached.get(runningBatch.id) : undefined;
    if (
      ctx.agent.kind === "sub" ||
      !runtime ||
      runtime.owner !== ctx.sessionManager.getSessionId()
    )
      return;
    const ownsBatch =
      (runtime.store.state.pending?.seq ?? 0) === runningBatch?.seq;
    if (
      ownsBatch &&
      runtime.store.state.status === "working" &&
      !ctx.hasPendingMessages()
    )
      runtime.store.setStatus(
        "error",
        "Agent stopped without publishing. Use /grill resume to retry the saved batch.",
      );
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
