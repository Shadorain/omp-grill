import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, loadStore } from "../src/store";
import { listSessions, resumeStore } from "../src/sessions";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function root() {
  const dir = mkdtempSync(join(tmpdir(), "omp-grill-sessions-"));
  roots.push(dir);
  return dir;
}

describe("session listing and safe resume", () => {
  test("lists only same-project sessions, recent first", () => {
    const home = root();
    const older = createStore({ home, owner: "a", project: "/p", topic: "Old" });
    const newer = createStore({ home, owner: "a", project: "/p", topic: "New" });
    createStore({ home, owner: "a", project: "/other", topic: "Else" });
    const raw = JSON.parse(readFileSync(join(newer.dir, "state.json"), "utf8"));
    raw.createdAt = "2099-01-02T00:00:00Z";
    writeFileSync(join(newer.dir, "state.json"), JSON.stringify(raw));
    const list = listSessions(home, "/p");
    expect(list.map((row) => row.topic)).toEqual(["New", "Old"]);
    expect(list.every((row) => row.project === "/p")).toBe(true);
  });

  test("missing home is an empty list, not a filesystem error", () => {
    expect(listSessions(join(root(), "missing"), "/p")).toEqual([]);
  });
  test("resumes same-owner paused sessions through normal load", () => {
    const home = root();
    const store = createStore({ home, owner: "alice", project: "/p", topic: "T" });
    store.setStatus("paused");
    const resumed = resumeStore(store.dir, "alice");
    expect(resumed.state.status).toBe("paused");
    resumed.setStatus("waiting");
  });

  test("adopts foreign paused sessions only after claiming the lease", () => {
    const home = root();
    const store = createStore({ home, owner: "alice", project: "/p", topic: "T" });
    store.setStatus("paused");
    const adopted = resumeStore(store.dir, "bob");
    expect(adopted.state.owner).toBe("bob");
    expect(() => adopted.claim()).not.toThrow();
    expect(() => resumeStore(store.dir, "carol")).toThrow(/Cannot resume|live server/);
    adopted.release();
  });

  test("refuses waiting, working, or live-leased foreign sessions", () => {
    const home = root();
    const waiting = createStore({ home, owner: "alice", project: "/p", topic: "W" });
    expect(() => resumeStore(waiting.dir, "bob")).toThrow(/Cannot resume/);
    const working = createStore({ home, owner: "alice", project: "/p", topic: "K" });
    working.publish({ questions: [{ id: "q1", title: "Q", options: [], recommendation: { reason: "r" } }] });
    working.submit([{ type: "defer", q: "q1" }]);
    expect(working.state.status).toBe("working");
    expect(() => resumeStore(working.dir, "bob")).toThrow(/Cannot resume/);
    const paused = createStore({ home, owner: "alice", project: "/p", topic: "P" });
    paused.setStatus("paused");
    writeFileSync(join(paused.dir, ".lease"), JSON.stringify({ pid: process.pid }));
    expect(() => resumeStore(paused.dir, "bob")).toThrow(/live server/);
  });
});
