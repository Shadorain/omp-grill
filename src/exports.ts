import type { GrillState, Question } from "./types";

/** An exported file: a project-relative path and the bytes to write there. */
export interface ExportFile {
  path: string;
  contents: string;
}

export const EXPORT_KINDS = ["report", "diagram", "prototype", "adr", "beads"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** Default project-relative destination for each kind. */
export const EXPORT_DEFAULTS: Record<ExportKind, string> = {
  report: "docs/grill-report.md",
  diagram: "docs/grill-diagram.svg",
  prototype: "docs/grill-prototype.html",
  adr: "docs/adr",
  beads: "docs/grill-beads.json",
};

/**
 * One ADR per durable decision, numbered after the highest existing record.
 *
 * `durable` already means hard to reverse, surprising without context, and the
 * result of a real tradeoff, which is exactly when an ADR is worth writing.
 */
export function renderAdrs(state: GrillState, dir: string, used: number[]): ExportFile[] {
  const decisions = state.questions.filter((q) => q.durable && q.status === "answered" && q.answer);
  if (!decisions.length) throw new Error("No durable decisions to export; mark decisions durable first");
  let next = Math.max(0, ...used);
  const files: ExportFile[] = [];
  for (const question of decisions) {
    next += 1;
    const number = String(next).padStart(4, "0");
    files.push({ path: `${dir}/${number}-${slug(question.title)}.md`, contents: adrBody(state, question) });
  }
  return files;
}

function adrBody(state: GrillState, question: Question): string {
  const chosen = labelOf(question, question.answer?.option) ?? question.answer?.text ?? "";
  const lines = [`# ${question.title}`, ""];
  const context = question.body ?? state.context.intent;
  if (context) lines.push(context, "");
  const rationale = question.answer?.option ? question.answer.text : undefined;
  lines.push(`We chose ${chosen}. ${rationale ?? question.recommendation.reason}`.trim(), "");

  const rejected = question.options.filter((option) => option.id !== question.answer?.option);
  if (question.answer?.option && rejected.length) {
    lines.push("## Considered Options", "");
    for (const option of question.options) {
      const exploration = question.explore?.find((row) => row.option === option.id);
      const verdict = option.id === question.answer?.option ? "Chosen" : "Rejected";
      lines.push(`- **${option.label}** (${verdict})`);
      if (exploration?.pros.length) lines.push(`  - For: ${exploration.pros.join("; ")}`);
      if (exploration?.cons.length) lines.push(`  - Against: ${exploration.cons.join("; ")}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * A `bd create --graph` plan: an epic for the interview, a task per settled
 * decision, and `blocked-by` edges mirroring each question's `dependsOn`.
 * Open questions are omitted because nothing has been decided yet.
 */
export function renderBeadsPlan(state: GrillState): string {
  const settled = state.questions.filter((q) => q.status === "answered" || q.status === "deferred");
  if (!settled.length) throw new Error("No settled decisions to export; answer or defer a question first");
  const epicKey = `grill-${state.id.slice(0, 8)}`;
  const ticket = /https:\/\/linear\.app\/[a-zA-Z0-9_-]+\/issue\/[A-Z][A-Z0-9]*-\d+(?:\/[a-zA-Z0-9_-]+)?\b/.exec(state.topic)?.[0];
  const nodes: Record<string, unknown>[] = [{
    key: epicKey,
    title: state.topic,
    type: "epic",
    labels: ["grill"],
    ...(state.context.intent ? { description: state.context.intent } : {}),
    ...(state.note ? { notes: state.note } : {}),
    ...(ticket ? { external_ref: ticket } : {}),
  }];
  const keys: Record<string, string> = {};
  for (const question of settled) keys[question.id] = `${epicKey}-${slug(question.id)}`;

  for (const question of settled) {
    const deferred = question.status === "deferred";
    const design = beadsDesign(question);
    nodes.push({
      key: keys[question.id],
      title: question.title,
      type: "task",
      parent_key: epicKey,
      labels: deferred ? ["grill", "deferred"] : ["grill"],
      description: deferred
        ? `Deferred during the interview.${question.deferUntil ? ` Revisit when ${question.deferUntil}` : ""}`
        : `Decision: ${labelOf(question, question.answer?.option) ?? question.answer?.text ?? "(recorded)"}`,
      ...(design ? { design } : {}),
      ...(deferred ? { status: "blocked" } : {}),
    });
  }

  const edges: Record<string, string>[] = [];
  for (const question of settled) {
    for (const dependency of question.dependsOn ?? []) {
      const target = keys[dependency];
      // Dependencies on unsettled questions have no task to point at.
      if (target) edges.push({ from_key: keys[question.id]!, to_key: target, type: "blocked-by" });
    }
  }
  return `${JSON.stringify({ nodes, ...(edges.length ? { edges } : {}) }, null, 2)}\n`;
}

function beadsDesign(question: Question): string {
  const parts: string[] = [];
  if (question.body) parts.push(question.body);
  if (question.answer?.option && question.answer.text) parts.push(`Rationale: ${question.answer.text}`);
  const rejected = question.options.filter((option) => option.id !== question.answer?.option);
  if (question.answer?.option && rejected.length)
    parts.push(`Rejected: ${rejected.map((option) => option.label).join("; ")}`);
  return parts.join("\n\n");
}

function labelOf(question: Question, optionId: string | undefined): string | undefined {
  if (!optionId) return undefined;
  return question.options.find((option) => option.id === optionId)?.label ?? optionId;
}

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return cleaned.replace(/-+$/, "") || "decision";
}
