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
  /** Save answer text or a discussion message as a draft, without sending. */
  write(questionId: string, kind: "answer" | "thread", text: string): void;
  send(): void;
  finish(): void;
  explore(questionId: string): void;
  defer(questionId: string, until?: string): void;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
/** Letters bound to commands, so they never stage an option. */
const COMMAND_KEYS: Record<string, true> = { e: true, f: true, i: true, j: true, k: true, m: true, q: true, x: true };
/** Matches the store's text cap, so a draft cannot be rejected on save. */
const MAX_DRAFT_TEXT = 20_000;
/** Prompt shown while a text field is active. */
const EDIT_PROMPT: Record<"answer" | "thread" | "defer", string> = {
  answer: "typing answer",
  thread: "typing message",
  defer: "revisit when",
};

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

const WIDGET_TITLE_WIDTH = 32;

export function grillWidgetTitle(state: GrillState): string {
  const topic = replaceTabs(state.topic).replace(/\s+/g, " ").trim();
  return truncateToWidth(topic || "Grill", WIDGET_TITLE_WIDTH);
}

export interface GrillWidgetOptions {
  expanded?: boolean;
  url?: string;
}

export function grillWidgetLines(
  state: GrillState,
  width: number,
  theme: GrillTheme,
  options: GrillWidgetOptions = {},
): string[] {
  if (state.status === "finished") return [];
  const answered = state.questions.filter((question) => question.status !== "open").length;
  const rail = paint(theme, "accent", glyph(theme, "advisor.rail", "▎"));
  const statusTone = state.status === "error" ? "error" : state.status === "working" ? "warning"
    : state.status === "paused" ? "dim" : "success";
  const line = `${rail} ${paint(theme, "accent", grillWidgetTitle(state))}${dot(theme)}`
    + `${paint(theme, "text", `${answered}/${state.questions.length}`)}${dot(theme)}`
    + paint(theme, statusTone, state.status);
  const lines = [clip(line, width)];
  if (options.expanded) {
    lines.push(clip(paint(theme, "dim", `  Topic: ${replaceTabs(state.topic).replace(/\s+/g, " ").trim()}`), width));
    const status = state.error && state.status === "error" ? `${state.status}: ${state.error}` : state.status;
    lines.push(clip(paint(theme, statusTone, `  Status: ${status}`), width));
    if (options.url) lines.push(clip(paint(theme, "dim", `  URL: ${options.url}`), width));
  }
  return lines;
}

export class GrillWidget implements Component {
  constructor(
    private readonly getState: () => GrillState | undefined,
    private readonly theme: GrillTheme,
    private readonly getOptions: () => GrillWidgetOptions = () => ({}),
  ) {}
  render(width: number): string[] {
    const state = this.getState();
    if (!state) return [];
    return grillWidgetLines(state, width, this.theme, this.getOptions());
  }
  invalidate(): void {}
}

