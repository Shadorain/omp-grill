import { describe, expect, test } from "bun:test";
import { GrillInspector, type GrillTheme } from "../src/tui.ts";
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

describe("grill session TUI", () => {
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
});
