import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  Action,
  Diagram,
  DiagramSpec,
  DraftAnswer,
  DraftPatch,
  DraftState,
  GrillState,
  InterviewContext,
  Prototype,
  Publish,
  Question,
  QuestionInput,
  Store,
  Submission,
} from "./types";
import { renderDiagram } from "./diagram";
import { renderPrototype, validatePrototypeSpec } from "./prototype";
import { workspaceRoot } from "./workspace";

const MAX_ACTIONS = 100;
const MAX_TEXT = 20_000;
const MAX_STATE = 5_000_000;
const MAX_THREAD = 200;
const MAX_HISTORY = 50;

function fail(message: string): never {
  throw new Error(message);
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validText(
  value: unknown,
  label: string,
  max = MAX_TEXT,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max
  )
    fail(`Invalid ${label}`);
}
function requiredText(value: unknown, label: string, max = MAX_TEXT): string {
  validText(value, label, max);
  return value;
}
function optionalString(
  value: Record<string, unknown>,
  key: string,
  max = MAX_TEXT,
): string | undefined {
  if (value[key] === undefined) return undefined;
  return requiredText(value[key], key, max);
}

function isQuestionInput(value: unknown): value is QuestionInput {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string"
  )
    return false;
  if (value.body !== undefined && typeof value.body !== "string") return false;
  if (
    !Array.isArray(value.options) ||
    !value.options.every(
      (option) =>
        isRecord(option) &&
        typeof option.id === "string" &&
        typeof option.label === "string",
    )
  )
    return false;
  if (
    !isRecord(value.recommendation) ||
    typeof value.recommendation.reason !== "string" ||
    (value.recommendation.option !== undefined &&
      typeof value.recommendation.option !== "string")
  )
    return false;
  if (
    value.dependsOn !== undefined &&
    (!Array.isArray(value.dependsOn) ||
      !value.dependsOn.every((id) => typeof id === "string"))
  )
    return false;
  if (value.durable !== undefined && typeof value.durable !== "boolean")
    return false;
  if (
    value.explore !== undefined &&
    (!Array.isArray(value.explore) ||
      !value.explore.every(
        (row) =>
          isRecord(row) &&
          typeof row.option === "string" &&
          Array.isArray(row.pros) &&
          row.pros.every((item) => typeof item === "string") &&
          Array.isArray(row.cons) &&
          row.cons.every((item) => typeof item === "string"),
      ))
  )
    return false;
  return true;
}
function isQuestion(value: unknown): value is Question {
  if (!isRecord(value)) return false;
  const { status, thread, answer } = value;
  if (
    !isQuestionInput(value) ||
    !["open", "answered", "deferred"].includes(String(status))
  )
    return false;
  if (
    !Array.isArray(thread) ||
    !thread.every(
      (item) =>
        isRecord(item) &&
        (item.role === "user" || item.role === "agent") &&
        typeof item.text === "string",
    )
  )
    return false;
  if (
    answer !== undefined &&
    (!isRecord(answer) ||
      (answer.option !== undefined &&
        typeof answer.option !== "string") ||
      (answer.text !== undefined && typeof answer.text !== "string"))
  )
    return false;
  return true;
}
function parseQuestions(value: unknown): Question[] {
  if (!Array.isArray(value) || !value.every(isQuestion))
    fail("Invalid session questions");
  return value;
}
function isAction(action: unknown): action is Action {
  if (!isRecord(action) || typeof action.type !== "string") return false;
  if (action.type === "finish" || action.type === "visualize")
    return action.kind === undefined || action.kind === "diagram" || action.kind === "prototype";
  if (action.type === "visual-feedback")
    return typeof action.text === "string" && (action.kind === undefined || action.kind === "diagram" || action.kind === "prototype");
  if (typeof action.q !== "string") return false;
  if (action.type === "answer")
    return (
      (action.option === undefined || typeof action.option === "string") &&
      (action.text === undefined || typeof action.text === "string") &&
      (action.option !== undefined || action.text !== undefined)
    );
  if (action.type === "thread") return typeof action.text === "string";
  return (
    action.type === "explore" ||
    action.type === "defer" ||
    action.type === "reopen"
  );
}
function parseActions(value: unknown): Action[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ACTIONS)
    fail("Invalid action batch");
  const actions: Action[] = [];
  for (const raw of value) {
    if (!isAction(raw)) fail("Invalid action");
    if (raw.type === "finish") {
      actions.push({ type: "finish" });
      continue;
    }
    if (raw.type === "visualize") {
      actions.push({ type: "visualize", ...(raw.kind === undefined ? {} : { kind: raw.kind }) });
      continue;
    }
    if (raw.type === "visual-feedback") {
      validText(raw.text, "visual feedback");
      actions.push({ type: raw.type, text: raw.text, ...(raw.kind === undefined ? {} : { kind: raw.kind }) });
      continue;
    }
    validText(raw.q, "question id", 200);
    if (raw.type === "answer") {
      if (raw.option !== undefined) validText(raw.option, "option id", 200);
      if (raw.text !== undefined) validText(raw.text, "answer text");
      actions.push({
        type: "answer",
        q: raw.q,
        ...(raw.option === undefined ? {} : { option: raw.option }),
        ...(raw.text === undefined ? {} : { text: raw.text }),
      });
    } else if (raw.type === "thread") {
      validText(raw.text, "thread text");
      actions.push({ type: "thread", q: raw.q, text: raw.text });
    } else actions.push({ type: raw.type, q: raw.q });
  }
  return actions;
}
function parseExplorations(value: unknown): NonNullable<Question["explore"]> {
  if (!Array.isArray(value)) fail("Invalid explorations");
  return value.map((row) => {
    if (
      !isRecord(row) ||
      typeof row.option !== "string" ||
      !Array.isArray(row.pros) ||
      !Array.isArray(row.cons)
    )
      fail("Invalid exploration");
    return {
      option: requiredText(row.option, "exploration option", 200),
      pros: row.pros.map((item: unknown) =>
        requiredText(item, "exploration pro"),
      ),
      cons: row.cons.map((item: unknown) =>
        requiredText(item, "exploration con"),
      ),
    };
  });
}
function applyContextPatch(
  target: InterviewContext,
  patch: unknown,
): void {
  if (!isRecord(patch)) fail("Invalid context patch");
  if (patch.intent !== undefined) {
    if (typeof patch.intent !== "string" || patch.intent.length > MAX_TEXT)
      fail("Invalid context intent");
    target.intent = patch.intent;
  }
  if (patch.docPath !== undefined) {
    if (typeof patch.docPath !== "string" || patch.docPath.length > 1000)
      fail("Invalid context docPath");
    target.docPath = patch.docPath;
  }
  if (patch.terms !== undefined) {
    if (!Array.isArray(patch.terms) || patch.terms.length > 200)
      fail("Invalid context terms");
    const merged = new Map(target.terms.map((row) => [row.term, row]));
    for (const raw of patch.terms) {
      if (!isRecord(raw)) fail("Invalid context term");
      const term = requiredText(raw.term, "term key", 200);
      if (raw.remove === true) { merged.delete(term); continue; }
      if (
        raw.avoid !== undefined &&
        (!Array.isArray(raw.avoid) ||
          raw.avoid.some((item) => typeof item !== "string"))
      )
        fail("Invalid avoid list");
      merged.set(term, {
        term,
        definition: requiredText(raw.definition, "term definition"),
        ...(raw.avoid === undefined
          ? {}
          : {
              avoid: (raw.avoid as unknown[]).map((item) =>
                requiredText(item, "avoid term", 1000),
              ),
            }),
      });
    }
    if (merged.size > 200) fail("Too many glossary terms");
    target.terms = [...merged.values()];
  }
  if (patch.facts !== undefined) {
    if (!Array.isArray(patch.facts) || patch.facts.length > 200)
      fail("Invalid context facts");
    const merged = new Map(target.facts.map((row) => [row.id, row]));
    for (const raw of patch.facts) {
      if (!isRecord(raw)) fail("Invalid context fact");
      const id = requiredText(raw.id, "fact id", 200);
      if (raw.remove === true) { merged.delete(id); continue; }
      merged.set(id, {
        id,
        text: requiredText(raw.text, "fact text"),
        ...(raw.source === undefined ? {} : { source: requiredText(raw.source, "fact source", 2000) }),
      });
    }
    if (merged.size > 200) fail("Too many facts");
    target.facts = [...merged.values()];
  }
  if (patch.risks !== undefined) {
    if (!Array.isArray(patch.risks) || patch.risks.length > 200)
      fail("Invalid context risks");
    const merged = new Map(target.risks.map((row) => [row.id, row]));
    for (const raw of patch.risks) {
      if (!isRecord(raw)) fail("Invalid context risk");
      const id = requiredText(raw.id, "risk id", 200);
      if (raw.remove === true) { merged.delete(id); continue; }
      merged.set(id, {
        id,
        text: requiredText(raw.text, "risk text"),
        ...(raw.mitigation === undefined
          ? {}
          : { mitigation: requiredText(raw.mitigation, "risk mitigation") }),
      });
    }
    if (merged.size > 200) fail("Too many risks");
    target.risks = [...merged.values()];
  }
}

