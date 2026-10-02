import type { ExportKind } from "./exports";

export type QuestionStatus = "open" | "answered" | "deferred";
export interface DraftAnswer {
  option?: string;
  options?: string[];
  text?: string;
}
export interface DraftRecovery {
  id: string;
  q: string;
  kind: "answer" | "thread";
  at: string;
  answer?: DraftAnswer;
  text?: string;
}
export interface DraftState {
  revision: number;
  answers: Record<string, DraftAnswer>;
  threads: Record<string, string>;
  recovery: DraftRecovery[];
}
export interface DraftPatch {
  revision: number;
  answers?: Record<string, DraftAnswer | null>;
  threads?: Record<string, string | null>;
}
export interface InterviewContext {
  intent?: string;
  docPath?: string;
  terms: { term: string; definition: string; avoid?: string[] }[];
  facts: { id: string; text: string; source?: string }[];
  risks: { id: string; text: string; mitigation?: string }[];
}
export interface DiagramSpec {
  title: string;
  kind: "architecture" | "flow" | "sequence" | "state";
  nodes: { id: string; label: string; detail?: string }[];
  edges: { from: string; to: string; label?: string }[];
}
export interface Diagram extends DiagramSpec {
  version: number;
  stale: boolean;
  thread: { role: "user" | "agent"; text: string }[];
}
export interface PrototypeAction {
  type: "navigate" | "set" | "toggle" | "open" | "close" | "submit";
  target: string;
  value?: string;
}
export interface PrototypeBlock {
  id: string;
  kind: "heading" | "text" | "button" | "input" | "select" | "checkbox" | "table" | "list" | "card" | "dialog";
  label?: string;
  text?: string;
  value?: string;
  options?: string[];
  columns?: string[];
  rows?: string[][];
  action?: PrototypeAction;
  children?: PrototypeBlock[];
}
export interface PrototypeSpec {
  title: string;
  start: string;
  app?: { name: string; route?: string; chrome?: string[] };
  theme?: { background?: string; surface?: string; text?: string; accent?: string; radius?: number; font?: "sans" | "serif" | "mono" };
  screens: { id: string; title: string; layout?: "dashboard" | "split" | "form" | "content"; blocks: PrototypeBlock[] }[];
}
export interface Prototype extends PrototypeSpec {
  version: number;
  stale: boolean;
  thread: { role: "user" | "agent"; text: string }[];
}
export interface Question {
  id: string;
  title: string;
  body?: string;
  options: { id: string; label: string }[];
  multiSelect?: boolean;
  recommendation: { option?: string; options?: string[]; reason: string };
  dependsOn?: string[];
  durable?: boolean;
  status: QuestionStatus;
  /** What must change before a deferred question is worth revisiting. */
  deferUntil?: string;
  answer?: DraftAnswer;
  thread: { role: "user" | "agent"; text: string }[];
  explore?: { option: string; pros: string[]; cons: string[] }[];
  history?: { at: string; reason: string; answer: DraftAnswer }[];
  recommendationUpdated?: boolean;
}
export type QuestionInput = Omit<
  Question,
  "status" | "deferUntil" | "thread" | "history" | "recommendationUpdated"
>;
export type Action =
  | ({ type: "answer"; q: string } & DraftAnswer)
  | { type: "thread"; q: string; text: string }
  | { type: "explore"; q: string }
  | { type: "defer"; q: string; until?: string }
  | { type: "reopen"; q: string }
  | { type: "visualize"; kind?: "diagram" | "prototype" }
  | { type: "visual-feedback"; kind?: "diagram" | "prototype"; text: string }
  | { type: "finish" };
export type SpecialistRole = "discussion" | "diagram" | "prototype";
export interface Submission {
  seq: number;
  actions: Action[];
  requestId?: string;
  completed?: SpecialistRole[];
}
export interface GrillState {
  id: string;
  owner: string;
  /** Checkout the grill was started in; export paths resolve against it. */
  project: string;
  /** Repository the grill belongs to; shared by every linked worktree. */
  workspace: string;
  topic: string;
  createdAt: string;
  updatedAt: string;
  status: "waiting" | "working" | "paused" | "finished" | "error";
  seq: number;
  handled: number;
  questions: Question[];
  drafts: DraftState;
  context: InterviewContext;
  diagram?: Diagram;
  prototype?: Prototype;
  lastSubmission?: Submission;
  exportedPath?: string;
  note?: string;
  error?: string;
  reportPath?: string;
  pending?: Submission;
}
export interface Publish {
  handled?: number;
  questions?: QuestionInput[];
  replies?: { q: string; text: string }[];
  explorations?: { q: string; rows: NonNullable<Question["explore"]> }[];
  note?: string;
  context?: Partial<InterviewContext>;
  diagram?: DiagramSpec;
  diagramReply?: string;
  prototype?: PrototypeSpec;
  prototypeReply?: string;
  specialist?: { seq: number; role: SpecialistRole };
}
export interface Store {
  claim(): void;
  release(): void;
  dir: string;
  state: GrillState;
  publish(patch: Publish): void;
  submit(
    actions: unknown,
    options?: { requestId?: string; draftRevision?: number },
  ): Submission;
  saveDrafts(patch: DraftPatch): DraftState;
  updateContext(patch: Partial<InterviewContext>): void;
  previewReport(): string;
  exportArtifact(kind: ExportKind, path: string, overwrite?: boolean): string[];
  acknowledge(seq: number): void;
  setStatus(status: GrillState["status"], error?: string): void;
  finish(): string;
}
export interface SessionSummary {
  id: string;
  dir: string;
  topic: string;
  project: string;
  workspace: string;
  owner: string;
  status: GrillState["status"];
  createdAt: string;
  open: number;
  answered: number;
}
export interface GrillServer {
  url: string;
  close(): Promise<void>;
}
