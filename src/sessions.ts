import * as fs from "node:fs";
import { join } from "node:path";
import { loadStore } from "./store";
import type { SessionSummary, Store } from "./types";

function readSummary(dir: string): SessionSummary | undefined {
  try {
    const value: unknown = JSON.parse(
      fs.readFileSync(join(dir, "state.json"), "utf8"),
    );
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return undefined;
    const row = value as Record<string, unknown>;
    const questions = Array.isArray(row.questions) ? row.questions : [];
    const counted = (status: string) =>
      questions.filter(
        (q: unknown) =>
          typeof q === "object" &&
          q !== null &&
          (q as Record<string, unknown>).status === status,
      ).length;
    const status = String(row.status);
    if (
      status !== "waiting" &&
      status !== "working" &&
      status !== "paused" &&
      status !== "finished" &&
      status !== "error"
    )
      return undefined;
    return {
      id: String(row.id ?? ""),
      dir,
      topic: String(row.topic ?? ""),
      project: String(row.project ?? ""),
      owner: String(row.owner ?? ""),
      status: status as SessionSummary["status"],
      createdAt: String(row.createdAt ?? ""),
      open: counted("open"),
      answered: counted("answered"),
    };
  } catch {
    return undefined;
  }
}

function hasLiveLease(dir: string): boolean {
  try {
    const lease: unknown = JSON.parse(
      fs.readFileSync(join(dir, ".lease"), "utf8"),
    );
    if (
      typeof lease === "object" &&
      lease !== null &&
      typeof (lease as Record<string, unknown>).pid === "number"
    ) {
      try {
        process.kill((lease as Record<string, unknown>).pid as number, 0);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

 export function listSessions(home: string, project: string): SessionSummary[] {
   if (!fs.existsSync(home)) return [];
   const rows: SessionSummary[] = [];
   for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const summary = readSummary(join(home, entry.name));
    if (summary?.project === project) rows.push(summary);
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function resumeStore(dir: string, owner: string): Store {
  const summary = readSummary(dir);
  if (!summary) throw new Error("Session directory cannot be resumed");
  if (summary.owner === owner) return loadStore(dir, owner);
  if (
    summary.status !== "paused" &&
    summary.status !== "finished" &&
    summary.status !== "error"
  )
    throw new Error(
      `Cannot resume ${summary.status} session owned by another server`,
    );
  try {
    fs.writeFileSync(join(dir, ".lease"), JSON.stringify({ pid: process.pid }), {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    if (hasLiveLease(dir)) throw new Error("Session is claimed by a live server");
    fs.rmSync(join(dir, ".lease"), { force: true });
    fs.writeFileSync(join(dir, ".lease"), JSON.stringify({ pid: process.pid }), {
      flag: "wx",
      mode: 0o600,
    });
  }
  const raw = fs.readFileSync(join(dir, "state.json"), "utf8");
  const state = JSON.parse(raw) as Record<string, unknown>;
  state.owner = owner;
  const tmp = join(dir, `.state-${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(tmp, join(dir, "state.json"));
  return loadStore(dir, owner);
}
