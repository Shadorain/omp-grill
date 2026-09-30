import { describe, expect, test } from "bun:test";
import { GrillInspector, grillWidgetLines, type GrillTheme } from "../src/tui.ts";
import type { GrillState } from "../src/types.ts";

const theme: GrillTheme = {
  fg: (_tone, value) => value,
  symbol: () => "",
};

function state(): GrillState {
  return {
    id: "abc",
    owner: "me",
    project: "/p",
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
  test("widget names the topic and progress", () => {
    const lines = grillWidgetLines(state(), 80, theme).join("\n");
    expect(lines).toContain("Accent");
    expect(lines).toContain("0/1");
    expect(lines).toContain("waiting");
  });

  test("letter key stages the matching option and does not steal explore", () => {
    const current = state();
    const staged: string[] = [];
    const explored: string[] = [];
    const inspector = new GrillInspector(
      () => current,
      {
        close: () => {},
        stage: (_questionId, optionId) => staged.push(optionId),
        send: () => {},
        finish: () => {},
        explore: (questionId) => explored.push(questionId),
        defer: () => {},
      },
      () => 40,
      theme,
      { matches: () => false },
    );
    inspector.handleInput("a");
    inspector.handleInput("e");
    const rendered = inspector.render(80).join("\n");
    expect(staged).toEqual(["blue"]);
    expect(explored).toEqual(["color"]);
    expect(rendered).toContain("RECOMMENDED");
    expect(rendered).not.toContain("border");
  });
});
