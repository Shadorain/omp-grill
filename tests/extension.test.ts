import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import grillExtension from "../src/extension";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(allowAgentStart?: boolean, modelRegistry?: Pick<ExtensionContext["modelRegistry"], "find" | "resolver" | "resolveModelHeaders">) {
  const home = mkdtempSync(join(tmpdir(), "omp-grill-extension-"));
  const previousHome = process.env.OMP_GRILL_HOME;
  process.env.OMP_GRILL_HOME = home;
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    host: "127.0.0.1", ...(allowAgentStart === undefined ? {} : { allowAgentStart }),
  }));
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const entries: any[] = [];
  let active = ["read"];
  let command: any;
  let queued = false;
  const urls: string[] = [];
  let inspector: { handleInput(data: string): void; render(width: number): string[] } | undefined;
  const notices: string[] = [];
  const messages: any[] = [];
  const handoffs = new EventTarget();

  const pi = {
    zod: z,
    registerTool(tool: any) {
      tools.set(tool.name, tool);
      if (!tool.defaultInactive) active.push(tool.name);
    },
    registerCommand(_name: string, value: any) { command = value; },
    on(name: string, handler: any) { events.set(name, handler); },
    registerMessageRenderer(_kind: string, _renderer: unknown) {},
    registerShortcut(_key: string, _options: unknown) {},
    getActiveTools: () => [...active],
    async setActiveTools(names: string[]) { active = names; },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    sendMessage(message: unknown) {
      messages.push(message);
      if (message && typeof message === "object" && "customType" in message && message.customType === "omp-grill.submission")
        handoffs.dispatchEvent(new Event("submission"));

    },
    sendUserMessage() {},
  };
  const ctx = {
    cwd: "/demo",
    hasUI: false,
    agent: { kind: "main" },
    modelRegistry,
    hasPendingMessages: () => queued,
    sessionManager: { getSessionId: () => "test-owner", getBranch: () => entries },
    ui: {
      notify(text: string) {
        notices.push(text);
        const url = text.match(/https?:\/\/[^\s]+/)?.[0];
        if (url) urls.push(url);
      },
      setStatus() {},
      setWidget() {},
      custom(factory: any) {
        inspector = factory(
          { requestRender() {}, terminal: { rows: 50 } },
          { fg: (_tone: string, text: string) => text },
          { matches: () => false },
          () => {},
        );
      },
    },
  } as unknown as ExtensionContext;
  grillExtension(pi as unknown as ExtensionAPI);
  cleanup.push(async () => {
    try { await events.get("session_shutdown")({}, ctx); }
    finally {
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.OMP_GRILL_HOME;
      else process.env.OMP_GRILL_HOME = previousHome;
    }
  });
  await events.get("session_start")({}, ctx);
  return {
    home,
    active: () => active,
    command: (args: string): Promise<void> => command.handler(args, ctx),
    publish: (params: unknown): Promise<unknown> => {
      const tool = tools.get("grill_publish");
      return tool.execute("call", tool.parameters.parse(params), undefined, undefined, ctx);
    },
    urls,
    notices,
    messages,
    event: (name: string, event = {}): Promise<unknown> => events.get(name)(event, ctx),
    setQueued(value: boolean) { queued = value; },
    async inspector() {
      (ctx as { hasUI: boolean }).hasUI = true;
      await command.handler("tui", ctx);
      return inspector!;
    },
    waitForSubmission: () => new Promise<void>((resolve) => handoffs.addEventListener("submission", () => resolve(), { once: true })),

  };
}