function validateQuestions(questions: Question[]): void {
  const ids = new Set<string>();
  for (const q of questions) {
    validText(q.id, "question id", 200);
    validText(q.title, "question title", 1000);
    if (q.body !== undefined) validText(q.body, "question body");
    if (!Array.isArray(q.options) || q.options.length > 4)
      fail(`Invalid options for ${q.id}`);
    const options = new Set<string>();
    for (const option of q.options) {
      validText(option.id, "option id", 200);
      validText(option.label, "option label", 1000);
      if (options.has(option.id)) fail(`Duplicate option id: ${option.id}`);
      options.add(option.id);
    }
    if (
      q.recommendation.option !== undefined &&
      !options.has(q.recommendation.option)
    )
      fail(`Unknown recommendation for ${q.id}`);
    validText(q.recommendation.reason, "recommendation reason");
    if (q.status === "answered") {
      if (
        !q.answer ||
        (q.answer.option === undefined && q.answer.text === undefined)
      )
        fail(`Answered question lacks decision: ${q.id}`);
      if (q.answer.option !== undefined && !options.has(q.answer.option))
        fail(`Invalid answer option for ${q.id}`);
      if (q.answer.text !== undefined) validText(q.answer.text, "answer text");
    } else if (q.answer !== undefined)
      fail(`Unanswered question has decision: ${q.id}`);
    if (!Array.isArray(q.thread)) fail(`Invalid thread for ${q.id}`);
    for (const item of q.thread) {
      if (item.role !== "user" && item.role !== "agent")
        fail(`Invalid thread role for ${q.id}`);
      validText(item.text, "thread text");
    }
    if (
      q.dependsOn &&
      (!Array.isArray(q.dependsOn) ||
        !q.dependsOn.every((id) => typeof id === "string") ||
        new Set(q.dependsOn).size !== q.dependsOn.length)
    )
      fail(`Invalid dependencies for ${q.id}`);
    if (q.explore)
      for (const exploration of q.explore) {
        if (
          !options.has(exploration.option) ||
          !Array.isArray(exploration.pros) ||
          !Array.isArray(exploration.cons)
        )
          fail(`Invalid exploration for ${q.id}`);
        for (const item of [...exploration.pros, ...exploration.cons])
          validText(item, "exploration item");
      }
    if (ids.has(q.id)) fail(`Duplicate question id: ${q.id}`);
    ids.add(q.id);
  }
  const byId = new Map(questions.map((q) => [q.id, q]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) fail(`Question dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dependency))
        fail(`Unknown dependency ${dependency} for ${id}`);
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
}

function report(state: GrillState): string {
  const lines = [`# Grill report: ${state.topic}`, "", `Project: ${state.project}`, `Session: ${state.id}`, `Created: ${state.createdAt}`, ""];
  if (state.context.intent) lines.push("## Intent", "", state.context.intent, "");
  if (state.note) lines.push("## Summary", "", state.note, "");
  if (state.context.terms.length) {
    lines.push("## Glossary", "");
    for (const item of state.context.terms) {
      lines.push(`- **${item.term}:** ${item.definition}`);
      if (item.avoid?.length) lines.push(`  - Avoid: ${item.avoid.join(", ")}`);
    }
    lines.push("");
  }
  const answered = state.questions.filter((q) => q.status === "answered").length;
  const open = state.questions.filter((q) => q.status === "open").length;
  const deferred = state.questions.filter((q) => q.status === "deferred").length;
  lines.push("## Decisions", "", `Answered: ${answered} · Open: ${open} · Deferred: ${deferred}`, "");
  for (const q of state.questions) {
    lines.push(`### ${q.title}`, "");
    if (q.body) lines.push(q.body, "");
    lines.push(`Status: ${q.status}`, `Recommendation: ${q.recommendation.reason}`);
    if (q.recommendation.option) lines.push(`Recommended option: ${q.options.find((option) => option.id === q.recommendation.option)?.label ?? q.recommendation.option}`);
    if (q.durable) lines.push("Durable decision: Yes");
    if (q.answer) {
      const chosen = q.answer.option ? (q.options.find((option) => option.id === q.answer!.option)?.label ?? q.answer.option) : undefined;
      lines.push(`Decision: ${chosen ?? q.answer.text ?? "(no answer text)"}`);
      if (q.answer.text && chosen) lines.push(`Rationale: ${q.answer.text}`);
      if (q.answer.option !== undefined) {
        const rejected = q.options.filter((option) => option.id !== q.answer!.option);
        if (rejected.length) lines.push(`Rejected options: ${rejected.map((option) => option.label).join("; ")}`);
      }
    } else if (q.status === "deferred") lines.push("Decision: Deferred");
    if (q.dependsOn?.length) lines.push(`Depends on: ${q.dependsOn.join(", ")}`);
    for (const exploration of q.explore ?? []) {
      const label = q.options.find((option) => option.id === exploration.option)?.label ?? exploration.option;
      lines.push(`Exploration: ${label}`);
      if (exploration.pros.length) lines.push(`Pros: ${exploration.pros.join("; ")}`);
      if (exploration.cons.length) lines.push(`Cons: ${exploration.cons.join("; ")}`);
    }
    for (const item of q.thread) lines.push(`- ${item.role === "user" ? "User" : "Agent"}: ${item.text}`);
    lines.push("");
  }
  if (state.context.facts.length) {
    lines.push("## Facts", "");
    for (const fact of state.context.facts) lines.push(`- ${fact.text}${fact.source ? ` (Source: ${fact.source})` : ""}`);
    lines.push("");
  }
  if (state.context.risks.length) {
    lines.push("## Risks", "");
    for (const risk of state.context.risks) lines.push(`- ${risk.text}${risk.mitigation ? ` Mitigation: ${risk.mitigation}` : ""}`);
    lines.push("");
  }
  if (state.diagram) lines.push("## System diagram", "", `${state.diagram.title} (${state.diagram.kind}, v${state.diagram.version})${state.diagram.stale ? " — stale; refresh explicitly" : ""}`, "");
  if (state.prototype) lines.push("## Interactive prototype", "", `${state.prototype.title} (v${state.prototype.version})${state.prototype.stale ? " — stale; refresh explicitly" : ""}`, "");
  return `${lines.join("\n").trimEnd()}\n`;
}

function contextBrief(state: GrillState) {
  return {
    ...(state.context.intent === undefined
      ? {}
      : { intent: state.context.intent }),
    terms: state.context.terms.map((row) => row.term),
    facts: state.context.facts.map((row) => row.id),
    risks: state.context.risks.map((row) => row.id),
  };
}

export function compactSubmission(
  state: GrillState,
  submission: Submission,
): string {
  const actions = submission.actions;
  const relevant = new Set(
    actions.flatMap((action) => ("q" in action ? [action.q] : [])),
  );
  const wantsThread = actions.some(
    (action) => action.type === "thread" || action.type === "explore",
  );
  const wantsVisual = actions.some(
    (action) => action.type === "visualize" || action.type === "visual-feedback",
  );
  const wantsDiagram = actions.some(
    (action) => (action.type === "visualize" || action.type === "visual-feedback") && (action.kind ?? "diagram") === "diagram",
  );
  const wantsPrototype = actions.some(
    (action) => (action.type === "visualize" || action.type === "visual-feedback") && action.kind === "prototype",
  );
  const questions = state.questions
    .filter((q) => relevant.has(q.id))
    .map((q) => ({
      id: q.id,
      title: q.title,
      body: q.body,
      options: q.options,
      recommendation: q.recommendation,
      dependsOn: q.dependsOn,
      status: q.status,
      answer: q.answer,
      ...(wantsThread ? { thread: q.thread.slice(-4) } : {}),
      ...(actions.some(
        (action) => action.type === "explore" && action.q === q.id,
      )
        ? { explore: q.explore?.slice(-3) }
        : {}),
    }));
  return JSON.stringify({
    id: state.id,
    seq: submission.seq,
    project: state.project,
    topic: state.topic,
    note: state.note,
    context: contextBrief(state),
    actions,
    questions,
    ...(wantsVisual
      ? {
          ...(wantsDiagram ? { diagram: state.diagram && {
            title: state.diagram.title,
            kind: state.diagram.kind,
            nodes: state.diagram.nodes,
            edges: state.diagram.edges,
            version: state.diagram.version,
            stale: state.diagram.stale,
            thread: state.diagram.thread.slice(-6),
          } } : {}),
          ...(wantsPrototype ? {
            prototype: state.prototype && {
              title: state.prototype.title,
              start: state.prototype.start,
              screens: state.prototype.screens,
              app: state.prototype.app,
              theme: state.prototype.theme,
              version: state.prototype.version,
              stale: state.prototype.stale,
              thread: state.prototype.thread.slice(-6),
            },
            prototypeContext: {
              intent: state.context.intent,
              terms: state.context.terms.slice(-20),
              facts: state.context.facts.slice(-20),
              risks: state.context.risks.slice(-20),
              assumptions: state.questions
                .filter((q) => q.status !== "answered")
                .map((q) => ({
                  id: q.id,
                  title: q.title,
                  recommendation: q.recommendation,
                  options: q.options,
                  status: q.status,
                })),
              decisions: state.questions
                .filter((q) => q.status === "answered" && q.answer)
                .map((q) => ({ id: q.id, title: q.title, answer: q.answer })),
            },
          } : {}),
        }
      : {}),
  });
}

export function compactState(state: GrillState): string {
  const questions = state.questions.map((q) =>
    q.status === "answered"
      ? { id: q.id, title: q.title, status: q.status, answer: q.answer }
      : {
          id: q.id,
          title: q.title,
          status: q.status,
          body: q.body,
          options: q.options,
          recommendation: q.recommendation,
          dependsOn: q.dependsOn,
          durable: q.durable,
        },
  );
  return JSON.stringify({
    id: state.id,
    project: state.project,
    topic: state.topic,
    status: state.status,
    seq: state.seq,
    handled: state.handled,
    note: state.note,
    context: contextBrief(state),
    pending: state.pending && {
      seq: state.pending.seq,
      actions: state.pending.actions,
    },
    questions,
  });
}

function persistSync(dir: string, state: GrillState): void {
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_STATE)
    fail("Session state exceeds size limit");
  const tmp = join(dir, `.state-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, serialized, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, join(dir, "state.json"));
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}
function persistReport(path: string, text: string): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, path);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function exportTarget(project: string, path: string, overwrite: boolean): string {
  validText(path, "export path", 1000);
  if (isAbsolute(path)) fail("Export path must be relative to the project");
  const projectRoot = resolve(project);
  const target = resolve(projectRoot, path);
  const rel = relative(projectRoot, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) fail("Export path must stay within the project");
  let cursor = projectRoot;
  for (const part of rel.split(sep).slice(0, -1)) {
    cursor = join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) fail("Export path cannot traverse symlinks");
    } catch (error) { if (!isRecord(error) || error.code !== "ENOENT") throw error; }
  }
  try {
    if (fs.lstatSync(target).isSymbolicLink()) fail("Export path cannot be a symlink");
  } catch (error) { if (!isRecord(error) || error.code !== "ENOENT") throw error; }
  if (fs.existsSync(target) && !overwrite) fail("Export target exists; confirm overwrite to replace it");
  fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  return target;
}

function buildStore(dir: string, state: GrillState): Store {
  const save = (next: GrillState) => {
    // Keep long sessions under MAX_STATE: retain only the most recent conversation and history.
    for (const q of next.questions) {
      if (q.thread.length > MAX_THREAD) q.thread = q.thread.slice(-MAX_THREAD);
      if (q.history && q.history.length > MAX_HISTORY) q.history = q.history.slice(-MAX_HISTORY);
    }
    for (const artifact of [next.diagram, next.prototype])
      if (artifact && artifact.thread.length > MAX_THREAD) artifact.thread = artifact.thread.slice(-MAX_THREAD);
    next.updatedAt = new Date().toISOString();
    persistSync(dir, next);
    for (const key of ["pending", "error", "reportPath", "note"] as const)
      if (!(key in next)) delete state[key];
    Object.assign(state, next);
  };
  return {
    dir,
    state,
    claim(): void {
      const lockPath = join(dir, ".lease");
      try {
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
      } catch {
        let live = true;
        try {
          const lease: unknown = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          if (isRecord(lease) && lease.pid === process.pid) return; // Taken by resumeStore in this process.
          if (isRecord(lease) && typeof lease.pid === "number") {
            try { process.kill(lease.pid, 0); } catch (probe) {
              if (isRecord(probe) && probe.code === "ESRCH") live = false;
            }
          }
        } catch { live = false; }
        if (live) fail("Session has a live server lease");
        fs.rmSync(lockPath, { force: true });
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
      }
    },
    release(): void {
      const lockPath = join(dir, ".lease");
      try {
        const lease: unknown = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (isRecord(lease) && lease.pid === process.pid) fs.rmSync(lockPath, { force: true });
      } catch { /* Lease already absent. */ }
    },
    saveDrafts(patch: DraftPatch): DraftState {
      if (!Number.isSafeInteger(patch.revision) || patch.revision !== state.drafts.revision)
        fail(`Draft revision conflict (current ${state.drafts.revision})`);
      const next = clone(state);
      const recovery = next.drafts.recovery;
      for (const [kind, values] of [["answer", patch.answers], ["thread", patch.threads]] as const) {
        if (!values) continue;
        for (const key of Object.keys(values)) {
          validText(key, "draft question id", 200);
          if (!next.questions.some((question) => question.id === key)) fail(`Unknown question: ${key}`);
          const value = values[key];
          if (value === null) {
            if (kind === "answer" && Object.hasOwn(next.drafts.answers, key)) {
              const answer = next.drafts.answers[key]!;
              recovery.push({ id: randomUUID(), q: key, kind, at: new Date().toISOString(), answer: clone(answer) });
              delete next.drafts.answers[key];
            } else if (kind === "thread" && Object.hasOwn(next.drafts.threads, key)) {
              const text = next.drafts.threads[key]!;
              recovery.push({ id: randomUUID(), q: key, kind, at: new Date().toISOString(), text });
              delete next.drafts.threads[key];
            }
          } else if (kind === "answer") {
            if (!isRecord(value) || (value.option !== undefined && typeof value.option !== "string") || (value.text !== undefined && typeof value.text !== "string") || (value.option === undefined && value.text === undefined)) fail(`Invalid answer draft for ${key}`);
            if (value.option !== undefined && !next.questions.find((question) => question.id === key)!.options.some((option) => option.id === value.option)) fail(`Unknown option for ${key}`);
            if (value.text !== undefined && value.text.length > MAX_TEXT) fail("Invalid draft answer text");
            next.drafts.answers[key] = clone(value as DraftAnswer);
          } else {
            if (typeof value !== "string" || value.length > MAX_TEXT) fail("Invalid thread draft");
            next.drafts.threads[key] = value;
          }
        }
      }
      next.drafts.recovery = recovery.slice(-50);
      next.drafts.revision++;
      save(next);
      return clone(state.drafts);
    },
    updateContext(patch: Partial<InterviewContext>): void {
      if (!isRecord(patch)) fail("Invalid context patch");
      const next = clone(state);
      applyContextPatch(next.context, patch);
      save(next);
    },
    previewReport(): string { return report(state); },
    exportReport(path: string, overwrite = false): string {
      if (state.status !== "finished") fail("Export requires a finished interview");
      const target = exportTarget(state.project, path, overwrite);
      persistReport(target, report(state));
      const next = clone(state);
      next.exportedPath = target;
      next.context.docPath = relative(resolve(state.project), target);
      save(next);
      return target;
    },
    exportVisual(kind: "diagram" | "prototype", path: string, overwrite = false): string {
      if (state.status !== "finished") fail("Export requires a finished interview");
      if (kind === "diagram" ? !state.diagram : !state.prototype) fail(`No ${kind} available`);
      const target = exportTarget(state.project, path, overwrite);
      let contents: string;
      if (kind === "diagram") {
        if (!state.diagram) fail("No diagram available");
        contents = renderDiagram(state.diagram);
      } else {
        if (!state.prototype) fail("No prototype available");
        contents = renderPrototype(state.prototype);
      }
      persistReport(target, contents);
      return target;
    },
    publish(patch: Publish): void {
      if (!isRecord(patch)) fail("Invalid publish patch");
      if (state.status === "paused" || state.status === "finished")
        fail(`Cannot publish to ${state.status} session`);
      if (
        patch.questions !== undefined &&
        (!Array.isArray(patch.questions) ||
          patch.questions.length > 3 ||
          !patch.questions.every(isQuestionInput))
      )
        fail("Publish accepts at most three valid questions");
      const next = clone(state);
      if (patch.handled !== undefined) {
        if (
          !Number.isSafeInteger(patch.handled) ||
          !next.pending ||
          patch.handled !== next.pending.seq
        )
          fail("Publish acknowledgement does not match pending submission");
        next.handled = patch.handled;
        delete next.pending;
        if (next.status === "working" || next.status === "error")
          next.status = "waiting";
        delete next.error;
      }
      let recommendationChanged = false;
      if (patch.questions) {
        for (const incoming of patch.questions) {
          const existing = next.questions.find((q) => q.id === incoming.id);
          if (existing?.status === "answered") continue;
          const questionRecommendationChanged =
            existing !== undefined &&
            (existing.recommendation.option !== incoming.recommendation.option ||
              existing.recommendation.reason !== incoming.recommendation.reason);
          recommendationChanged ||= questionRecommendationChanged;
          const value = clone(incoming);
          delete value.answer;
          const question: Question = {
            ...value,
            status: existing?.status ?? "open",
            thread: existing?.thread ?? [],
            ...(existing?.history ? { history: existing.history } : {}),
            ...(questionRecommendationChanged ? { recommendationUpdated: true } : {}),
          };
          if (existing)
            next.questions[next.questions.indexOf(existing)] = question;
          else next.questions.push(question);
        }
        for (const incoming of patch.questions) {
          const current = next.questions.find((q) => q.id === incoming.id);
          if (current?.status === "answered") continue;
          for (const dependency of incoming.dependsOn ?? []) {
            const prerequisite = next.questions.find(
              (q) => q.id === dependency,
            );
            if (prerequisite && prerequisite.status !== "answered")
              fail(`Unsettled prerequisite ${dependency} for ${incoming.id}`);
          }
        }
      }
      if (patch.replies !== undefined) {
        if (!Array.isArray(patch.replies)) fail("Invalid replies");
        for (const reply of patch.replies) {
          if (!isRecord(reply)) fail("Invalid reply");
          validText(reply.q, "reply question id", 200);
          validText(reply.text, "reply text");
          const q = next.questions.find((item) => item.id === reply.q);
          if (!q) fail(`Unknown question: ${reply.q}`);
          q.thread.push({ role: "agent", text: reply.text });
        }
      }
      if (patch.explorations !== undefined) {
        if (!Array.isArray(patch.explorations)) fail("Invalid explorations");
        for (const result of patch.explorations) {
          if (
            !isRecord(result) ||
            typeof result.q !== "string" ||
            !Array.isArray(result.rows)
          )
            fail("Invalid exploration");
          const q = next.questions.find((item) => item.id === result.q);
          if (!q) fail(`Unknown question: ${result.q}`);
          q.explore = parseExplorations(result.rows);
        }
      }
      if (patch.context !== undefined) applyContextPatch(next.context, patch.context);
      if (patch.diagram !== undefined) {
        const thread = next.diagram?.thread ?? [];
        next.diagram = { ...validateDiagramSpec(patch.diagram), version: (next.diagram?.version ?? 0) + 1, stale: false, thread };
      }
      if (patch.diagramReply !== undefined) {
        validText(patch.diagramReply, "diagram reply");
        if (next.diagram) next.diagram.thread.push({ role: "agent", text: patch.diagramReply });
      }
      if (patch.prototype !== undefined) {
        const thread = next.prototype?.thread ?? [];
        next.prototype = { ...validatePrototypeSpec(patch.prototype), version: (next.prototype?.version ?? 0) + 1, stale: false, thread };
      }
      if (patch.prototypeReply !== undefined) {
        validText(patch.prototypeReply, "prototype reply");
        if (next.prototype) next.prototype.thread.push({ role: "agent", text: patch.prototypeReply });
      }
      if (patch.note !== undefined) {
        validText(patch.note, "note");
        next.note = patch.note;
      }
      if (recommendationChanged && next.diagram && patch.diagram === undefined) next.diagram.stale = true;
      if (recommendationChanged && next.prototype && patch.prototype === undefined) next.prototype.stale = true;
      validateQuestions(next.questions);
      if (!next.pending) next.status = "waiting";
      save(next);
    },
    submit(input: unknown, options?: { requestId?: string; draftRevision?: number }): Submission {
      const actions = parseActions(input);
      const requestId = options?.requestId;
      if (requestId !== undefined) validText(requestId, "request id", 200);
      if (requestId && state.lastSubmission?.requestId === requestId) {
        if (JSON.stringify(state.lastSubmission.actions) !== JSON.stringify(actions)) fail("Request ID already used with different actions");
        return clone(state.lastSubmission);
      }
      if (options?.draftRevision !== undefined && options.draftRevision !== state.drafts.revision)
        fail(`Draft revision conflict (current ${state.drafts.revision})`);
      if (state.status === "finished") fail("Session is finished");
      if (state.status === "paused") fail("Session is paused");
      if (state.status === "working" && !state.pending) fail("Session is working");
      if (state.pending) fail("Submission already pending");
      const finishAt = actions.findIndex((action) => action.type === "finish");
      if (finishAt !== -1 && finishAt !== actions.length - 1) fail("Finish must be last action");
      const next = clone(state);
      for (const action of actions) {
        if (action.type === "finish" || action.type === "visualize") continue;
        if (action.type === "visual-feedback") {
          const kind = action.kind ?? "diagram";
          const artifact = kind === "diagram" ? next.diagram : next.prototype;
          if (!artifact) fail(`Visual feedback requires an existing ${kind}`);
          artifact.thread.push({ role: "user", text: action.text });
          artifact.stale = true;
          continue;
        }
        const q = next.questions.find((item) => item.id === action.q);
        if (!q) fail(`Unknown question: ${action.q}`);
        if (action.type === "answer") {
          if (action.option !== undefined && !q.options.some((option) => option.id === action.option)) fail(`Unknown option for ${q.id}`);
          if (q.answer) q.history = [...(q.history ?? []), { at: new Date().toISOString(), reason: "changed", answer: clone(q.answer) }];
          q.answer = { ...(action.option === undefined ? {} : { option: action.option }), ...(action.text === undefined ? {} : { text: action.text }) };
          q.status = "answered";
        } else if (action.type === "thread") q.thread.push({ role: "user", text: action.text });
        else if (action.type === "defer" || action.type === "reopen") {
          if (q.answer) q.history = [...(q.history ?? []), { at: new Date().toISOString(), reason: action.type, answer: clone(q.answer) }];
          q.status = action.type === "defer" ? "deferred" : "open";
          delete q.answer;
        }
      }
      const decisionsChanged = actions.some((action) => action.type === "answer" || action.type === "reopen" || action.type === "defer");
      if (decisionsChanged && next.diagram) next.diagram.stale = true;
      if (decisionsChanged && next.prototype) next.prototype.stale = true;
      validateQuestions(next.questions);
      const seq = next.seq + 1;
      const submission: Submission = { seq, actions, ...(requestId ? { requestId } : {}) };
      next.seq = seq;
      next.lastSubmission = submission;
      if (options?.draftRevision !== undefined) {
        for (const action of actions) {
          // Senders trim text and drop empty fields; compare drafts the same way so sent drafts clear.
          if (action.type === "answer") {
            const draft = next.drafts.answers[action.q];
            if (draft && (draft.option || undefined) === action.option && (draft.text?.trim() || undefined) === (action.text?.trim() || undefined)) delete next.drafts.answers[action.q];
          } else if (action.type === "thread" && next.drafts.threads[action.q]?.trim() === action.text.trim()) delete next.drafts.threads[action.q];
        }
        next.drafts.revision++;
      }
      if (finishAt !== -1) {
        next.handled = seq;
        next.status = "finished";
        next.reportPath = join(dir, "report.md");
        persistReport(next.reportPath, report(next));
        if (next.diagram) persistReport(join(dir, "diagram.svg"), renderDiagram(next.diagram));
        if (next.prototype) persistReport(join(dir, "prototype.html"), renderPrototype(next.prototype));
      } else {
        next.pending = submission;
        next.status = "working";
        delete next.error;
      }
      save(next);
      return submission;
    },
    acknowledge(seq: number): void {
      if (!state.pending || state.pending.seq !== seq)
        fail("Acknowledgement does not match pending submission");
      const next = clone(state);
      next.handled = seq;
      delete next.pending;
      if (next.status === "working" || next.status === "error")
        next.status = "waiting";
      delete next.error;
      save(next);
    },
    setStatus(status, error): void {
      if (status === "finished" && state.status !== "finished")
        fail("Use finish to finish session");
      const next = clone(state);
      next.status = status;
      if (error !== undefined) {
        if (typeof error !== "string") fail("Invalid status error");
        next.error = error.slice(0, 2000).trim() || "Unknown error";
      } else delete next.error;
      save(next);
    },
    finish(): string {
      if (state.status !== "finished") {
        if (state.pending) fail("Cannot finish with pending submission");
        if (state.status === "working") fail("Session is working");
        const next = clone(state);
        next.status = "finished";
        next.reportPath = join(dir, "report.md");
        persistReport(next.reportPath, report(next));
        if (next.diagram) persistReport(join(dir, "diagram.svg"), renderDiagram(next.diagram));
        if (next.prototype) persistReport(join(dir, "prototype.html"), renderPrototype(next.prototype));
        save(next);
      }
      return state.reportPath ?? join(dir, "report.md");
    },
  };
}
function validateDiagramSpec(raw: unknown): DiagramSpec {
  if (!isRecord(raw) || typeof raw.title !== "string" || typeof raw.kind !== "string" || !["architecture", "flow", "sequence", "state"].includes(raw.kind)) fail("Invalid diagram spec");
  if (!Array.isArray(raw.nodes) || raw.nodes.length < 1 || raw.nodes.length > 30) fail("Invalid diagram nodes");
  if (!Array.isArray(raw.edges) || raw.edges.length > 60) fail("Invalid diagram edges");
  const nodes = raw.nodes.map((node) => {
    if (!isRecord(node)) fail("Invalid diagram node");
    return { id: requiredText(node.id, "diagram node id", 200), label: requiredText(node.label, "diagram node label", 500), ...(node.detail === undefined ? {} : { detail: requiredText(node.detail, "diagram node detail", 1000) }) };
  });
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) fail(`Duplicate diagram node id: ${node.id}`);
    ids.add(node.id);
  }
  const edges = raw.edges.map((edge) => {
    if (!isRecord(edge)) fail("Invalid diagram edge");
    const from = requiredText(edge.from, "diagram edge source", 200);
    const to = requiredText(edge.to, "diagram edge target", 200);
    if (!ids.has(from) || !ids.has(to)) fail(`Diagram edge references unknown node: ${from}`);
    return { from, to, ...(edge.label === undefined ? {} : { label: requiredText(edge.label, "diagram edge label", 500) }) };
  });
  return { title: requiredText(raw.title, "diagram title", 500), kind: raw.kind as DiagramSpec["kind"], nodes, edges };
}

function parseVisualThread(value: unknown, label: string): { role: "user" | "agent"; text: string }[] {
  if (!Array.isArray(value) || value.length > 1000) fail(`Invalid ${label} thread`);
  return value.map((item) => {
    if (!isRecord(item) || (item.role !== "user" && item.role !== "agent")) fail(`Invalid ${label} thread entry`);
    return { role: item.role, text: requiredText(item.text, `${label} thread text`) };
  });
}

function parsePrototype(value: unknown): Prototype {
  if (!isRecord(value) || !Number.isSafeInteger(value.version) || (value.version as number) < 1 || typeof value.stale !== "boolean") fail("Invalid prototype");
  if (Object.keys(value).some((key) => !["title", "start", "app", "theme", "screens", "version", "stale", "thread"].includes(key))) fail("Invalid prototype fields");
  return { ...validatePrototypeSpec({ title: value.title, start: value.start, app: value.app, theme: value.theme, screens: value.screens }), version: value.version as number, stale: value.stale, thread: parseVisualThread(value.thread, "prototype") };
}

function parseDiagram(value: unknown): Diagram {
  if (!isRecord(value) || !Number.isSafeInteger(value.version) || (value.version as number) < 1 || typeof value.stale !== "boolean") fail("Invalid diagram");
  return { ...validateDiagramSpec(value), version: value.version as number, stale: value.stale, thread: parseVisualThread(value.thread, "diagram") };
}

export function createStore(input: {
  home: string;
  owner: string;
  project: string;
  topic: string;
}): Store {
  validText(input.owner, "owner");
  validText(input.project, "project");
  validText(input.topic, "topic");
  const workspace = workspaceRoot(input.project);
  fs.mkdirSync(input.home, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const dir = join(input.home, id);
  fs.mkdirSync(dir, { mode: 0o700 });
  const now = new Date().toISOString();
  const state: GrillState = {
    id,
    owner: input.owner,
    project: input.project,
    workspace,
    topic: input.topic,
    createdAt: now,
    updatedAt: now,
    status: "waiting",
    seq: 0,
    handled: 0,
    questions: [],
    drafts: { revision: 0, answers: Object.create(null) as Record<string, DraftAnswer>, threads: Object.create(null) as Record<string, string>, recovery: [] },
    context: { terms: [], facts: [], risks: [] },
  };
  persistSync(dir, state);
  return buildStore(dir, state);
}

export function loadStore(dir: string, owner: string): Store {
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) fail("Session path is not a directory");
  const raw = fs.readFileSync(join(dir, "state.json"));
  if (raw.byteLength > MAX_STATE) fail("Session state exceeds size limit");
  const value: unknown = JSON.parse(raw.toString("utf8"));
  if (!isRecord(value)) fail("Invalid session state");
  if (value.owner !== owner) fail("Session owner mismatch");
  const status = value.status;
  if (
    status !== "waiting" &&
    status !== "working" &&
    status !== "paused" &&
    status !== "finished" &&
    status !== "error"
  )
    fail("Invalid session status");
  const seq = value.seq;
  const handled = value.handled;
  if (
    typeof seq !== "number" ||
    !Number.isSafeInteger(seq) ||
    seq < 0 ||
    typeof handled !== "number" ||
    !Number.isSafeInteger(handled) ||
    handled < 0 ||
    handled > seq
  )
    fail("Invalid session counters");
  const state: GrillState = {
    id: requiredText(value.id, "session id", 200),
    owner: requiredText(value.owner, "owner"),
    project: requiredText(value.project, "project"),
    // Sessions written before worktree scoping carry no workspace.
    workspace: value.workspace === undefined
      ? workspaceRoot(requiredText(value.project, "project"))
      : requiredText(value.workspace, "workspace"),
    topic: requiredText(value.topic, "topic"),
    createdAt: requiredText(value.createdAt, "createdAt", 100),
    updatedAt: requiredText(value.updatedAt, "updatedAt", 100),
    status,
    seq,
    handled,
    questions: parseQuestions(value.questions),
    drafts: isRecord(value.drafts) && typeof value.drafts.revision === "number" && isRecord(value.drafts.answers) && isRecord(value.drafts.threads) && Array.isArray(value.drafts.recovery)
      ? value.drafts as unknown as DraftState
      : { revision: 0, answers: Object.create(null) as Record<string, DraftAnswer>, threads: Object.create(null) as Record<string, string>, recovery: [] },
    context: isRecord(value.context)
      ? value.context as unknown as InterviewContext
      : { terms: [], facts: [], risks: [] },
  };
  const note = optionalString(value, "note");
  if (note !== undefined) state.note = note;
  const error = optionalString(value, "error", 2000);
  if (error !== undefined) state.error = error;
  if (value.reportPath !== undefined)
    state.reportPath = requiredText(value.reportPath, "reportPath", 1000);
  if (value.pending !== undefined) {
    const pending = value.pending;
    if (
      !isRecord(pending) ||
      typeof pending.seq !== "number" ||
      !Number.isSafeInteger(pending.seq) ||
      !Array.isArray(pending.actions)
    )
      fail("Invalid pending submission");
    const actions = parseActions(pending.actions);
    const pendingSeq = pending.seq;
    if (pendingSeq !== state.seq || pendingSeq <= state.handled)
      fail("Invalid pending submission");
    state.pending = { seq: pendingSeq, actions, ...(typeof pending.requestId === "string" ? { requestId: pending.requestId } : {}) };
  }
  if (value.diagram !== undefined) state.diagram = parseDiagram(value.diagram);
  if (value.prototype !== undefined) state.prototype = parsePrototype(value.prototype);
  if (value.lastSubmission !== undefined) {
    const pending = value.lastSubmission;
    if (!isRecord(pending) || typeof pending.seq !== "number" || !Number.isSafeInteger(pending.seq) || !Array.isArray(pending.actions)) fail("Invalid last submission");
    state.lastSubmission = { seq: pending.seq, actions: parseActions(pending.actions), ...(typeof pending.requestId === "string" ? { requestId: pending.requestId } : {}) };
  }
  if (value.exportedPath !== undefined) state.exportedPath = requiredText(value.exportedPath, "exportedPath", 1000);
  if (state.reportPath && state.reportPath !== join(dir, "report.md"))
    fail("Invalid report path");
  if (state.status === "finished" && !state.reportPath)
    fail("Finished session lacks report");
  validateQuestions(state.questions);
  return buildStore(dir, state);
}
