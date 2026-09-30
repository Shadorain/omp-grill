import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactSubmission, createStore, loadStore } from "../src/store";
import { validatePrototypeSpec } from "../src/prototype";
import type { PrototypeSpec } from "../src/types";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const prototype: PrototypeSpec = {
  title: "Task board",
  start: "board",
  app: { name: "Launchpad", route: "/tasks", chrome: ["Workspace", "Tasks"] },
  theme: { accent: "#445566", radius: 12, font: "sans" },
  screens: [
    { id: "board", title: "Board", layout: "dashboard", blocks: [
      { id: "create", kind: "button", label: "New task", action: { type: "open", target: "create-dialog" } },
      { id: "create-dialog", kind: "dialog", children: [
        { id: "task-name", kind: "input", label: "Task name" },
        { id: "task-priority", kind: "select", options: ["Normal", "High"] },
        { id: "notify", kind: "checkbox", value: "true" },
        { id: "toggle", kind: "button", label: "Toggle", action: { type: "toggle", target: "notify" } },
        { id: "set", kind: "button", label: "Set priority", action: { type: "set", target: "task-priority", value: "High" } },
        { id: "submit", kind: "button", label: "Create", action: { type: "submit", target: "created" } },
      ] },
    ] },
    { id: "created", title: "Created", layout: "content", blocks: [
      { id: "confirmation", kind: "text", text: "{{task-name}} · {{task-priority}}" },
      { id: "back", kind: "button", label: "Back", action: { type: "navigate", target: "board" } },
    ] },
  ],
};

describe("native prototype renderer", () => {

  test("rejects malformed action references and undeclared markup fields", () => {
    const broken = structuredClone(prototype);
    broken.screens[0]!.blocks[0]!.action = { type: "navigate", target: "missing" };
    expect(() => validatePrototypeSpec(broken)).toThrow(/unknown screen/);
    const injected = structuredClone(prototype) as PrototypeSpec & { script?: string };
    injected.script = "fetch('https://example.invalid')";
    expect(() => validatePrototypeSpec(injected)).toThrow(/Unknown prototype spec field/);
  });

  test("validates form defaults and allows explicitly clearing a text input", () => {
    const spec = structuredClone(prototype);
    const controls = spec.screens[0]!.blocks[1]!.children!;
    controls[1]!.value = "Missing";
    expect(() => validatePrototypeSpec(spec)).toThrow(/selected option/);
    controls[1]!.value = "Normal";
    controls[2]!.value = "yes";
    expect(() => validatePrototypeSpec(spec)).toThrow(/checkbox value/);
    controls[2]!.value = "true";
    controls[4]!.action = { type: "set", target: "task-name", value: "" };
    expect(validatePrototypeSpec(spec).screens[0]!.blocks[1]!.children![4]!.action).toEqual({
      type: "set", target: "task-name", value: "",
    });
  });

  test("Finish batches checkpoint answers and persist a private prototype without another agent turn", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-grill-finish-prototype-"));
    roots.push(root);
    const store = createStore({ home: root, owner: "alice", project: root, topic: "Tasks" });
    store.publish({
      prototype,
      questions: [{
        id: "q1", title: "Task workflow", options: [{ id: "board", label: "Board" }],
        recommendation: { option: "board", reason: "Keep the current overview" },
      }],
    });
    const drafts = store.saveDrafts({ revision: 0, answers: { q1: { option: "board", text: "Keep context." } } });
    const submission = store.submit([
      { type: "answer", q: "q1", option: "board", text: "Keep context." },
      { type: "finish" },
    ], { draftRevision: drafts.revision });
    expect(store.state.status).toBe("finished");
    expect(store.state.pending).toBeUndefined();
    expect(store.state.handled).toBe(submission.seq);
    expect(store.state.questions[0]!.answer).toEqual({ option: "board", text: "Keep context." });
    expect(store.state.drafts.answers).toEqual({});
    expect(statSync(join(store.dir, "prototype.html")).mode & 0o777).toBe(0o600);
    expect(loadStore(store.dir, "alice").state.prototype?.stale).toBe(true);
  });

  test("keeps visual discussion on regeneration and scopes model context to explicit prototype requests", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-grill-prototype-"));
    roots.push(root);
    const store = createStore({ home: root, owner: "alice", project: join(root, "project"), topic: "Tasks" });
    store.updateContext({ intent: "Create and track work", facts: [{ id: "f1", text: "Team has 8 members", source: "brief" }] });
    store.publish({
      prototype,
      diagram: {
        title: "System",
        kind: "flow",
        nodes: [{ id: "client", label: "Client" }],
        edges: [],
      },
      questions: [{
        id: "q1",
        title: "Task workflow",
        options: [{ id: "board", label: "Board" }],
        recommendation: { option: "board", reason: "Clear overview" },
      }],
    });
    const feedback = store.submit([{ type: "visual-feedback", kind: "prototype", text: "Add priority choice" }]);
    expect(compactSubmission(store.state, feedback)).toContain("prototypeContext");
    store.acknowledge(feedback.seq);
    expect(store.state.diagram?.thread).toEqual([]);
    const ordinary = store.submit([{ type: "thread", q: "q1", text: "Keep this compact" }]);
    expect(compactSubmission(store.state, ordinary)).not.toContain("prototypeContext");
    store.acknowledge(ordinary.seq);
    store.publish({ prototype, prototypeReply: "Added priority choice" });
    expect(store.state.prototype?.version).toBe(2);
    expect(store.state.prototype?.thread.map((item) => item.text)).toEqual(["Add priority choice", "Added priority choice"]);
    const restored = loadStore(store.dir, "alice");
    expect(() => store.exportVisual("prototype", "artifacts/tasks.html")).toThrow(/finished/);
    expect(restored.state.prototype).toEqual(store.state.prototype);
    store.publish({ questions: [{
      id: "q1",
      title: "Task workflow",
      options: [{ id: "board", label: "Board" }],
      recommendation: { option: "board", reason: "Use dashboard instead" },
    }] });
    expect(store.state.prototype?.stale).toBe(true);
    expect(store.state.diagram?.stale).toBe(true);
    store.finish();
    const exported = store.exportVisual("prototype", "artifacts/tasks.html");
    expect(statSync(exported).mode & 0o777).toBe(0o600);
  });
});
