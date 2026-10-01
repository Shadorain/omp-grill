import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store";
import type { Store } from "../src/types";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function root(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** A finished interview with one durable decision and one deferred question. */
function finished(topic = "CHR-144 typed capabilities"): { store: Store; project: string } {
  const project = root("omp-grill-project-");
  const store = createStore({
    home: root("omp-grill-exports-"),
    owner: "alice",
    project,
    topic,
  });
  store.publish({
    context: { intent: "Decide how capabilities are typed." },
    questions: [
      {
        id: "repr",
        title: "Capability representation",
        body: "How are capabilities modeled?",
        options: [{ id: "enum", label: "Closed enum" }, { id: "trait", label: "Trait objects" }],
        recommendation: { option: "enum", reason: "Exhaustive matching" },
        durable: true,
      },
      {
        id: "cache",
        title: "Capability cache TTL",
        options: [{ id: "none", label: "No cache" }, { id: "ttl", label: "60s" }],
        recommendation: { option: "none", reason: "Correctness first" },
      },
    ],
  });
  store.publish({
    explorations: [{
      q: "repr",
      rows: [
        { option: "enum", pros: ["Exhaustive match"], cons: ["Recompile to extend"] },
        { option: "trait", pros: ["Open to plugins"], cons: ["Dynamic dispatch"] },
      ],
    }],
  });
  store.submit([
    { type: "answer", q: "repr", option: "enum", text: "Tenancy bugs must fail the build." },
    { type: "defer", q: "cache", until: "profiling shows lookup is hot" },
  ]);
  store.publish({ handled: store.state.pending!.seq });
  store.publish({
    questions: [{
      id: "order",
      title: "Resolution order",
      options: [{ id: "static", label: "Static table" }, { id: "dyn", label: "Registry" }],
      recommendation: { option: "static", reason: "No ordering hazards" },
      durable: true,
      dependsOn: ["repr"],
    }],
  });
  store.submit([{ type: "answer", q: "order", option: "static" }, { type: "finish" }]);
  store.finish();
  return { store, project };
}

describe("project exports", () => {
  test("numbers ADRs after existing records and keeps only durable decisions", () => {
    const { store, project } = finished();
    mkdirSync(join(project, "docs/adr"), { recursive: true });
    writeFileSync(join(project, "docs/adr/0001-database-per-school.md"), "# Earlier\n");
    writeFileSync(join(project, "docs/adr/0007-origin-validation.md"), "# Later\n");
    writeFileSync(join(project, "docs/adr/notes.md"), "not an ADR\n");

    const written = store.exportArtifact("adr", "docs/adr");
    expect(written.map((path) => path.slice(project.length + 1))).toEqual([
      "docs/adr/0008-capability-representation.md",
      "docs/adr/0009-resolution-order.md",
    ]);
    const adr = readFileSync(written[0]!, "utf8");
    expect(adr).toContain("# Capability representation");
    expect(adr).toContain("We chose Closed enum. Tenancy bugs must fail the build.");
    expect(adr).toContain("- **Trait objects** (Rejected)");
    expect(adr).toContain("Against: Dynamic dispatch");
    // The deferred question is not a decision, so it gets no record.
    expect(adr).not.toContain("Capability cache TTL");
  });

  test("refuses an ADR export with nothing durable decided", () => {
    const project = root("omp-grill-project-");
    const store = createStore({ home: root("omp-grill-exports-"), owner: "a", project, topic: "Small" });
    store.publish({ questions: [{ id: "q", title: "Pick", options: [], recommendation: { reason: "r" } }] });
    store.submit([{ type: "answer", q: "q", text: "yes" }, { type: "finish" }]);
    store.finish();
    expect(() => store.exportArtifact("adr", "docs/adr")).toThrow(/durable/);
  });

  test("beads plan mirrors dependsOn as blocked-by edges and blocks deferred work", () => {
    const { store } = finished();
    const [path] = store.exportArtifact("beads", "docs/plan.json");
    const plan = JSON.parse(readFileSync(path!, "utf8"));
    const epic = plan.nodes[0];
    expect(epic.type).toBe("epic");
    expect(epic.external_ref).toBeUndefined();

    const byTitle = Object.fromEntries(plan.nodes.map((node: Record<string, unknown>) => [node.title, node]));
    expect(byTitle["Capability representation"].parent_key).toBe(epic.key);
    expect(byTitle["Capability representation"].design).toContain("Rejected: Trait objects");
    expect(byTitle["Capability cache TTL"].status).toBe("blocked");
    expect(byTitle["Capability cache TTL"].description).toContain("profiling shows lookup is hot");
    expect(plan.edges).toEqual([{
      from_key: byTitle["Resolution order"].key,
      to_key: byTitle["Capability representation"].key,
      type: "blocked-by",
    }]);
  });

  test("links the epic only when the topic supplies a Linear issue URL", () => {
    const { store } = finished("Capabilities https://linear.app/charidel/issue/CHR-144/typed-capabilities");
    const [path] = store.exportArtifact("beads", "docs/linked-plan.json");
    const plan = JSON.parse(readFileSync(path!, "utf8"));
    expect(plan.nodes[0].external_ref).toBe("https://linear.app/charidel/issue/CHR-144/typed-capabilities");
  });

  test("a rejected path in a multi-file export writes nothing", () => {
    const { store, project } = finished();
    expect(() => store.exportArtifact("adr", "../outside")).toThrow(/within/);
    expect(() => readFileSync(join(project, "docs/adr/0001-capability-representation.md"))).toThrow();
  });

  test("deferring records the revisit condition and reopening clears it", () => {
    const project = root("omp-grill-project-");
    const store = createStore({ home: root("omp-grill-exports-"), owner: "a", project, topic: "Cache" });
    store.publish({ questions: [{ id: "cache", title: "Cache TTL", options: [], recommendation: { reason: "r" } }] });

    store.submit([{ type: "defer", q: "cache", until: "profiling shows lookup is hot" }]);
    store.publish({ handled: store.state.pending!.seq });
    expect(store.state.questions[0]?.deferUntil).toBe("profiling shows lookup is hot");
    expect(store.previewReport()).toContain("- Cache TTL — revisit when profiling shows lookup is hot");

    store.submit([{ type: "reopen", q: "cache" }]);
    expect(store.state.questions[0]?.deferUntil).toBeUndefined();
    expect(store.previewReport()).not.toContain("## Deferred");
  });
});
