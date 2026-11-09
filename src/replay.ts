// Replay: write a saved session back out as a Claude Code transcript under a
// new session id, so it can be resumed here, on another machine, or as a
// second direction from the same point. Paths from the source checkout are
// rewritten to this one.
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeCode, uuidFor } from "@leostera/atxf/claude-code";
import { readRecords } from "./chunks.ts";
import { conversation, type Found } from "./load.ts";
import { ancestry, braidOf, lastTurn, type Rec } from "./records.ts";
import { userConfig, type Repo } from "./repo.ts";
import { loadState, newState, saveState } from "./state.ts";

/** Where Claude Code keeps the sessions of a working directory. */
function projectDir(cwd: string): string {
  const root = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(root, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

/** Replaces path prefixes in every string, except in reasoning, which its signature covers. */
function rewrite<T>(value: T, pairs: [string, string][]): T {
  if (typeof value === "string") {
    let s: string = value;
    for (const [from, to] of pairs) if (from && from !== to) s = s.split(from).join(to);
    return s as T;
  }
  if (Array.isArray(value)) return value.map((v) => rewrite(v, pairs)) as T;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.type === "reasoning") return value;
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, k === "native" || k === "replay" ? v : rewrite(v, pairs)])) as T;
  }
  return value;
}

/** The working directory the source session ran in, as its records name it. */
function sourceCwd(records: Rec[]): string | undefined {
  for (const r of records) {
    const ws = (r.workspace as { cwd?: unknown } | undefined)?.cwd;
    if (r.type === "transcript" && typeof ws === "string") return ws;
    const native = (r.native as { records?: { cwd?: unknown }[] } | undefined)?.records?.[0]?.cwd;
    if (typeof native === "string") return native;
  }
  return undefined;
}

export interface Replayed {
  session: string;
  file: string;
  cwd: string;
  records: number;
}

export function replay(repo: Repo, found: Found, remote: string, opts: { cwd?: string } = {}): Replayed {
  const all = conversation(repo, found.conv, remote);
  const own = readRecords(found.ref, found.opts);
  const head = lastTurn(own) ?? own.at(-1)?.id;
  if (!head) throw new Error(`session ${found.session.slice(0, 8)} has no records to replay`);
  const parents = new Map([...all.values()].map((r) => [r.id, r.parentId ?? null]));
  const path = ancestry(head, parents)
    .reverse()
    .map((id) => all.get(id)!)
    .filter((r) => r && r.type !== "transcript");

  const cwd = realpathSync(opts.cwd ?? process.cwd());
  const from = sourceCwd([...all.values()]);
  const pairs: [string, string][] = [...(from ? [[from, cwd] as [string, string]] : []), ...userConfig().paths];
  const session = randomUUID();
  const header = { type: "transcript", atxf: "0.1", id: session, time: path[0]?.time ?? new Date().toISOString(), source: { agent: "braid", sessionId: session }, workspace: { cwd } };
  const text = claudeCode.fromAtxf({ header, records: rewrite(path, pairs) } as never, { carry: false, sessionId: session });

  const dir = projectDir(cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${session}.jsonl`);
  writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);

  // The new session continues the source: its first save keeps only what is added after the copy.
  const state = loadState(repo, session) ?? newState(session, file);
  const first = own.find((r) => braidOf(r).actor);
  state.forkFrom = { session: found.session, conv: found.conv, head, actor: first ? braidOf(first).actor?.actorId : undefined, replayed: true };
  saveState(repo, state);
  return { session, file, cwd, records: text.split("\n").filter(Boolean).length };
}

/** For the first save of a replayed session: native uuid of each copied record → its id in the source. */
export function replayedIds(records: Iterable<Rec>): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of records) map.set(uuidFor(r.id), r.id);
  return map;
}