async function specialistProvider(overrides: Record<string, unknown> = {}) {
  const requests: string[] = [];
  const patches = {
    discussion: { replies: [{ q: "q1", text: "A modal preserves the board; a separate page supports deep links." }] },
    diagram: { diagram: { title: "Task creation", kind: "flow", nodes: [{ id: "board", label: "Board" }, { id: "modal", label: "Task form" }], edges: [{ from: "board", to: "modal", label: "Create" }] }, diagramReply: "Creation stays on the board." },
    prototype: { prototype: { title: "Task form", start: "board", screens: [{ id: "board", title: "Board", blocks: [{ id: "task-name", kind: "input", label: "Task name" }] }] }, prototypeReply: "Local task form preview." },
  };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const { model } = z.object({ model: z.enum(["discussion", "diagram", "prototype"]) }).parse(await req.json());
      requests.push(model);
      const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({
        id: "grill-response", object: "chat.completion.chunk", created: 1, model,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`;
      return new Response(
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "result", type: "function", function: { name: "grill_result", arguments: JSON.stringify(overrides[model] ?? patches[model]) } }] }, null)
        + chunk({}, "tool_calls") + "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  cleanup.push(async () => { server.stop(true); });
  const model = (id: string): Model<Api> => buildModel({
    id, name: id, api: "openai-completions", provider: "grill-local",
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000, maxTokens: 2048,
  });
  return {
    requests,
    registry: {
      find: (provider: string, id: string) => provider === "grill-local" && id in patches ? model(id) : undefined,
      resolver: () => async () => "local-test",
      resolveModelHeaders: async () => undefined,
    } satisfies Pick<ExtensionContext["modelRegistry"], "find" | "resolver" | "resolveModelHeaders">,
  };
}

test("configured specialist results persist, main owns question followups, and resume does not regenerate completed work", async () => {
  const provider = await specialistProvider();
  const app = await fixture(false, provider.registry);
  await app.command("config discussionModel grill-local/discussion");
  await app.command("config diagramModel grill-local/diagram");
  await app.command("config prototypeModel grill-local/prototype");
  await app.command("Task board");
  await app.publish({ questions });
  let url = app.urls.at(-1)!;
  await app.command("reply q1 Can tasks have deep links?");
  let state = await request(url);
  expect(state.questions[0].thread.at(-1).text).toBe("A modal preserves the board; a separate page supports deep links.");
  expect(state.pending.completed).toEqual(["discussion"]);
  expect(state.pending.seq).toBe(1);
  const handoff = JSON.parse(app.messages.at(-1).content);
  expect(handoff.actions).toEqual([]);
  expect(handoff.specialistResults.discussion[0].thread.at(-1).text).toBe(state.questions[0].thread.at(-1).text);
  await app.event("before_agent_start", { systemPrompt: [] });
  await app.event("agent_end");
  expect((await request(url)).status).toBe("error");
  await app.command("pause");
  await app.command("resume");
  url = app.urls.at(-1)!;
  expect(provider.requests).toEqual(["discussion"]);
  await app.publish({ handled: 1, questions: [{ ...questions[0], id: "q2", title: "Should tasks have stable shareable links?" }] });
  expect((await request(url)).questions.some((question: { id: string }) => question.id === "q2")).toBe(true);
  for (const kind of ["diagram", "prototype"] as const) {
    const delivered = app.waitForSubmission();
    const response = await request(url, "/api/send", { actions: [{ type: "visualize", kind }] });
    await delivered;
    state = await request(url);
    expect(state[kind].title).toBe(kind === "diagram" ? "Task creation" : "Task form");
    expect(state.pending.completed).toContain(kind);
    const compact = JSON.parse(app.messages.at(-1).content);
    expect(compact.actions).toEqual([]);
    expect(compact[kind]).toBeUndefined();
    await app.publish({ handled: response.seq });
  }
  expect(provider.requests).toEqual(["discussion", "diagram", "prototype"]);
  await app.command("config discussionModel main");
  await app.command("reply q1 What about navigation?");
  expect(provider.requests).toEqual(["discussion", "diagram", "prototype"]);
  expect(JSON.parse(app.messages.at(-1).content).actions).toEqual([{ type: "thread", q: "q1", text: "What about navigation?" }]);
  await app.publish({ handled: 4, replies: [{ q: "q1", text: "Main agent discussion." }] });
});

test("initial questions restore the private URL at turn end without another model turn", async () => {
  const app = await fixture();
  await app.command("Task board");
  const url = app.urls.at(-1);
  await app.publish({ questions });
  await app.event("agent_end");
  const ready = app.messages.find((message) => message.customType === "omp-grill.ready");
  expect(ready.details.url).toBe(url);
  expect((await request(url!)).status).toBe("waiting");
});

test("specialists cannot change questions and invalid output retains a retryable unacknowledged batch", async () => {
  const overrides: Record<string, unknown> = {
    discussion: { replies: [{ q: "q1", text: "Untrusted change" }], questions: [{ ...questions[0], title: "Unauthorized question" }] },
  };
  const provider = await specialistProvider(overrides);
  const app = await fixture(false, provider.registry);
  await app.command("config discussionModel grill-local/discussion");
  await app.command("Task board");
  await app.publish({ questions });
  const url = app.urls.at(-1)!;
  await app.command("reply q1 Preserve the interview");
  const failed = await request(url);
  expect(failed.status).toBe("error");
  expect(failed.pending.seq).toBe(1);
  expect(failed.pending.completed).toBeUndefined();
  expect(failed.questions[0].title).toBe(questions[0].title);
  expect(failed.questions[0].thread.map((entry: { role: string }) => entry.role)).toEqual(["user"]);
  delete overrides.discussion;
  await app.command("resume");
  expect((await request(url)).pending.completed).toEqual(["discussion"]);
  await app.publish({ handled: 1 });
  expect((await request(url)).pending).toBeUndefined();
});

test("persisted specialist completion must match pending actions and unknown explored options fail", async () => {
  const provider = await specialistProvider({
    discussion: { explorations: [{ q: "q1", rows: [
      { option: "modal", pros: ["Fast"], cons: ["Small"] },
      { option: "page", pros: ["Deep links"], cons: ["Navigation"] },
      { option: "fake", pros: ["No"], cons: ["No"] },
    ] }] },
  });
  const app = await fixture(false, provider.registry);
  await app.command("config discussionModel grill-local/discussion");
  await app.command("Task board");
  await app.publish({ questions });
  const url = app.urls.at(-1)!;
  const response = await request(url, "/api/send", { actions: [{ type: "explore", q: "q1" }] });
  expect(response.seq).toBe(1);
  let failed = await request(url);
  for (let i = 0; i < 100 && failed.status !== "error"; i += 1) {
    await Bun.sleep(20);
    failed = await request(url);
  }

  expect(failed.status).toBe("error");
  expect(failed.error).toContain("unknown option");
  expect(failed.pending.completed).toBeUndefined();


});

const questions = [{
  id: "q1", title: "Where should tasks be created?",
  options: [{ id: "modal", label: "Modal" }, { id: "page", label: "Page" }],
  recommendation: { option: "modal", reason: "Keeps the board visible." },
}];

test("multi-select command replaces the complete selection and retains notes", async () => {
  const app = await fixture();
  await app.command("Combined choices");
  await app.publish({ questions: [{ ...questions[0], multiSelect: true, recommendation: { options: ["modal", "page"], reason: "Both can coexist." } }] });
  const url = app.urls.at(-1)!;
  await app.command("answer q1 page,modal Keep both");
  let state = await request(url);
  expect(state.questions[0].answer).toEqual({ options: ["modal", "page"], text: "Keep both" });
  expect(JSON.parse(app.messages.at(-1).content).questions[0].multiSelect).toBe(true);
  await app.publish({ handled: state.pending.seq });
  await app.command("answer q1 page Only page now");
  state = await request(url);
  expect(state.questions[0].answer).toEqual({ options: ["page"], text: "Only page now" });
  expect(state.questions[0].history.at(-1).answer.options).toEqual(["modal", "page"]);
});

test("terminal multi-select toggles preserve picks through notes and cleared drafts", async () => {
  const app = await fixture();
  await app.command("Combined choices");
  await app.publish({ questions: [{ ...questions[0], multiSelect: true }] });
  const url = app.urls.at(-1)!;
  const inspector = await app.inspector();
  inspector.handleInput("a");
  inspector.handleInput("b");
  inspector.handleInput("i");
  inspector.handleInput("Keep both");
  inspector.handleInput("\r");
  expect((await request(url)).drafts.answers.q1).toEqual({ options: ["modal", "page"], text: "Keep both" });
  inspector.handleInput("\r");
  const sent = await request(url);
  expect(sent.questions[0].answer.options).toEqual(["modal", "page"]);
  await app.publish({ handled: sent.pending.seq });
  inspector.handleInput("a");
  inspector.handleInput("b");
  inspector.handleInput("i");
  for (const _ of "Keep both") inspector.handleInput("\u007f");
  inspector.handleInput("\r");
  expect((await request(url)).drafts.answers.q1).toEqual({ options: [] });
  expect(inspector.render(200).join("\n")).not.toContain("Written: Keep both");
  inspector.handleInput("i");
  inspector.handleInput("\r");
  expect((await request(url)).drafts.answers.q1).toEqual({ options: [] });
  inspector.handleInput("b");
  expect((await request(url)).drafts.answers.q1).toEqual({ options: ["page"] });
  inspector.handleInput("\r");
  expect((await request(url)).questions[0].answer).toEqual({ options: ["page"] });
});

test("command-only mode hides tools, rejects agent starts, and restores tools on resume", async () => {
  const app = await fixture();
  expect(app.active()).toEqual(["read"]);
  await expect(app.publish({ topic: "Agent start", questions })).rejects.toThrow("/grill <topic>");
  expect(readdirSync(app.home)).toEqual(["settings.json"]);

  await app.command("Task board");
  expect(app.active()).toEqual(["read", "grill_publish", "grill_state"]);
  await app.publish({ topic: "Task board", questions });
  await expect(app.publish({ topic: "Another agent start", questions })).rejects.toThrow("/grill <topic>");

  await app.command("pause");
  expect(app.active()).toEqual(["read"]);
  await app.command("resume");
  expect(app.active()).toEqual(["read", "grill_publish", "grill_state"]);
  await app.command("finish");
  expect(app.active()).toEqual(["read"]);
});

test("allowAgentStart enables natural-language starts and keeps tools available afterward", async () => {
  const app = await fixture(true);
  expect(app.active()).toEqual(["read", "grill_publish", "grill_state"]);
  await app.publish({ topic: "Agent start", questions });
  await app.command("finish");
  expect(app.active()).toEqual(["read", "grill_publish", "grill_state"]);
});

test("pausing one interview keeps tools active for another open interview", async () => {
  const app = await fixture(false);
  await app.command("First");
  await app.publish({ topic: "First", questions });
  await app.command("Second");
  await app.publish({ topic: "Second", questions });
  await app.command("pause");
  expect(app.active()).toEqual(["read", "grill_publish", "grill_state"]);
  await app.command("use First");
  await app.command("finish");
  expect(app.active()).toEqual(["read"]);
});

async function request(url: string, path = "/api/state", body?: unknown) {
  const address = new URL(url);
  const response = await fetch(`${address.origin}${path}`, {
    headers: { "X-Grill-Token": address.hash.slice(1), "Content-Type": "application/json", Origin: address.origin },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
  expect(response.ok).toBe(true);
  return response.json();
}

test("startup publishes once without an acknowledgement; submissions require their exact positive sequence", async () => {
  const app = await fixture();
  await app.command("Task board");
  const url = app.urls.at(-1)!;
  const initial = await request(url);
  for (const handled of [0, -1, 0.5]) {
    expect(() => app.publish({ id: initial.id, handled, questions })).toThrow();
  }
  expect((await request(url)).questions).toEqual([]);
  await app.publish({ id: initial.id, questions });
  expect((await request(url)).status).toBe("waiting");
  await app.command("reply q1 Keep the board visible");
  await expect(app.publish({ id: initial.id, handled: 2, replies: [{ q: "q1", text: "Wrong batch" }] })).rejects.toThrow();
  expect((await request(url)).pending.seq).toBe(1);
  await app.publish({ id: initial.id, handled: 1, replies: [{ q: "q1", text: "Agreed." }] });
  const state = await request(url);
  expect(state.pending).toBeUndefined();
  expect(state.handled).toBe(1);
  expect(state.questions[0].thread.map((entry: { text: string }) => entry.text)).toEqual(["Keep the board visible", "Agreed."]);
});

test("resuming an attached error keeps old-tab autosaves on the acknowledged store", async () => {
  const app = await fixture();
  await app.command("Recovery");
  await app.event("before_agent_start", { systemPrompt: [] });
  await app.publish({ questions });
  const oldUrl = app.urls.at(-1)!;
  await app.command("reply q1 Keep context");
  await app.event("before_agent_start", { systemPrompt: [] });
  await app.event("agent_end");
  expect((await request(oldUrl)).status).toBe("error");
  await app.command("resume Recovery");
  await app.publish({ handled: 1, replies: [{ q: "q1", text: "Context kept." }] });
  const current = await request(oldUrl);
  await request(oldUrl, "/api/drafts", {
    revision: current.drafts.revision, answers: { q1: { option: "modal" } },
  });
  const durable = JSON.parse(readFileSync(join(app.home, current.id, "state.json"), "utf8"));
  expect(durable.handled).toBe(1);
  expect(durable.pending).toBeUndefined();
  expect(durable.questions[0].thread.map((entry: any) => entry.text)).toEqual(["Keep context", "Context kept."]);
  expect(durable.drafts.answers.q1).toEqual({ option: "modal" });
});

test("queued interviews retain their own pending batch and detect an unpublished turn", async () => {
  const app = await fixture();
  await app.command("First");
  await app.publish({ questions });
  const firstUrl = app.urls.at(-1)!;
  await app.command("reply q1 First question");
  app.setQueued(true);
  await app.event("before_agent_start", { systemPrompt: [] });
  await app.event("agent_end");
  expect((await request(firstUrl)).status).toBe("working");
  await app.command("Second");
  await app.publish({ questions });
  const secondUrl = app.urls.at(-1)!;
  await app.command("reply q1 Second question");
  await app.event("before_agent_start", { systemPrompt: [] });
  await app.publish({ handled: 1, replies: [{ q: "q1", text: "Second handled." }] });
  app.setQueued(false);
  await app.event("agent_end");
  const first = await request(firstUrl);
  const second = await request(secondUrl);
  expect(first.status).toBe("error");
  expect(first.pending.seq).toBe(1);
  expect(second.status).toBe("waiting");
  expect(second.pending).toBeUndefined();
  expect(second.handled).toBe(1);
  await app.command(`use ${first.id}`);
  await app.command("resume");
  expect((await request(firstUrl)).status).toBe("working");
});

test("resume skips a finished branch entry and reopens the older paused interview", async () => {
  const app = await fixture();
  await app.command("Older");
  await app.publish({ questions });
  await app.command("pause");
  await app.command("Newest");
  await app.publish({ questions });
  const newestUrl = app.urls.at(-1)!;
  const newest = await request(newestUrl);
  await app.command("finish");
  await app.command("pause");
  await app.command("resume");
  const resumed = await request(app.urls.at(-1)!);
  expect(resumed.topic).toBe("Older");
  expect(resumed.status).toBe("waiting");
  await app.command("reply q1 Reopened");
  expect((await request(app.urls.at(-1)!)).pending.actions).toEqual([{ type: "thread", q: "q1", text: "Reopened" }]);
  const finished = JSON.parse(readFileSync(join(app.home, newest.id, "state.json"), "utf8"));
  expect(finished.status).toBe("finished");
});

test("browser Finish writes the report and hides command-only tools", async () => {
  const app = await fixture();
  await app.command("Browser finish");
  await app.publish({ questions });
  const url = app.urls.at(-1)!;
  const initial = await request(url);
  await request(url, "/api/send", { actions: [{ type: "finish" }] });
  expect((await request(url)).status).toBe("finished");
  expect(readFileSync(join(app.home, initial.id, "report.md"), "utf8")).toContain("Browser finish");
  expect(app.active()).toEqual(["read"]);
});

test("unsourced verified facts pass the tool contract and persist", async () => {
  const app = await fixture();
  await app.command("Facts");
  await app.publish({ questions, context: { facts: [{ id: "known", text: "The workflow has two choices." }] } });
  expect((await request(app.urls.at(-1)!)).context.facts).toEqual([{ id: "known", text: "The workflow has two choices." }]);
});

test("/grill config shows settings and persists validated values", async () => {
  const app = await fixture();
  await app.command("config");
  expect(app.messages).toHaveLength(1);
  expect(app.messages[0].customType).toBe("omp-grill:config");
  expect(app.messages[0].content).toContain("host: 127.0.0.1");
  expect(app.messages[0].content).toContain("port: 0");
  expect(app.messages[0].content).toContain("allowAgentStart: false");

  await app.command("config port 43127");
  expect(JSON.parse(readFileSync(join(app.home, "settings.json"), "utf8"))).toMatchObject({ port: 43127 });

  await app.command("config allowAgentStart true");
  expect(app.active()).toEqual(["read", "grill_publish", "grill_state"]);
  await app.command("config allowAgentStart false");
  expect(app.active()).toEqual(["read"]);

  await expect(app.command("config port nope")).rejects.toThrow("port");
  await expect(app.command("config allowAgentStart maybe")).rejects.toThrow("boolean");
  await expect(app.command("config host bad_host")).rejects.toThrow("host");
  await expect(app.command("config bogus 1")).rejects.toThrow("Usage:");
  await expect(app.command("config port")).rejects.toThrow("Usage:");
  await expect(app.command("config host 127.0.0.1 extra")).rejects.toThrow("Usage:");
});
