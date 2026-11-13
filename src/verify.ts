// braid verify: checks that a session was saved as it happened, and that it
// loads back as it was saved. Three checks, like git fsck for conversations:
//
// - saved: every record of the transcript, and of each subagent's, up to
//   where the last save stopped, is in the store with the same content, in the
//   same order. Records a fork shares with the session it came from live
//   there, and count as saved. Lines written since, as in a session still
//   running, wait for the next save: they are noted, and are no problem.
// - loads: the lines Claude Code reads to resume the transcript are the lines
//   `braid fork` writes from the store, and the fork reads back as the same
//   messages.
// - store: git fsck finds nothing wrong, and every record's parent is in the
//   conversation.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCode } from "@leostera/atxf/claude-code";
import { readAgents, readRecords } from "./chunks.ts";
import { run } from "./git.ts";
import { conversation } from "./load.ts";
import { describe, lastTurn, type Rec } from "./records.ts";
import { forkRecords, forkText, keptUuids, replayedIds, SOURCE_ONLY, type Line } from "./replay.ts";
import { storeRef, type Repo } from "./repo.ts";
import { loadState } from "./state.ts";
import { nativeIds, readWindow, START, type Cursor } from "./transcript.ts";

export interface Verified {
  session: string;
  /** What is wrong; empty when the session is saved and loads as it should. */
  problems: string[];
  /** What was checked, for the report. */
  checked: string[];
  /** What is worth knowing and is no problem: lines written since the last save. */
  notes: string[];
}

/**
 * The records of a transcript file, read as save reads it, each window's lines
 * after the one before it: those of the lines before `until`, where the last
 * save stopped, and those of the lines written since.
 */
function readAll(path: string, id: string, until?: number): { saved: Rec[]; since: Rec[] } {
  const saved: Rec[] = [];
  const since: Rec[] = [];
  let cursor: Cursor = START;
  for (const [out, limit] of [[saved, until], [since, undefined]] as const) {
    for (let w = readWindow(path, cursor, id, { until: limit }); w; w = w.more ? readWindow(path, cursor, id, { until: limit }) : undefined) {
      out.push(...w.records.slice(w.fresh));
      cursor = w.cursor;
    }
  }
  return { saved, since };
}

/**
 * A record's content, without what braid adds or relinks when it saves. A
 * record whose transcript line has no timestamp (Claude Code's bookkeeping
 * lines) gets a time guessed from the lines around it, which depends on where
 * the read started: that time is left out.
 */
function content(r: Rec): string {
  const native = (r.native as { records?: { timestamp?: unknown }[] } | undefined)?.records?.[0];
  const guessed = !!native && native.timestamp === undefined;
  const { parentId: _p, ext, ...all } = r;
  const rest: Record<string, unknown> = { ...all };
  if (guessed) delete rest.time;
  const { braid: _b, ...otherExt } = (ext ?? {}) as Record<string, unknown>;
  return stable(Object.keys(otherExt).length ? { ...rest, ext: otherExt } : rest);
}

/** A record as a problem names it: what it says, or its kind and id when it says nothing readable. */
const which = (r: Rec): string => describe(r, 80) || `${r.type}${r.name ? ` ${String(r.name)}` : ""} ${r.id}`;

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
}

