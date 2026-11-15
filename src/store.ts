// A session's records, appended as the session goes: .braid/sessions/<id>.jsonl.gz,
// one ATXF record per line, in the order saved, gzip-compressed. Each save
// appends one gzip member, so nothing written is ever rewritten, and any gzip
// reader (zcat, zgrep, Python's gzip, a browser) reads the file as one. A
// subagent's records are in the same file, each marked with the subagent's id
// (ext.braid.agent).
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { constants, gunzipSync, gzipSync } from "node:zlib";
import { braidOf, toJsonl, withBraid, type Rec } from "./records.ts";
import { ensureStore, type Repo } from "./repo.ts";

export const recordsFile = (repo: Repo, session: string): string => join(repo.sessions, `${session}.jsonl.gz`);
/** Where braid 0.2 kept a session's records, uncompressed. */
const plainFile = (repo: Repo, session: string): string => join(repo.sessions, `${session}.jsonl`);

export interface Read {
  records: Rec[];
  /** The last save was cut short, as by a crash while it wrote: what it wrote whole is read, the rest is not. */
  truncated: boolean;
}

/** The text of a session's file, and whether its last gzip member was cut short. */
function text(repo: Repo, session: string): { text: string; truncated: boolean } {
  const gz = recordsFile(repo, session);
  if (existsSync(gz)) {
    const buf = readFileSync(gz);
    try {
      return { text: gunzipSync(buf).toString("utf8"), truncated: false };
    } catch {
      // A member cut short: what decodes is kept, up to its last whole line.
      const partial = gunzipSync(buf, { finishFlush: constants.Z_SYNC_FLUSH }).toString("utf8");
      return { text: partial.slice(0, partial.lastIndexOf("\n") + 1), truncated: true };
    }
  }
  const plain = plainFile(repo, session);
  return { text: existsSync(plain) ? readFileSync(plain, "utf8") : "", truncated: false };
}

/** The file that holds a session: compressed, or as braid 0.2 kept it until its next save. */
export function sessionFile(repo: Repo, session: string): string {
  const gz = recordsFile(repo, session);
  return existsSync(gz) || !existsSync(plainFile(repo, session)) ? gz : plainFile(repo, session);
}

/** Every record of a session, its subagents' included, in the order saved. */
export function readFile(repo: Repo, session: string): Rec[] {
  return readChecked(repo, session).records;
}

/** As readFile, and whether the last save was cut short. */
export function readChecked(repo: Repo, session: string): Read {
  const { text: t, truncated } = text(repo, session);
  const records = t
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Rec);
  return { records, truncated };
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

/** Appends records to a session, and each subagent's, marked with its id, as one gzip member. */
export function appendRecords(repo: Repo, session: string, records: Rec[], agents = new Map<string, Rec[]>()): void {
  const lines = [...records, ...[...agents].flatMap(([id, rs]) => rs.map((r) => withBraid(r, { agent: id })))];
  if (lines.length === 0) return;
  ensureStore(repo);
  const gz = recordsFile(repo, session);
  // A session braid 0.2 kept uncompressed is compressed first, whole.
  const plain = plainFile(repo, session);
  if (!existsSync(gz) && existsSync(plain)) {
    writeFileSync(gz, gzipSync(readFileSync(plain)));
    rmSync(plain);
  }
  appendFileSync(gz, gzipSync(toJsonl(lines)));
}
