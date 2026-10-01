import * as fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Canonical identity for the repository a grill belongs to.
 *
 * Linked worktrees have their own checkout path but share one repository, so
 * scoping by `cwd` hides a project's grills from every worktree but the one
 * that created them. Resolving to the main checkout keeps them together.
 * Outside a repository the resolved directory is its own workspace.
 */
export function workspaceRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    const common = commonDirOf(dir);
    if (common) return basename(common) === ".git" ? dirname(common) : dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

/** The shared `.git` directory for the checkout at `dir`, if it is one. */
function commonDirOf(dir: string): string | undefined {
  const marker = join(dir, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(marker);
  } catch {
    return undefined;
  }
  if (stat.isDirectory()) return marker;
  if (!stat.isFile()) return undefined;
  // A linked worktree's `.git` file points at `<main>/.git/worktrees/<name>`,
  // which records the shared directory in `commondir`.
  let pointer: string;
  try {
    pointer = fs.readFileSync(marker, "utf8");
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match?.[1]) return undefined;
  const gitDir = resolve(dir, match[1].trim());
  let shared: string;
  try {
    shared = fs.readFileSync(join(gitDir, "commondir"), "utf8").trim();
  } catch {
    return gitDir;
  }
  return shared ? resolve(gitDir, shared) : gitDir;
}