/** Compares a transcript's records with the stored ones. `elsewhere` holds ids saved in other sessions of the conversation. */
function compare(what: string, transcript: Rec[], stored: Rec[], elsewhere: (id: string) => boolean, problems: string[]): number {
  // A line Claude Code wrote twice under one uuid is two records with that id: the n-th saved copy stands for the n-th line.
  const copies = (rs: Rec[]) => {
    const by = new Map<string, number[]>();
    rs.forEach((r, i) => by.set(r.id, [...(by.get(r.id) ?? []), i]));
    return by;
  };
  const saved = copies(stored);
  const lines = copies(transcript);
  const nth = (rs: Rec[]) => {
    const seen = new Map<string, number>();
    return rs.map((r) => {
      const n = seen.get(r.id) ?? 0;
      seen.set(r.id, n + 1);
      return n;
    });
  };
  const twice = [...saved].reduce((sum, [id, at]) => sum + Math.max(0, at.length - Math.max(1, lines.get(id)?.length ?? 0)), 0);
  if (twice) problems.push(`${what}: ${twice} records are saved twice`);
  const tn = nth(transcript);
  const savedCopy = (r: Rec, i: number) => {
    const at = saved.get(r.id)?.[tn[i]!];
    return at === undefined ? undefined : stored[at]!;
  };
  const missing = transcript.filter((r, i) => !savedCopy(r, i) && !elsewhere(r.id));
  const changed = transcript.filter((r, i) => savedCopy(r, i) && content(savedCopy(r, i)!) !== content(r));
  if (missing.length) problems.push(`${what}: ${missing.length} records of the transcript are not saved, from: ${which(missing[0]!)}`);
  if (changed.length) problems.push(`${what}: ${changed.length} saved records differ from the transcript, from: ${which(changed[0]!)}`);
  // Saved records keep the transcript's order.
  const sn = nth(stored);
  const order = stored.map((r, k) => lines.get(r.id)?.[sn[k]!]).filter((i): i is number => i !== undefined);
  const swaps = order.filter((i, k) => k > 0 && i < order[k - 1]!).length;
  if (swaps) problems.push(`${what}: ${swaps} saved records are out of the transcript's order`);
  return transcript.length - missing.length;
}

/** The lines of a transcript file before byte `until`. */
function readLines(path: string, until?: number): Line[] {
  const buf = readFileSync(path);
  return buf
    .toString("utf8", 0, Math.min(buf.length, until ?? buf.length))
    .split("\n")
    .flatMap((l) => {
      try {
        const v = JSON.parse(l) as unknown;
        return v && typeof v === "object" ? [v as Line] : [];
      } catch {
        return [];
      }
    });
}

