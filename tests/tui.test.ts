import { describe, expect, test } from "bun:test";
import { createGrillWidget, grillWidgetLines, grillWidgetTitle, GrillInspector, type GrillTheme } from "../src/tui.ts";
import type { GrillState } from "../src/types.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.ts";

const theme: GrillTheme = {
  fg: (_tone, value) => value,
  symbol: () => "",
};

function state(): GrillState {
  return {
    id: "abc",
    owner: "me",
    project: "/p",
    workspace: "/p",
    topic: "Accent",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    status: "waiting",
    seq: 1,
    handled: 1,
    questions: [{
      id: "color",
      title: "Choose the accent",
      options: [
        { id: "blue", label: "Blue" },
        { id: "purple", label: "Purple" },
      ],
      recommendation: { option: "blue", reason: "Blue is calmer." },
      status: "open",
      thread: [],
    }],
    drafts: { revision: 0, answers: {}, threads: {}, recovery: [] },
    context: { terms: [], facts: [], risks: [] },
  };
}

describe("grill status widget", () => {
  test("renders a compact summary and optional full topic, status, and private URL", () => {
    const current = state();
    current.topic = "A deliberately long topic that should be shortened in the status line";
    current.error = "connection lost";
    current.status = "error";
    const compact = grillWidgetLines(current, 80, theme);
    expect(compact).toHaveLength(1);
    expect(compact[0]).toContain("0/1");
    expect(compact[0]).toContain("error");
    expect(grillWidgetTitle(current).length).toBeLessThan(current.topic.length);

    const expanded = createGrillWidget(() => current, theme, () => ({
      expanded: true,
      url: "http://127.0.0.1:43127/private",
    })).render(100);
    expect(expanded).toHaveLength(4);
    expect(expanded[1]).toContain(current.topic);
    expect(expanded[2]).toContain("error: connection lost");
    expect(expanded[3]).toContain("http://127.0.0.1:43127/private");
  });

  test("fits the compact summary to narrow widths and hides finished sessions", () => {
    const current = state();
    expect(grillWidgetLines(current, 12, theme)[0].length).toBeLessThanOrEqual(12);
    current.status = "finished";
    expect(grillWidgetLines(current, 80, theme)).toEqual([]);
    expect(createGrillWidget(() => current, theme).render(80)).toEqual([]);
  });
});

describe("grill session TUI", () => {

  test("multi-select inspector marks every recommended and selected option with a clear toggle hint", () => {
    const current = state();
    const question = current.questions[0]!;
    question.multiSelect = true;
    question.recommendation = { options: ["blue", "purple"], reason: "Use both accents." };
    question.answer = { options: ["blue", "purple"], text: "Both are needed." };
    question.status = "answered";
    const inspector = new GrillInspector(
      () => current,
      { close() {}, stage() {}, write() {}, send() {}, finish() {}, explore() {}, defer() {} },
      () => 40, theme, { matches: () => false },
    );
    const output = inspector.render(200).join("\n");
    expect(output).toContain("Select all that apply; letters toggle");
    for (const label of ["Blue", "Purple"]) {
      const line = output.split("\n").find((row) => row.includes(label));
      expect(line).toContain("RECOMMENDED");
      expect(line).toContain("✓");
    }
  });
  test("pending submissions block new actions but allow staging and resume after acknowledgement", () => {
    const home = mkdtempSync(join(tmpdir(), "omp-grill-inspector-"));
    try {
      const store = createStore({ home, owner: "me", project: home, topic: "Accent" });
      const question = state().questions[0]!;
      store.publish({ questions: [{
        id: question.id, title: question.title,
        options: question.options, recommendation: question.recommendation,
      }] });
      const inspector = new GrillInspector(
        () => store.state,
        {
          close() {},
          stage(q, option) {
            store.saveDrafts({ revision: store.state.drafts.revision, answers: { [q]: { option } } });
          },
          write(q, kind, text) {
            store.saveDrafts(kind === "thread"
              ? { revision: store.state.drafts.revision, threads: { [q]: text || null } }
              : { revision: store.state.drafts.revision, answers: { [q]: text ? { text } : null } });
          },
          send() {
            store.submit([{ type: "answer", q: question.id, ...store.state.drafts.answers[question.id] }]);
          },
          finish() { store.finish(); },
          explore(q) { store.submit([{ type: "explore", q }]); },
          defer(q) { store.submit([{ type: "defer", q }]); },
        },
        () => 40, theme, { matches: () => false },
      );
      const pending = store.submit([{ type: "thread", q: question.id, text: "Keep this choice open." }]);
      inspector.handleInput("a");
      expect(store.state.drafts.answers[question.id]).toEqual({ option: "blue" });
      for (const key of ["e", "x", "\r", "f", "f"]) inspector.handleInput(key);
      expect(store.state.pending).toEqual(pending);
      expect(store.state.seq).toBe(1);
      expect(store.state.status).toBe("working");
      store.publish({ handled: pending.seq });
      inspector.handleInput("e");
      expect(store.state.pending?.actions).toEqual([{ type: "explore", q: question.id }]);
      expect(store.state.seq).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("writes answers and messages for a question with no options", () => {
    const home = mkdtempSync(join(tmpdir(), "omp-grill-inspector-"));
    try {
      const store = createStore({ home, owner: "me", project: home, topic: "Invariants" });
      store.publish({ questions: [{
        id: "inv", title: "Name the invariant", options: [],
        recommendation: { reason: "Open ended" },
      }] });
      const inspector = new GrillInspector(
        () => store.state,
        {
          close() {}, stage() {}, send() {}, finish() {}, explore() {}, defer() {},
          write(q, kind, text) {
            store.saveDrafts(kind === "thread"
              ? { revision: store.state.drafts.revision, threads: { [q]: text || null } }
              : { revision: store.state.drafts.revision, answers: { [q]: text ? { text } : null } });
          },
        },
        () => 40, theme, { matches: () => false },
      );

      for (const key of [..."i", ..."Store is the only writer.", "\r"]) inspector.handleInput(key);
      expect(store.state.drafts.answers.inv).toEqual({ text: "Store is the only writer." });

      // Letters reach the buffer instead of staging a nonexistent option.
      for (const key of [..."m", ..."Why not the server?", "\r"]) inspector.handleInput(key);
      expect(store.state.drafts.threads.inv).toBe("Why not the server?");

      // Backspace edits, escape discards.
      for (const key of [..."i", ..."ab", "\u007f", "\u001b"]) inspector.handleInput(key);
      expect(store.state.drafts.answers.inv).toEqual({ text: "Store is the only writer." });

      expect(inspector.render(80).some((line) => line.includes("Store is the only writer."))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("defer asks for a revisit condition and records it", () => {
    const home = mkdtempSync(join(tmpdir(), "omp-grill-inspector-"));
    try {
      const store = createStore({ home, owner: "me", project: home, topic: "Cache" });
      store.publish({ questions: [{ id: "ttl", title: "Cache TTL", options: [], recommendation: { reason: "r" } }] });
      const inspector = new GrillInspector(
        () => store.state,
        {
          close() {}, stage() {}, write() {}, send() {}, finish() {}, explore() {},
          defer(q, until) { store.submit([{ type: "defer", q, ...(until ? { until } : {}) }]); },
        },
        () => 40, theme, { matches: () => false },
      );
      for (const key of [..."x", ..."after load test", "\r"]) inspector.handleInput(key);
      expect(store.state.questions[0]?.status).toBe("deferred");
      expect(store.state.questions[0]?.deferUntil).toBe("after load test");
      expect(inspector.render(80).some((line) => line.includes("Revisit when") && line.includes("after load test"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
