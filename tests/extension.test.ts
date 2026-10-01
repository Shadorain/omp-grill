import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    sendMessage() {},
    sendUserMessage() {},
  };
  const ctx = {
    cwd: "/demo",
    hasUI: false,
    agent: { kind: "main" },
    sessionManager: { getSessionId: () => "test-owner", getBranch: () => entries },
    ui: { notify() {}, setStatus() {}, setWidget() {} },
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
    publish: (params: unknown): Promise<unknown> => tools.get("grill_publish").execute("call", params, undefined, undefined, ctx),
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
