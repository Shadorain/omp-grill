import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, loadStore } from "../src/store";
import { validatePrototypeSpec } from "../src/prototype";
import { renderDiagram } from "../src/diagram";
import type { PrototypeSpec, DiagramSpec } from "../src/types";
import { renderAdrs, renderBeadsPlan } from "../src/exports";
import { submissionSummary } from "../src/messages";

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
    store.acknowledge(feedback.seq);
    expect(store.state.diagram?.thread).toEqual([]);
    const ordinary = store.submit([{ type: "thread", q: "q1", text: "Keep this compact" }]);
    store.acknowledge(ordinary.seq);
    store.publish({ prototype, prototypeReply: "Added priority choice" });
    expect(store.state.prototype?.version).toBe(2);
    expect(store.state.prototype?.thread.map((item) => item.text)).toEqual(["Add priority choice", "Added priority choice"]);
    const restored = loadStore(store.dir, "alice");
    expect(() => store.exportArtifact("prototype", "artifacts/tasks.html")).toThrow(/finished/);
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
    const [exported] = store.exportArtifact("prototype", "artifacts/tasks.html");
    expect(statSync(exported!).mode & 0o777).toBe(0o600);
  });

  test("rejects cross-screen dialog actions and invalid select set values", () => {
    const spec = structuredClone(prototype);
    spec.screens.push({ id: "other", title: "Other", blocks: [
      { id: "other-dialog", kind: "dialog", label: "Other", children: [] },
      { id: "bad-open", kind: "button", label: "Bad", action: { type: "open", target: "create-dialog" } },
    ] });
    expect(() => validatePrototypeSpec(spec)).toThrow(/another screen/);
    spec.screens[2]!.blocks[1]!.action = { type: "open", target: "other-dialog" };
    expect(validatePrototypeSpec(spec).screens[2]!.blocks[1]!.action!.target).toBe("other-dialog");
    const s = structuredClone(prototype);
    const setBtn = s.screens[0]!.blocks[1]!.children![4]!;
    setBtn.action = { type: "set", target: "task-priority", value: "Bogus" };
    expect(() => validatePrototypeSpec(s)).toThrow(/not valid option for select/);
  });

  test("self-transitions retain visible nonzero arrow geometry", () => {
    const stateDiagram: DiagramSpec = {
      title: "Retry", kind: "state", nodes: [{ id: "a", label: "Ready" }],
      edges: [{ from: "a", to: "a", label: "retry" }],
    };
    expect(renderDiagram(stateDiagram)).toMatch(/<path [^>]*marker-end="url\(#arrow\)"/);
    const sequenceDiagram: DiagramSpec = { ...stateDiagram, kind: "sequence" };
    const svg = renderDiagram(sequenceDiagram);
    const arrow = svg.match(/<line [^>]*marker-end="url\(#arrow\)"[^>]*>/)?.[0] ?? "";
    const coordinate = (name: string) => Number(arrow.match(new RegExp(`${name}="([^"]+)"`))?.[1]);
    expect(Math.hypot(coordinate("x2") - coordinate("x1"), coordinate("y2") - coordinate("y1"))).toBeGreaterThan(0);
  });

  test("long labels and titles stay inside content-sized SVG layout", () => {
    const spec: DiagramSpec = {
      title: "A deliberately lengthy diagram heading that wraps to multiple lines while remaining available in the rendered graphic",
      kind: "state",
      nodes: [
        { id: "a", label: "A decision node with an extraordinarily descriptive label that spans several lines and stays fully visible", detail: "A detailed explanation with enough words to use several lines inside the node without clipping or overflowing its border." },
        { id: "b", label: "<Ready> & safe", detail: "A second explanation that remains escaped and contained." },
      ],
      edges: [{ from: "a", to: "b", label: "A long transition label that wraps and remains centered in the available edge lane" }],
    };
    const svg = renderDiagram(spec);
    const rectangles = [...svg.matchAll(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" rx="[^"]+" fill="#211d35"/g)]
      .map((match) => ({ x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) }));
    const texts = [...svg.matchAll(/<text x="([^"]+)" y="([^"]+)" text-anchor="[^"]+" fill="([^"]+)" font-size="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g)]
      .map((match) => {
        const offsets = [...match[5]!.matchAll(/<tspan x="[^"]+" dy="([^"]+)">/g)].map((span) => Number(span[1]));
        const baselines = [Number(match[2])];
        for (const offset of offsets.slice(1)) baselines.push(baselines[baselines.length - 1]! + offset);
        const lineContent = [...match[5]!.matchAll(/<tspan\b[^>]*>(.*?)<\/tspan>/g)].map((span) => span[1]);
        return { x: Number(match[1]), fill: match[3], baselines, content: lineContent.join(""), lineContent };
      });
    const title = texts.find((text) => text.fill === "#f8fafc")!;
    expect(rectangles[0]!.y).toBeGreaterThan(title.baselines.at(-1)!);
    const nodeLabels = texts.filter((text) => text.fill === "#f4f0ff" || text.fill === "#c7c1d8");
    expect(nodeLabels).toHaveLength(4);
    for (const [i, label] of nodeLabels.entries()) {
      const box = rectangles[Math.floor(i / 2)]!;
      expect(label.baselines[0]!).toBeGreaterThan(box.y);
      expect(label.baselines.at(-1)!).toBeLessThan(box.y + box.height);
      expect(label.content.length).toBeGreaterThan(0);
    }
    expect(svg).toContain("&lt;Ready&gt; &amp; safe");
    const edgeLabel = texts.find((text) => text.fill === "#e9d5ff")!;
    expect(edgeLabel.baselines.length).toBeGreaterThan(1);
    const edgeWidth = Math.max(...edgeLabel.lineContent.map((line) => line.length * 6.3));
    const gap = rectangles[1]!.x - (rectangles[0]!.x + rectangles[0]!.width);
    expect(edgeWidth).toBeLessThan(gap);

    const sequence = renderDiagram({ ...spec, kind: "sequence" });
    const actors = [...sequence.matchAll(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" rx="[^"]+" fill="#211d35"/g)]
      .map((match) => ({ y: Number(match[2]), height: Number(match[4]) }));
    const firstMessage = sequence.match(/<line [^>]*marker-end="url\(#arrow\)"[^>]*>/)?.[0] ?? "";
    const messageY = Number(firstMessage.match(/y1="([^"]+)"/)?.[1]);
    expect(messageY).toBeGreaterThan(actors[0]!.y + actors[0]!.height);
  });

  test("all 30 sequence actors fit without overlapping headers", () => {
    const svg = renderDiagram({
      title: "Actors", kind: "sequence",
      nodes: Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, label: `Actor ${i + 1}` })),
      edges: [],
    });
    const headers = [...svg.matchAll(/<rect x="([^"]+)"[^>]*width="([^"]+)"/g)]
      .map((match) => ({ x: Number(match[1]), width: Number(match[2]) }));
    const viewWidth = Number(svg.match(/viewBox="0 0 ([^ ]+)/)?.[1]);
    for (const [index, header] of headers.entries()) {
      expect(header.x).toBeGreaterThanOrEqual(0);
      expect(header.x + header.width).toBeLessThanOrEqual(viewWidth);
      if (index) expect(header.x).toBeGreaterThanOrEqual(headers[index - 1]!.x + headers[index - 1]!.width);
    }
  });
});

describe("multi-select decision outputs", () => {
  test("ADR, beads, and submission summaries retain every selected option and rationale", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-grill-multi-output-"));
    roots.push(root);
    const store = createStore({ home: root, owner: "alice", project: root, topic: "Accent strategy" });
    store.publish({ questions: [{
      id: "accents",
      title: "Which accents?",
      body: "Keep emphasis accessible.",
      options: [
        { id: "blue", label: "Blue" },
        { id: "purple", label: "Purple" },
        { id: "gray", label: "Gray" },
      ],
      multiSelect: true,
      durable: true,
      recommendation: { options: ["blue", "purple"], reason: "Both are clear." },
    }] });
    const submission = store.submit([{ type: "answer", q: "accents", options: ["blue", "purple"], text: "Differentiate links and actions." }]);

    const adr = renderAdrs(store.state, "docs/adr", [])[0]!.contents;
    expect(adr).toContain("We chose Blue, Purple.");
    expect(adr).toContain("Differentiate links and actions.");
    expect(adr).toContain("**Blue** (Chosen)");
    expect(adr).toContain("**Purple** (Chosen)");
    expect(adr).toContain("**Gray** (Rejected)");

    const beads = JSON.parse(renderBeadsPlan(store.state)) as { nodes: { description?: string; design?: string }[] };
    const task = beads.nodes.find((node) => node.design);
    expect(task?.description).toContain("Blue, Purple");
    expect(task?.design).toContain("Chosen: Blue; Purple");
    expect(task?.design).toContain("Rationale: Differentiate links and actions.");
    expect(task?.design).toContain("Rejected: Gray");

    const summary = submissionSummary(store.state, submission);
    expect(summary).toContain("Answer · Which accents?: Blue, Purple — Differentiate links and actions.");
  });
});
