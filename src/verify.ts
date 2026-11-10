// braid verify: checks that a session was saved as it happened, and that it
// loads back as it was saved. Three checks, like git fsck for conversations:
//
// - saved: every record of the transcript, and of each subagent's, is in the
//   store with the same content, in the same order. Records a fork shares with
//   the session it came from live there, and count as saved.
// - loads: the session's path, written back as a Claude Code transcript as
//   `braid fork` writes it, and read again, gives the same messages.
// - store: git fsck finds nothing wrong, and every record's parent is in the
//   conversation.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { claudeCode, uuidFor } from "@leostera/atxf/claude-code";
import { readAgents, readRecords } from "./chunks.ts";
import { run } from "./git.ts";
import { conversation } from "./load.ts";
import { ancestry, describe, lastTurn, type Rec } from "./records.ts";
import { storeRef, type Repo } from "./repo.ts";
import { loadState } from "./state.ts";
import { readWindow, START, type Cursor } from "./transcript.ts";

export interface Verified {
  session: string;
  /** What is wrong; empty when the session is saved and loads as it should. */
  problems: string[];
  /** What was checked, for the report. */
  checked: string[];
}

/** Every record of a transcript file, read as save reads it. */
function readAll(path: string, id: string): Rec[] {
  const out = new Map<string, Rec>();
  let cursor: Cursor = START;
  for (let w = readWindow(path, cursor, id); w; w = w.more ? readWindow(path, cursor, id) : undefined) {
    // A record read again in the next window's overlap keeps its place in the file, and the read with more context.
    for (const r of w.records) out.set(r.id, r);
    cursor = w.cursor;
  }
  return [...out.values()];
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

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
}

/** Compares a transcript's records with the stored ones. `elsewhere` holds ids saved in other sessions of the conversation. */
function compare(what: string, transcript: Rec[], stored: Rec[], elsewhere: (id: string) => boolean, problems: string[]): number {
  const byId = new Map(stored.map((r) => [r.id, r]));
  const twice = stored.length - byId.size;
  if (twice) problems.push(`${what}: ${twice} records are saved twice`);
  const missing = transcript.filter((r) => !byId.has(r.id) && !elsewhere(r.id));
  const changed = transcript.filter((r) => byId.has(r.id) && content(byId.get(r.id)!) !== content(r));
  if (missing.length) problems.push(`${what}: ${missing.length} records of the transcript are not saved, from: ${describe(missing[0]!, 80)}`);
  if (changed.length) problems.push(`${what}: ${changed.length} saved records differ from the transcript, from: ${describe(changed[0]!, 80)}`);
  // Saved records keep the transcript's order.
  const at = new Map(transcript.map((r, i) => [r.id, i]));
  const order = stored.map((r) => at.get(r.id)).filter((i): i is number => i !== undefined);
  const swaps = order.filter((i, k) => k > 0 && i < order[k - 1]!).length;
  if (swaps) problems.push(`${what}: ${swaps} saved records are out of the transcript's order`);
  return transcript.length - missing.length;
}

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
  const state = loadState(repo, session);
  if (!state || state.chunks === 0) return { session, problems: ["not saved yet"], checked };
  const ref = storeRef(state.conv, session);
  const stored = readRecords(ref, { gitDir: repo.store });
  const agents = readAgents(ref, { gitDir: repo.store });
  const all = conversation(repo, state.conv, remote);
  const replayed = new Set([...all.keys()].map((id) => uuidFor(id)));
  const elsewhere = (id: string) => all.has(id) || replayed.has(id);

  // Saved.
  if (state.transcript && existsSync(state.transcript)) {
    const n = compare("saved", readAll(state.transcript, session), stored, elsewhere, problems);
    checked.push(`saved: ${n} records of the transcript`);
    const dir = join(state.transcript.replace(/\.jsonl$/, ""), "subagents");
    for (const file of existsSync(dir) ? readdirSync(dir).sort() : []) {
      const id = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(file)?.[1];
      if (!id) continue;
      const mine = agents.get(id);
      if (!mine) {
        problems.push(`saved: subagent ${id.slice(0, 8)} is not saved`);
        continue;
      }
      compare(`subagent ${id.slice(0, 8)}`, readAll(join(dir, file), id), mine, () => false, problems);
    }
    if (agents.size) checked.push(`saved: ${agents.size} subagents`);
  } else checked.push("saved: the transcript is gone, so only the store is checked");

  // Loads.
  const head = lastTurn(stored) ?? stored.at(-1)?.id;
  if (head) {
    const parents = new Map([...all.values()].map((r) => [r.id, r.parentId ?? null]));
    const path = ancestry(head, parents)
      .reverse()
      .map((id) => all.get(id))
      .filter((r): r is Rec => !!r && r.type !== "transcript");
    const header = { type: "transcript", atxf: "0.1", id: session, time: path[0]?.time ?? "", source: { agent: "braid", sessionId: session } };
    const text = claudeCode.fromAtxf({ header, records: path } as never, { carry: false, sessionId: session });
    const back = (claudeCode.toAtxf(text, { integrity: false }).records as unknown as Rec[]).filter((r) => r.type === "message");
    const before = path.filter((r) => r.type === "message");
    const differ = before.findIndex((r, i) => !back[i] || said(r) !== said(back[i]!));
    if (differ >= 0 || back.length !== before.length) {
      const at = differ >= 0 ? differ : Math.min(before.length, back.length);
      problems.push(`loads: ${before.length} messages, ${back.length} after loading; they differ from message ${at + 1}${before[at] ? `: ${describe(before[at]!, 80)}` : ""}`);
    }
    // Claude Code starts the chain again after a compaction: a fork resumes from its summary, as Claude Code does.
    const since = path[0]?.type === "custom" && String(path[0].name ?? "").includes("compact") ? " since the last compaction" : "";
    checked.push(`loads: ${before.length} messages${since}, the same after a fork`);
  }

  // Store.
  const fsck = run(["fsck", "--no-dangling", "--no-progress"], { gitDir: repo.store });
  if (fsck.status !== 0 || /error|missing|broken/i.test(fsck.stdout + fsck.stderr)) problems.push(`store: git fsck: ${(fsck.stderr || fsck.stdout).trim().split("\n")[0]}`);
  const ids = new Set([...all.keys(), ...[...agents.values()].flat().map((r) => r.id)]);
  const orphans = [...stored, ...[...agents.values()].flat()].filter((r) => typeof r.parentId === "string" && !ids.has(r.parentId));
  if (orphans.length) problems.push(`store: ${orphans.length} records have a parent that is not saved, from: ${describe(orphans[0]!, 80)}`);
  checked.push(`store: ${state.chunks} chunks, git fsck`);
  return { session, problems, checked };
}
