import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import grillExtension from "../src/extension";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(allowAgentStart?: boolean) {
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
  const notices: string[] = [];
  const messages: any[] = [];
  const pi = {
    zod: z,
    registerTool(tool: any) {
      tools.set(tool.name, tool);
      if (!tool.defaultInactive) active.push(tool.name);
    },
    registerCommand(_name: string, value: any) { command = value; },
    on(name: string, handler: any) { events.set(name, handler); },
    getActiveTools: () => [...active],
    async setActiveTools(names: string[]) { active = names; },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    sendMessage(message: unknown) { messages.push(message); },
    sendUserMessage() {},
  };
  const ctx = {
    cwd: "/demo",
    hasUI: false,
    agent: { kind: "main" },
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
  };
}

const questions = [{
  id: "q1", title: "Where should tasks be created?",
  options: [{ id: "modal", label: "Modal" }, { id: "page", label: "Page" }],
  recommendation: { option: "modal", reason: "Keeps the board visible." },
}];

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
