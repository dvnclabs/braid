// A session's records, appended as the session goes: .braid/sessions/<id>.jsonl,
// one ATXF record per line, in the order saved. A subagent's records are in the
// same file, each marked with the subagent's id (ext.braid.agent).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { braidOf, parseJsonl, toJsonl, withBraid, type Rec } from "./records.ts";
import { ensureStore, type Repo } from "./repo.ts";

export const recordsFile = (repo: Repo, session: string): string => join(repo.sessions, `${session}.jsonl`);

/** Every record of a session, its subagents' included, in the order saved. */
export function readFile(repo: Repo, session: string): Rec[] {
  const file = recordsFile(repo, session);
  return existsSync(file) ? parseJsonl(readFileSync(file, "utf8")) : [];
}

/** The session's own records. */
export function readRecords(repo: Repo, session: string): Rec[] {
  return readFile(repo, session).filter((r) => !braidOf(r).agent);
}

/** The records of each subagent the session spawned, by its id. */
export function readAgents(repo: Repo, session: string): Map<string, Rec[]> {
  const out = new Map<string, Rec[]>();
  for (const r of readFile(repo, session)) {
    const agent = braidOf(r).agent;
    if (agent) out.set(agent, [...(out.get(agent) ?? []), r]);
  }
  return out;
}

/** Appends records to a session, and each subagent's, marked with its id. */
export function appendRecords(repo: Repo, session: string, records: Rec[], agents = new Map<string, Rec[]>()): void {
  const lines = [...records, ...[...agents].flatMap(([id, rs]) => rs.map((r) => withBraid(r, { agent: id })))];
  if (lines.length === 0) return;
  ensureStore(repo);
  appendFileSync(recordsFile(repo, session), toJsonl(lines));
}