const blocksOf = (l: Line): Record<string, unknown>[] => {
  const c = (l.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(c) ? (c as Record<string, unknown>[]) : [];
};

/**
 * The lines a fork of a transcript at the line that holds `head` must hold
 * for Claude Code to resume it as it resumes the transcript, read from the
 * transcript alone so they can be held against what braid stored. Of the
 * session's own lines (those braid saved for it), everything since the last
 * compaction, and the messages that compaction kept; of lines copied from the
 * session it continues, the chain to `head` and what parallel tool calls left
 * beside it.
 */
export function resumeLines(lines: Line[], head: string, stored: Rec[], session: string): Line[] {
  // A line Claude Code wrote again under its uuid holds the same message: the chain goes through the first.
  const byUuid = new Map<unknown, Line>();
  for (const l of lines) if (typeof l.uuid === "string" && !byUuid.has(l.uuid)) byUuid.set(l.uuid, l);
  const leaf = byUuid.get(head) ?? lines.find((l) => typeof l.uuid === "string" && head.startsWith(`${l.uuid}:`));
  const chain: Line[] = [];
  const seen = new Set<unknown>();
  for (let l = leaf; l && !seen.has(l.uuid); l = typeof l.parentUuid === "string" ? byUuid.get(l.parentUuid) : undefined) {
    seen.add(l.uuid);
    chain.push(l);
  }
  chain.reverse();
  const results = (l: Line) => (l.type === "user" ? blocksOf(l).flatMap((b) => (b.type === "tool_result" ? [String(b.tool_use_id)] : [])) : []);
  const calls = (l: Line) => (l.type === "assistant" ? blocksOf(l).flatMap((b) => (b.type === "tool_use" ? [String(b.id)] : [])) : []);
  const response = (l: Line | undefined) => (l?.type === "assistant" ? (l.message as { id?: unknown } | undefined)?.id : undefined);
  const holder = new Map<string, Line>();
  const responses = new Map<unknown, Line[]>();
  for (const l of lines) {
    if (l.isSidechain) continue;
    for (const id of results(l)) if (!holder.has(id)) holder.set(id, l);
    if (typeof response(l) === "string" && !seen.has(l.uuid)) responses.set(response(l), [...(responses.get(response(l)) ?? []), l]);
  }
  const path: Line[] = [];
  const taken = new Set<Line>(chain);
  let waiting: Line[] = [];
  const children = new Map<unknown, Line[]>();
  for (const l of lines) if (typeof l.parentUuid === "string") children.set(l.parentUuid, [...(children.get(l.parentUuid) ?? []), l]);
  const bring = (l: Line) => {
    taken.add(l);
    waiting.push(l);
    for (const c of children.get(l.uuid) ?? []) if (c.type === "attachment" && !taken.has(c)) bring(c);
  };
  const linked = (l: Line) => !taken.has(l) && typeof l.parentUuid === "string" && taken.has(byUuid.get(l.parentUuid)!);
  const answer = (l: Line) => {
    for (const id of calls(l)) {
      const r = holder.get(id);
      if (r && linked(r)) bring(r);
    }
  };
  const order = new Map(lines.map((l, i) => [l, i]));
  chain.forEach((l, i) => {
    if (l.type !== "assistant") {
      path.push(...[...waiting, l].sort((a, b) => order.get(a)! - order.get(b)!));
      waiting = [];
      return;
    }
    path.push(l);
    answer(l);
    if (typeof response(l) !== "string" || response(chain[i + 1]) === response(l)) return;
    for (const rest of responses.get(response(l)) ?? []) {
      if (!linked(rest)) continue;
      taken.add(rest);
      path.push(rest);
      answer(rest);
    }
  });
  // Of the session's own lines, everything since the last compaction, up to the last line braid saved.
  const kept = new Set(keptUuids(chain[0]));
  const ids = new Set(stored.map((r) => r.id));
  const tag = `@${session.slice(0, 8)}`;
  const mine = (l: Line, i: number) => (typeof l.uuid === "string" ? ids.has(l.uuid) : ids.has(`claude-line-${i + 1}${tag}`));
  const context = new Set(path);
  const from = chain[0]?.subtype === "compact_boundary" ? lines.indexOf(chain[0]) : 0;
  const last = lines.findLastIndex((l, i) => mine(l, i));
  return lines.filter((l, i) => {
    if (i > last) return false;
    if (typeof l.uuid === "string" && kept.has(l.uuid)) return true;
    if (!mine(l, i)) return context.has(l);
    return i >= from && !SOURCE_ONLY.has(String(l.type));
  });
}

/**
 * Lines as Claude Code reads them, comparable across session files: each
 * mention of another line, outside the message, becomes that line's place in
 * the list, and the session id and working directory are left out.
 */
function canonical(lines: Line[]): string[] {
  const at = new Map(lines.flatMap((l, i) => (typeof l.uuid === "string" ? [[l.uuid, i] as const] : [])));
  // A parent outside the list ends the chain, whether named or not; any other id is compared as it is.
  const parent = (v: unknown): unknown => (typeof v === "string" && at.has(v) ? `#${at.get(v)}` : "#elsewhere");
  const deep = (v: unknown): unknown =>
    typeof v === "string" ? (at.has(v) ? `#${at.get(v)}` : v) : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;
  return lines.map((l) => {
    const out: Line = {};
    for (const [k, v] of Object.entries(l)) {
      if (k === "sessionId" || k === "cwd" || k === "isSidechain") continue;
      out[k] = k === "parentUuid" ? parent(v) : k === "message" ? v : deep(v);
    }
    return stable(out);
  });
}

const isNative = (r: Rec) => (r.native as { source?: string } | undefined)?.source === "claude-code";

/** What a message says, as a person reading it sees it: role, text, tool calls and results. */
function said(r: Rec): string {
  const blocks = Array.isArray(r.content) ? (r.content as Record<string, unknown>[]) : [{ type: "text", text: r.content }];
  return stable({
    role: r.role,
    blocks: blocks.map((b) =>
      b?.type === "text" ? { text: String(b.text ?? "").trim() } : b?.type === "tool_call" ? { call: b.name, args: b.arguments } : { type: b?.type ?? typeof b },
    ),
  });
}

export function verify(repo: Repo, session: string, remote: string): Verified {
  const problems: string[] = [];
  const checked: string[] = [];
  const notes: string[] = [];
  const state = loadState(repo, session);
  if (!state || state.chunks === 0) return { session, problems: ["not saved yet"], checked, notes };
  const ref = storeRef(state.conv, session);
  const stored = readRecords(ref, { gitDir: repo.store });
  const agents = readAgents(ref, { gitDir: repo.store });
  const all = conversation(repo, state.conv, remote);
  const replayed = replayedIds(all.values());
  const elsewhere = (id: string) => all.has(id) || replayed.has(id);

  // Saved.
  if (state.transcript && existsSync(state.transcript)) {
    const { saved, since } = readAll(state.transcript, session, state.cursor?.offset);
    const n = compare("saved", saved, stored, elsewhere, problems);
    checked.push(`saved: ${n} records of the transcript`);
    let pending = since.length;
    const dir = join(state.transcript.replace(/\.jsonl$/, ""), "subagents");
    for (const file of existsSync(dir) ? readdirSync(dir).sort() : []) {
      const id = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(file)?.[1];
      if (!id) continue;
      // A subagent the last save did not see is read from its start, as the next save reads it.
      const read = readAll(join(dir, file), id, state.agents?.[id]?.cursor.offset ?? 0);
      pending += read.since.length;
      const mine = agents.get(id);
      if (!read.saved.length) continue;
      if (!mine) problems.push(`saved: subagent ${id.slice(0, 8)} is not saved`);
      else compare(`subagent ${id.slice(0, 8)}`, read.saved, mine, () => false, problems);
    }
    if (agents.size) checked.push(`saved: ${agents.size} subagents`);
    if (pending) notes.push(`${pending} records written since the last save, which the next save takes in`);
  } else checked.push("saved: the transcript is gone, so only the store is checked");

  // Loads.
  const head = lastTurn(stored) ?? stored.at(-1)?.id;
  if (head) {
    const fork = forkRecords(all, stored, head);
    const text = forkText(fork, session, "/");
    // Every message a fork writes reads back as it was saved.
    const onPath = new Set(fork.path.map((r) => r.id));
    const written = fork.records.filter((r) => r.type === "message" && (isNative(r) || onPath.has(r.id)));
    const original = replayedIds(fork.records);
    const back = new Map(nativeIds(claudeCode.toAtxf(text, { integrity: false }).records as unknown as Rec[]).map((r) => [original.get(r.id) ?? r.id, r]));
    const lost = written.filter((r) => !back.has(r.id) || said(back.get(r.id)!) !== said(r));
    if (lost.length) problems.push(`loads: ${lost.length} of the ${written.length} messages a fork writes read back otherwise, from: ${describe(lost[0]!, 80)}`);
    // Claude Code starts the chain again after a compaction: a fork resumes from its summary, as Claude Code does.
    const since = fork.path[0]?.type === "custom" && String(fork.path[0].name ?? "").includes("compact") ? " since the last compaction" : "";
    if (state.transcript && existsSync(state.transcript)) {
      // What Claude Code reads to resume the transcript itself, against what it reads from a fork.
      const resumed = canonical(resumeLines(readLines(state.transcript, state.cursor?.offset), head, stored, session));
      const forked = canonical(text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line));
      const at = resumed.findIndex((l, i) => l !== forked[i]);
      if (at >= 0 || resumed.length !== forked.length) {
        const i = at >= 0 ? at : Math.min(resumed.length, forked.length);
        problems.push(`loads: Claude Code reads ${resumed.length} lines to resume the transcript and ${forked.length} from a fork; they differ from line ${i + 1}: ${(resumed[i] ?? forked[i] ?? "").slice(0, 120)}`);
      } else checked.push(`loads: ${resumed.length} lines${since}, the same in a fork as in the transcript`);
    } else checked.push(`loads: ${written.length} messages${since}, the same after a fork`);
  }

  // Store.
  const fsck = run(["fsck", "--no-dangling", "--no-progress"], { gitDir: repo.store });
  if (fsck.status !== 0 || /error|missing|broken/i.test(fsck.stdout + fsck.stderr)) problems.push(`store: git fsck: ${(fsck.stderr || fsck.stdout).trim().split("\n")[0]}`);
  const ids = new Set([...all.keys(), ...[...agents.values()].flat().map((r) => r.id)]);
  const orphans = [...stored, ...[...agents.values()].flat()].filter((r) => typeof r.parentId === "string" && !ids.has(r.parentId));
  if (orphans.length) problems.push(`store: ${orphans.length} records have a parent that is not saved, from: ${describe(orphans[0]!, 80)}`);
  checked.push(`store: ${state.chunks} chunks, git fsck`);
  return { session, problems, checked, notes };
}
