import type { Component } from "@oh-my-pi/pi-tui";
import { replaceTabs, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { GrillState } from "./types.ts";

export interface GrillTheme {
  fg(tone: string, value: string): string;
  symbol?(key: string): string;
}

export interface GrillKeys {
  matches(data: string, action: string): boolean;
}

export interface GrillTuiActions {
  close(): void;
  stage(questionId: string, optionId: string): void;
  send(): void;
  finish(): void;
  explore(questionId: string): void;
  defer(questionId: string): void;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function clip(value: string, width: number): string {
  return truncateToWidth(replaceTabs(value), Math.max(1, width));
}

function paint(theme: GrillTheme, tone: string, value: string): string {
  return theme.fg(tone, value);
}

function glyph(theme: GrillTheme, key: string, fallback: string): string {
  return theme.symbol?.(key) || fallback;
}

function dot(theme: GrillTheme): string {
  return ` ${paint(theme, "dim", glyph(theme, "sep.dot", "·").trim() || "·")} `;
}

export function grillView(state: GrillState | undefined) {
  if (!state) return undefined;
  const staged = Object.values(state.drafts.answers).filter((draft) => draft?.option || draft?.text?.trim()).length
    + Object.values(state.drafts.threads).filter((text) => text?.trim()).length;
  return { state, staged };
}

export function grillWidgetLines(state: GrillState, width: number, theme: GrillTheme): string[] {
  const answered = state.questions.filter((question) => question.status !== "open").length;
  const rail = paint(theme, "accent", glyph(theme, "advisor.rail", "▎"));
  const open = state.questions.find((question) => question.status === "open");
  const parts = [
    paint(theme, "accent", state.topic),
    paint(theme, "text", `${answered}/${state.questions.length || 0}`),
    paint(theme, state.status === "error" ? "error" : state.status === "working" ? "warning" : "success", state.status),
  ];
  if (open) parts.push(paint(theme, "dim", open.title));
  let line = `${rail} ${parts.join(dot(theme))}`;
  while (visibleWidth(line) > width && parts.length > 2) {
    parts.pop();
    line = `${rail} ${parts.join(dot(theme))}`;
  }
  const hint = paint(theme, "dim", "j/k questions · a-d stage · enter send · esc close");
  return [clip(line, width), clip(`  ${hint}`, width)];
}

export class GrillWidget implements Component {
  constructor(
    private readonly getState: () => GrillState | undefined,
    private readonly theme: GrillTheme,
  ) {}
  render(width: number): string[] {
    const state = this.getState();
    if (!state) return [];
    return grillWidgetLines(state, width, this.theme);
  }
  invalidate(): void {}
}

export class GrillInspector implements Component {
  private selected = 0;
  private view: "questions" | "discussion" = "questions";
  private confirmFinish = false;
  private note = "";

  constructor(
    private readonly getState: () => GrillState | undefined,
    private readonly actions: GrillTuiActions,
    private readonly getRows: () => number,
    private readonly theme: GrillTheme,
    private readonly keys: GrillKeys,
  ) {}

  private questions() {
    return this.getState()?.questions ?? [];
  }

  render(width: number): string[] {
    const state = this.getState();
    const theme = this.theme;
    if (!state) return [paint(theme, "muted", "No grill selected")];
    const questions = state.questions;
    this.selected = Math.max(0, Math.min(this.selected, Math.max(0, questions.length - 1)));
    const question = questions[this.selected];
    const answered = questions.filter((item) => item.status !== "open").length;
    const rail = paint(theme, "accent", glyph(theme, "advisor.rail", "▎"));
    const header = clip(
      `${rail} ${[paint(theme, "accent", state.topic), paint(theme, "text", `${answered}/${questions.length}`), paint(theme, "dim", state.status)].join(dot(theme))}`,
      width,
    );
    const keys = paint(theme, "dim", "j/k  a-d stage  enter send  e explore  x defer  f finish  tab thread  esc");
    const lines = [header, clip(`  ${keys}`, width)];
    if (this.note) lines.push(clip(`  ${paint(theme, "warning", this.note)}`, width));
    if (this.view === "discussion" && question) {
      lines.push(clip(`  ${paint(theme, "accent", question.title)}`, width));
      const thread = question.thread.length ? question.thread : [];
      if (!thread.length) lines.push(clip(`  ${paint(theme, "muted", "No discussion yet")}`, width));
      for (const entry of thread.slice(-8)) {
        lines.push(clip(`  ${paint(theme, entry.role === "user" ? "text" : "dim", entry.role === "user" ? "You" : "Agent")}  ${entry.text}`, width));
      }
      return lines.slice(0, Math.max(4, this.getRows() - 1));
    }
    const budget = Math.max(4, this.getRows() - 1);
    const listCap = Math.min(questions.length, Math.max(3, Math.floor(budget * 0.4)));
    const start = Math.max(0, Math.min(this.selected - listCap + 1, questions.length - listCap));
    for (const [offset, item] of questions.slice(start, start + listCap).entries()) {
      const index = start + offset;
      const cursor = index === this.selected ? glyph(theme, "nav.cursor", "❯") : " ";
      const mark = item.status === "answered" ? paint(theme, "success", "✓") : item.status === "deferred" ? paint(theme, "warning", "later") : paint(theme, "dim", "open");
      const draft = state.drafts.answers[item.id];
      const staged = draft?.option || draft?.text?.trim() ? paint(theme, "accent", " · staged") : "";
      const tone = index === this.selected ? "accent" : "text";
      lines.push(clip(`${cursor} ${paint(theme, "dim", `Q${index + 1}`)}  ${paint(theme, tone, item.title)}  ${mark}${staged}`, width));
    }
    if (!question) {
      lines.push(clip(`  ${paint(theme, "muted", "Waiting for the first questions")}`, width));
      return lines.slice(0, budget);
    }
    lines.push("");
    lines.push(clip(`  ${paint(theme, "text", question.title)}`, width));
    if (question.body) lines.push(clip(`  ${paint(theme, "dim", question.body)}`, width));
    question.options.forEach((option, index) => {
      const letter = LETTERS[index] ?? "?";
      const recommended = question.recommendation.option === option.id;
      const chosen = state.drafts.answers[question.id]?.option === option.id || (!state.drafts.answers[question.id] && question.answer?.option === option.id);
      const pill = recommended ? `  ${paint(theme, "accent", "RECOMMENDED")}` : "";
      const mark = chosen ? paint(theme, "success", " ✓") : "";
      lines.push(clip(`  ${paint(theme, chosen ? "accent" : "text", letter.toUpperCase())}  ${option.label}${pill}${mark}`, width));
    });
    if (state.note && questions.every((item) => item.status !== "open")) {
      lines.push(clip(`  ${paint(theme, "success", state.note)}`, width));
    }
    return lines.slice(0, budget);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.keys.matches(data, "tui.select.cancel") || data === "q" || data === "\u001b") {
      this.actions.close();
      return;
    }
    if (data === "\t") {
      this.view = this.view === "questions" ? "discussion" : "questions";
      this.confirmFinish = false;
      return;
    }
    const questions = this.questions();
    if (this.keys.matches(data, "tui.select.up") || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
      this.confirmFinish = false;
      return;
    }
    if (this.keys.matches(data, "tui.select.down") || data === "j") {
      this.selected = Math.min(Math.max(0, questions.length - 1), this.selected + 1);
      this.confirmFinish = false;
      return;
    }
    const question = questions[this.selected];
    if (!question || this.getState()?.status === "finished") return;
    const reserved = new Set(["e", "x", "f", "j", "k", "q"]);
    const letter = LETTERS.indexOf(data.toLowerCase());
    if (!reserved.has(data.toLowerCase()) && letter >= 0 && letter < question.options.length && data.length === 1) {
      const option = question.options[letter];
      if (option) this.actions.stage(question.id, option.id);
      this.confirmFinish = false;
      return;
    }
    if (this.keys.matches(data, "tui.select.confirm") || data === "\r" || data === "\n") {
      this.actions.send();
      this.note = "Sent staged answers.";
      return;
    }
    if (data === "e") {
      this.actions.explore(question.id);
      this.note = "Explore sent.";
      return;
    }
    if (data === "x") {
      this.actions.defer(question.id);
      this.note = "Deferred.";
      return;
    }
    if (data === "f") {
      if (!this.confirmFinish) {
        this.confirmFinish = true;
        this.note = "Press f again to finish.";
        return;
      }
      this.actions.finish();
    }
  }
}

export function createGrillWidget(getState: () => GrillState | undefined, theme: GrillTheme): GrillWidget {
  return new GrillWidget(getState, theme);
}

export function createGrillInspector(
  getState: () => GrillState | undefined,
  actions: GrillTuiActions,
  getRows: () => number,
  theme: GrillTheme,
  keys: GrillKeys,
): GrillInspector {
  return new GrillInspector(getState, actions, getRows, theme, keys);
}
