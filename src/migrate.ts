// braid migrate: moves conversations from the braid repository braid 0.1 kept
// them in (~/.braid, a git store) into the .braid folder of the project each
// one ran in. A conversation moves whole, to the project its first session ran
// in. A session already there is left as it is, so running it twice moves
// nothing twice. The old repository stays where it is, to delete by hand.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { catBlobs, forEachRef, lsTree, revParse, type GitOptions } from "./git.ts";
import { parseJsonl, type Rec } from "./records.ts";
import { projectOf, repoAt } from "./repo.ts";
import { recordSession } from "./registry.ts";
import { loadState, saveState, type SessionState } from "./state.ts";
import { appendRecords, recordsFile } from "./store.ts";

/** Where braid 0.1 kept conversations. */
export const oldHome = (): string => process.env.BRAID_HOME || join(homedir(), ".braid");

function chunks(tree: string, opts: GitOptions): Rec[] {
  const files = lsTree(tree, opts)
    .filter((e) => e.type === "blob")
    .sort((a, b) => a.name.localeCompare(b.name));
  return catBlobs(files.map((f) => f.sha), opts).flatMap(parseJsonl);
}

/** A session as the git store holds it: its records, and its subagents' by id. */
function readOld(ref: string, opts: GitOptions): { records: Rec[]; agents: Map<string, Rec[]> } {
  const commit = revParse(ref, opts);
  const root = commit ? lsTree(commit, opts) : [];
  const dir = (name: string) => root.find((e) => e.name === name && e.type === "tree")?.sha;
  const records = dir("records") ? chunks(dir("records")!, opts) : [];
  const agents = new Map<string, Rec[]>();
  if (dir("agents")) for (const a of lsTree(dir("agents")!, opts).filter((e) => e.type === "tree")) agents.set(a.name, chunks(a.sha, opts));
  return { records, agents };
}

const OBSOLETE = ["code", "published", "withheld", "terms", "edits", "private", "review", "commits", "importedSeq"];

export function migrate(home = oldHome()): string[] {
  const store = join(home, ".git", "braid", "store");
  const states = join(home, ".git", "braid", "sessions");
  if (!existsSync(join(store, "HEAD"))) return [`nothing to move: ${home} holds no conversations of braid 0.1`];
  const opts: GitOptions = { gitDir: store };
  const old = (session: string): Record<string, unknown> | undefined => {
    const file = join(states, `${session}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : undefined;
  };
  const byConv = new Map<string, { session: string; ref: string }[]>();
  for (const { ref } of forEachRef(["refs/sessions/"], opts)) {
    const [conv, session] = ref.split("/").slice(-2) as [string, string];
    byConv.set(conv, [...(byConv.get(conv) ?? []), { session, ref }]);
  }
  const moved = new Map<string, number>();
  let kept = 0;
  for (const [conv, sessions] of byConv) {
    // The conversation goes to the project its first session ran in, else to the one any of its sessions ran in.
    const code = [conv, ...sessions.map((s) => s.session)].map((id) => old(id)?.code).find((c): c is string => typeof c === "string" && existsSync(c));
    const project = projectOf(code ?? homedir());
    const repo = repoAt(project);
    for (const { session, ref } of sessions) {
      if (existsSync(recordsFile(repo, session)) || (loadState(repo, session)?.chunks ?? 0) > 0) {
        kept++;
        continue;
      }
      const { records, agents } = readOld(ref, opts);
      appendRecords(repo, session, records, agents);
      const state = { ...(old(session) ?? { session, conv, harness: "claude-code", chunks: 1 }) } as Record<string, unknown>;
      for (const key of OBSOLETE) delete state[key];
      state.conv = conv;
      state.chunks = Math.max(1, Number(state.chunks ?? 1));
      saveState(repo, state as unknown as SessionState);
      recordSession(session, { project });
      moved.set(project, (moved.get(project) ?? 0) + 1);
    }
  }
  const notes = [...moved].map(([project, n]) => `moved ${n} session${n === 1 ? "" : "s"} into ${join(project, ".braid")}`);
  if (kept) notes.push(kept === 1 ? "left 1 session already moved as it is" : `left ${kept} sessions already moved as they are`);
  if (!notes.length) notes.push("nothing to move");
  notes.push(`${home} stays as it was: delete it once you no longer need braid 0.1`);
  return notes;
}

/** Whether braid 0.1's repository holds conversations not moved yet. */
export function waitingToMove(home = oldHome()): boolean {
  const states = join(home, ".git", "braid", "sessions");
  if (!existsSync(join(home, ".git", "braid", "store", "HEAD")) || !existsSync(states)) return false;
  return readdirSync(states).some((f) => {
    if (!f.endsWith(".json")) return false;
    try {
      const s = JSON.parse(readFileSync(join(states, f), "utf8")) as { session?: string; chunks?: number };
      return (s.chunks ?? 0) > 0;
    } catch {
      return false;
    }
  });
}