export class GrillInspector implements Component {
  private selected = 0;
  private view: "questions" | "discussion" = "questions";
  private confirmFinish = false;
  private note = "";
  /** Active text field, or undefined when keys act as commands. */
  private editing?: { kind: "answer" | "thread" | "defer"; buffer: string };

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
    const keys = paint(
      theme,
      "dim",
      this.editing
        ? `${EDIT_PROMPT[this.editing.kind]}  enter save  esc cancel`
        : "j/k  a-d stage  i write  m message  enter send  e explore  x defer  f finish  tab thread  esc",
    );
    const lines = [header, clip(`  ${keys}`, width)];
    if (this.note) lines.push(clip(`  ${paint(theme, "warning", this.note)}`, width));
    if (this.view === "discussion" && question) {
      lines.push(clip(`  ${paint(theme, "accent", question.title)}`, width));
      const thread = question.thread.length ? question.thread : [];
      if (!thread.length) lines.push(clip(`  ${paint(theme, "muted", "No discussion yet")}`, width));
      for (const entry of thread.slice(-8)) {
        lines.push(clip(`  ${paint(theme, entry.role === "user" ? "text" : "dim", entry.role === "user" ? "You" : "Agent")}  ${entry.text}`, width));
      }
      if (this.editing?.kind === "thread")
        lines.push(clip(`  ${paint(theme, "accent", ">")} ${this.editing.buffer}${paint(theme, "accent", "▌")}`, width));
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
    if (this.editing && this.editing.kind !== "thread") {
      const label = this.editing.kind === "defer" ? "Revisit when" : ">";
      lines.push(clip(`  ${paint(theme, "accent", label)} ${this.editing.buffer}${paint(theme, "accent", "▌")}`, width));
    } else {
      const written = (state.drafts.answers[question.id]?.text ?? question.answer?.text ?? "").trim();
      if (written) lines.push(clip(`  ${paint(theme, "dim", "Written:")} ${written}`, width));
      else if (!question.options.length)
        lines.push(clip(`  ${paint(theme, "muted", "Press i to write an answer")}`, width));
      if (question.deferUntil)
        lines.push(clip(`  ${paint(theme, "warning", "Revisit when")} ${question.deferUntil}`, width));
    }
    if (state.note && questions.every((item) => item.status !== "open")) {
      lines.push(clip(`  ${paint(theme, "success", state.note)}`, width));
    }
    return lines.slice(0, budget);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.editing) {
      this.editText(data);
      return;
    }
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
    const state = this.getState();
    if (!question || !state || state.status === "finished") return;
    try {
      const letter = LETTERS.indexOf(data.toLowerCase());
      if (!COMMAND_KEYS[data.toLowerCase()] && letter >= 0 && letter < question.options.length && data.length === 1) {
        const option = question.options[letter];
        if (option) this.actions.stage(question.id, option.id);
        this.confirmFinish = false;
        return;
      }
      // Drafts stay editable while the agent works, matching the browser.
      if (data === "i" || data === "m") {
        const kind = data === "i" ? "answer" : "thread";
        const existing = kind === "answer"
          ? state.drafts.answers[question.id]?.text ?? question.answer?.text ?? ""
          : state.drafts.threads[question.id] ?? "";
        this.editing = { kind, buffer: existing };
        this.view = kind === "thread" ? "discussion" : "questions";
        this.confirmFinish = false;
        this.note = "";
        return;
      }
      if (state.pending || state.status === "working") {
        this.confirmFinish = false;
        this.note = state.error || "Agent is working. Drafts stay editable; wait for acknowledgement.";
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
        this.editing = { kind: "defer", buffer: question.deferUntil ?? "" };
        this.confirmFinish = false;
        this.note = "";
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
    } catch (error) {
      this.confirmFinish = false;
      this.note = error instanceof Error ? error.message : String(error);
    }
  }

  /** Line editor for the active answer or message draft. */
  private editText(data: string): void {
    const editing = this.editing;
    if (!editing) return;
    if (data === "\u001b") {
      this.editing = undefined;
      this.note = "Discarded.";
      return;
    }
    if (data === "\r" || data === "\n") {
      const question = this.questions()[this.selected];
      this.editing = undefined;
      if (!question) return;
      const text = editing.buffer.trim();
      try {
        if (editing.kind === "defer") {
          this.actions.defer(question.id, text || undefined);
          this.note = text ? `Deferred until ${text}.` : "Deferred.";
          return;
        }
        this.actions.write(question.id, editing.kind, text);
        this.note = text
          ? `Staged ${editing.kind === "answer" ? "answer" : "message"}. Press enter to send.`
          : "Cleared.";
      } catch (error) {
        this.note = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    if (data === "\u007f" || data === "\b") {
      editing.buffer = [...editing.buffer].slice(0, -1).join("");
      return;
    }
    // Drop control sequences; arrow keys and the like carry no text.
    if (data.startsWith("\u001b") || /[\u0000-\u001f]/.test(data)) return;
    if (editing.buffer.length + data.length <= MAX_DRAFT_TEXT) editing.buffer += data;
  }
}

export function createGrillWidget(
  getState: () => GrillState | undefined,
  theme: GrillTheme,
  getOptions?: () => GrillWidgetOptions,
): GrillWidget {
  return new GrillWidget(getState, theme, getOptions);
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
