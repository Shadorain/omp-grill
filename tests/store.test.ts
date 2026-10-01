import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactState,
  compactSubmission,
  createStore,
  loadStore,
  readContext,
} from "../src/store";
import type { QuestionInput } from "../src/types";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omp-grill-store-"));
  roots.push(root);
  const store = createStore({
    home: root,
    owner: "alice",
    project: "demo",
    topic: "Design",
  });
  const question: QuestionInput = {
    id: "q1",
    title: "Database",
    options: [
      { id: "pg", label: "Postgres" },
      { id: "sqlite", label: "SQLite" },
    ],
    recommendation: { option: "pg", reason: "Concurrent writes" },
  };
  store.publish({ questions: [question] });
  return { root, store };
}

describe("durable grill store", () => {
  test("commits batches atomically and resumes pending delivery under owner isolation", () => {
    const { store } = fixture();
    expect(() =>
      store.submit([
        { type: "answer", q: "q1", option: "invalid" },
        { type: "thread", q: "q1", text: "not committed" },
      ]),
    ).toThrow();
    expect(store.state.questions[0].status).toBe("open");
    expect(store.state.questions[0].thread).toEqual([]);
    const submission = store.submit([
      { type: "answer", q: "q1", option: "pg", text: "Need transactions" },
    ]);
    expect(store.state.pending).toEqual(submission);
    expect(loadStore(store.dir, "alice").state.pending).toEqual(submission);
    expect(() => loadStore(store.dir, "bob")).toThrow();
    expect(compactSubmission(store.state, submission)).toContain(
      "Need transactions",
    );
    expect(compactState(store.state)).toContain("Need transactions");
    expect(compactState(store.state)).not.toContain("Postgres");
    store.publish({
      handled: submission.seq,
      questions: [
        { ...store.state.questions[0], title: "Changed model title" },
      ],
    });
    expect(store.state.pending).toBeUndefined();
    expect(store.state.questions[0].title).toBe("Database");
    expect(store.state.questions[0].answer).toEqual({
      option: "pg",
      text: "Need transactions",
    });
  });

  test("blocks sends during initial generation and accepts only valid frontier publications", () => {
    const { store } = fixture();
    store.setStatus("working");
    expect(() => store.submit([{ type: "finish" }])).toThrow();
    expect(() => store.finish()).toThrow();
    store.publish({ note: "Initial frontier ready" });
    expect(store.state.status).toBe("waiting");

    const item = (id: string, dependsOn?: string[]): QuestionInput => ({
      id,
      title: id,
      options: [],
      recommendation: { reason: "No options" },
      ...(dependsOn ? { dependsOn } : {}),
    });
    expect(() =>
      store.publish({ questions: [item("q2"), item("q3", ["q2"])] }),
    ).toThrow();
    expect(() =>
      store.publish({
        questions: [item("a"), item("b"), item("c"), item("d")],
      }),
    ).toThrow();
    expect(() =>
      store.publish({
        questions: [
          {
            ...item("many"),
            options: ["a", "b", "c", "d", "e"].map((id) => ({ id, label: id })),
          },
        ],
      }),
    ).toThrow();
    expect(store.state.questions.map((question) => question.id)).toEqual([
      "q1",
    ]);
  });

  test("rejects persisted specialist completion without a matching pending action", () => {
    const { store } = fixture();
    store.submit([{ type: "thread", q: "q1", text: "Only discussion here" }]);
    const file = join(store.dir, "state.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.pending.completed = ["diagram"];
    writeFileSync(file, JSON.stringify(saved));
    expect(() => loadStore(store.dir, "alice")).toThrow("Completed specialist has no matching pending action");
  });

  test("retains discussion and reports decisions, rejected options, and deferrals on finish", () => {
    const { store } = fixture();
    store.publish({
      questions: [
        {
          id: "q2",
          title: "Cache",
          options: [{ id: "redis", label: "Redis" }],
          recommendation: { reason: "Known tradeoffs" },
        },
      ],
    });
    const discussion = store.submit([
      { type: "thread", q: "q1", text: "Need compare backup cost" },
    ]);
    store.acknowledge(discussion.seq);
    const decisions = store.submit([
      { type: "answer", q: "q1", option: "pg" },
      { type: "defer", q: "q2" },
    ]);
    store.acknowledge(decisions.seq);
    const finished = store.submit([
      { type: "thread", q: "q1", text: "Keep this context" },
      { type: "finish" },
    ]);
    expect(store.state.status).toBe("finished");
    expect(store.state.pending).toBeUndefined();
    const text = readFileSync(store.state.reportPath!, "utf8");
    expect(text).toContain("Status: answered");
    expect(text).toContain("Decision: Postgres");
    expect(text).toContain("Rejected options: SQLite");
    expect(text).toContain("Recommendation: Concurrent writes");
    expect(text).toContain("Status: deferred");
    expect(text).toContain("Decision: Deferred");
    expect(text).toContain("User: Need compare backup cost");
    expect(text).toContain("User: Keep this context");
    expect(() =>
      store.submit([{ type: "thread", q: "q1", text: "late" }]),
    ).toThrow();
    expect(finished.seq).toBe(store.state.handled);
  });

  test("rejects dependency cycles without changing published state", () => {
    const { store } = fixture();
    expect(() =>
      store.publish({
        questions: [
          {
            id: "q2",
            title: "Second",
            options: [],
            recommendation: { reason: "none" },
            dependsOn: ["q3"],
          },
          {
            id: "q3",
            title: "Third",
            options: [],
            recommendation: { reason: "none" },
            dependsOn: ["q2"],
          },
        ],
      }),
    ).toThrow();
    expect(store.state.questions.map((q) => q.id)).toEqual(["q1"]);
  });

  test("migrates v1 sessions with draft and context defaults", () => {
    const { root, store } = fixture();
    const raw = JSON.parse(readFileSync(join(store.dir, "state.json"), "utf8"));
    delete raw.drafts;
    delete raw.context;
    writeFileSync(join(store.dir, "state.json"), JSON.stringify(raw));
    const loaded = loadStore(store.dir, "alice");
    expect(loaded.state.drafts).toEqual({
      revision: 0,
      answers: {},
      threads: {},
      recovery: [],
    });
    expect(loaded.state.context).toEqual({ terms: [], facts: [], risks: [] });
    expect(
      loaded.saveDrafts({ revision: 0, answers: { q1: { option: "pg" } } })
        .revision,
    ).toBe(1);
  });

  test("enforces draft revision CAS, validates known questions, and retains cleared drafts in recovery", () => {
    const { store } = fixture();
    const saved = store.saveDrafts({
      revision: 0,
      answers: { q1: { option: "pg", text: "Use Postgres" } },
      threads: { q1: "compare backups" },
    });
    expect(saved.revision).toBe(1);
    expect(() =>
      store.saveDrafts({ revision: 0, answers: { q1: { text: "stale" } } }),
    ).toThrow(/Draft revision conflict/);
    expect(() =>
      store.saveDrafts({ revision: 1, answers: { ghost: { text: "x" } } }),
    ).toThrow(/Unknown question/);
    expect(() =>
      store.saveDrafts({ revision: 1, answers: { q1: { option: "nope" } } }),
    ).toThrow(/Unknown option/);
    expect(() =>
      store.saveDrafts({
        revision: 1,
        answers: JSON.parse('{"__proto__":{"text":"x"}}'),
      }),
    ).toThrow(/Unknown question/);
    const cleared = store.saveDrafts({
      revision: 1,
      answers: { q1: null },
      threads: { q1: null },
    });
    expect(cleared.answers).toEqual({});
    expect(cleared.threads).toEqual({});
    expect(cleared.recovery).toHaveLength(2);
    expect(cleared.recovery[0].answer?.text).toBe("Use Postgres");
    expect(cleared.recovery[1].text).toBe("compare backups");
    expect(store.state.seq).toBe(0);
  });

  test("replays requestId without duplicating seq and consumes only matching drafts", () => {
    const { store } = fixture();
    store.saveDrafts({
      revision: 0,
      answers: { q1: { option: "pg" } },
      threads: { q1: "still drafting" },
    });
    const first = store.submit(
      [{ type: "answer", q: "q1", option: "pg" }],
      { requestId: "req-1", draftRevision: 1 },
    );
    expect(store.state.drafts.answers).toEqual({});
    expect(store.state.drafts.threads.q1).toBe("still drafting");
    const replay = store.submit(
      [{ type: "answer", q: "q1", option: "pg" }],
      { requestId: "req-1" },
    );
    expect(replay.seq).toBe(first.seq);
    expect(store.state.seq).toBe(1);
    expect(() =>
      store.submit([{ type: "answer", q: "q1", option: "sqlite" }], {
        requestId: "req-1",
      }),
    ).toThrow(/different actions/);
    store.acknowledge(first.seq);
    expect(() =>
      store.submit([{ type: "thread", q: "q1", text: "x" }], {
        draftRevision: 0,
      }),
    ).toThrow(/Draft revision conflict/);
  });

  test("archives answered decisions on change, defer, and reopen while marking diagrams stale", () => {
    const { store } = fixture();
    store.publish({
      diagram: {
        title: "Sys",
        kind: "flow",
        nodes: [{ id: "a", label: "A" }],
        edges: [],
      },
      diagramReply: "Initial map",
    });
    const first = store.submit([{ type: "answer", q: "q1", option: "pg" }]);
    store.acknowledge(first.seq);
    const second = store.submit([
      { type: "answer", q: "q1", option: "sqlite", text: "simpler" },
      { type: "visual-feedback", text: "outdated now" },
    ]);
    expect(store.state.questions[0].history?.[0]?.answer.option).toBe("pg");
    expect(store.state.diagram?.stale).toBe(true);
    expect(store.state.diagram?.thread.at(-1)?.text).toBe("outdated now");
    store.acknowledge(second.seq);
    const reopen = store.submit([{ type: "reopen", q: "q1" }]);
    expect(store.state.questions[0].status).toBe("open");
    expect(store.state.questions[0].answer).toBeUndefined();
    expect(store.state.questions[0].history).toHaveLength(2);
    store.acknowledge(reopen.seq);
  });

  test("upserts context keys and records them in the report without drafts leakage", () => {
    const { store } = fixture();
    store.updateContext({
      intent: "Pick a database",
      terms: [{ term: "WAL", definition: "write-ahead log", avoid: ["journal"] }],
      facts: [{ id: "f1", text: "5k rps", source: "load test" }],
      risks: [{ id: "r1", text: "Lock contention", mitigation: "partition" }],
    });
    store.updateContext({
      facts: [{ id: "f1", text: "8k rps", source: "new load test" }],
    });
    expect(store.state.context.facts).toHaveLength(1);
    expect(store.state.context.facts[0].text).toBe("8k rps");
    store.submit([
      { type: "answer", q: "q1", option: "pg" },
      { type: "finish" },
    ]);
    const text = readFileSync(store.state.reportPath!, "utf8");
    expect(text).toContain("Pick a database");
    expect(text).toContain("WAL");
    expect(text).toContain("8k rps");
    expect(text).toContain("Lock contention");
    expect(compactState(store.state)).not.toContain("recovery");
    expect(compactState(store.state)).not.toContain("write-ahead log");
  });

  test("accepts facts without sources and removes context rows by key", () => {
    const { store } = fixture();
    store.updateContext({
      terms: [{ term: "WAL", definition: "write-ahead log" }, { term: "LSN", definition: "log sequence number" }],
      facts: [{ id: "f1", text: "Unsourced note" }, { id: "f2", text: "Sourced", source: "bench" }],
      risks: [{ id: "r1", text: "No mitigation yet" }],
    });
    store.updateContext({
      terms: [{ term: "WAL", remove: true }],
      facts: [{ id: "f2", remove: true }],
      risks: [{ id: "r1", remove: true }],
    } as never);
    expect(store.state.context.terms.map((row) => row.term)).toEqual(["LSN"]);
    expect(store.state.context.facts).toEqual([{ id: "f1", text: "Unsourced note" }]);
    expect(store.state.context.risks).toEqual([]);
    store.submit([{ type: "answer", q: "q1", option: "pg" }, { type: "finish" }]);
    const text = readFileSync(store.state.reportPath!, "utf8");
    expect(text).toContain("- Unsourced note\n");
    expect(text).not.toContain("Source: undefined");
  });

  test("clears sent drafts whose text differs only by surrounding whitespace", () => {
    const { store } = fixture();
    store.saveDrafts({ revision: 0, answers: { q1: { option: "pg", text: "why\n" } }, threads: { q1: "follow up " } });
    store.submit(
      [{ type: "answer", q: "q1", option: "pg", text: "why" }, { type: "thread", q: "q1", text: "follow up" }],
      { draftRevision: store.state.drafts.revision },
    );
    expect(store.state.drafts.answers).toEqual({});
    expect(store.state.drafts.threads).toEqual({});
  });

  test("export requires finish, stays inside project, and honors overwrite", () => {
    const { store, root } = fixture();
    const project = join(root, "proj");
    mkdirSync(join(project, "docs"), { recursive: true });
    store.state.project = project;
    expect(() => store.exportArtifact("report", "out.md")).toThrow(/finished/);
    store.submit([{ type: "answer", q: "q1", option: "pg" }, { type: "finish" }]);
    const [out] = store.exportArtifact("report", "docs/grill.md");
    expect(out).toBe(join(project, "docs/grill.md"));
    expect(() => store.exportArtifact("report", "docs/grill.md")).toThrow(/exists/);
    store.exportArtifact("report", "docs/grill.md", true);
    expect(() => store.exportArtifact("report", "../escape.md")).toThrow(/within/);
    expect(() => store.exportArtifact("report", "/abs/path.md")).toThrow(/relative/);
    symlinkSync(join(root, "outside.md"), join(project, "link.md"));
    writeFileSync(join(root, "outside.md"), "original");
    expect(() => store.exportArtifact("report", "link.md")).toThrow(/symlink/);
  });


  test("reads a finished interview's context for a continuation", () => {
    const home = mkdtempSync(join(tmpdir(), "omp-grill-context-"));
    roots.push(home);
    const prior = createStore({ home, owner: "alice", project: "/p", topic: "Baseline" });
    prior.publish({ context: {
      intent: "Settle the auth boundary.",
      terms: [{ term: "tenant", definition: "A school", avoid: ["org"] }],
      facts: [{ id: "f1", text: "Postgres isolates each school" }],
      risks: [{ id: "r1", text: "Cross-tenant reads leak", mitigation: "Row-level security" }],
    }, questions: [{ id: "q", title: "Scope", options: [], recommendation: { reason: "r" } }] });
    prior.submit([{ type: "answer", q: "q", text: "done" }, { type: "finish" }]);
    prior.finish();

    // A different owner can read the context without claiming the session.
    const context = readContext(prior.dir);
    const next = createStore({ home, owner: "bob", project: "/p", topic: "Follow-up", context });
    expect(next.state.context.intent).toBe("Settle the auth boundary.");
    expect(next.state.context.terms).toHaveLength(1);
    expect(next.state.context.terms[0]?.avoid).toEqual(["org"]);
    expect(next.state.context.risks[0]?.mitigation).toBe("Row-level security");
    expect(next.state.questions).toEqual([]);
  });
});
