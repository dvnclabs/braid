// Importing OpenClaw sessions. OpenClaw keeps each agent's sessions in SQLite
// (~/.openclaw/agents/<agent>/agent/openclaw-agent.sqlite): transcript events
// in pi's session format, as JSON or zstd-compressed JSON, and the session
// tree in session_nodes. braid opens the database read-only, converts the
// events with ATXF's pi converter in bounded batches, and saves each session
// into the store, picking up after the last event it imported.
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { pi } from "@leostera/atxf/pi";
import { appendChunk } from "./chunks.ts";
import { lastTurn, withBraid, type Actor, type Rec } from "./records.ts";
import { ensureStore, storeRef, type Repo } from "./repo.ts";
import { actorId } from "./save.ts";
import { loadState, newState, saveState, withLock } from "./state.ts";
import { cleanName } from "./status.ts";
import { VERSION } from "./version.ts";

const BATCH_EVENTS = 2000;
const BATCH_BYTES = 16 * 1024 * 1024;

interface Row {
  seq: number;
  event_json: string | null;
  event_zstd: Uint8Array | null;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/** node:sqlite, loaded only for imports, without its experimental-feature warning. */
function openDatabase(path: string): SqliteDatabase {
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string, o: object) => SqliteDatabase };
    return new DatabaseSync(path, { readOnly: true });
  } finally {
    for (const l of listeners) process.on("warning", l);
  }
}

/** The OpenClaw agent databases on this machine. */
export function openclawDatabases(): string[] {
  const agents = join(process.env.OPENCLAW_HOME || join(homedir(), ".openclaw"), "agents");
  if (!existsSync(agents)) return [];
  return readdirSync(agents)
    .map((a) => join(agents, a, "agent", "openclaw-agent.sqlite"))
    .filter((p) => existsSync(p));
}

const decode = (row: Row): string => (row.event_json ?? zstdDecompressSync(Buffer.from(row.event_zstd ?? new Uint8Array())).toString("utf8")).trim();

export interface Imported {
  session: string;
  name: string;
  added: number;
}

/** Imports the sessions of one OpenClaw database, or only those whose key or id starts with `only`. */
export function importOpenclaw(repo: Repo, dbPath: string, only?: string): Imported[] {
  ensureStore(repo);
  const db = openDatabase(dbPath);
  try {
    const nodes = db.prepare("SELECT session_key, current_session_id, parent_session_key, label, display_name FROM session_nodes").all() as {
      session_key: string;
      current_session_id: string;
      parent_session_key: string | null;
      label: string | null;
      display_name: string | null;
    }[];
    const byId = new Map(nodes.map((n) => [n.current_session_id, n]));
    const byKey = new Map(nodes.map((n) => [n.session_key, n]));
    const ids = (db.prepare("SELECT DISTINCT session_id FROM transcript_events").all() as { session_id: string }[]).map((r) => r.session_id);
    const wanted = ids.filter((id) => !only || id.startsWith(only) || (byId.get(id)?.session_key ?? "").startsWith(only));
    // Parents first, so a spawned session joins its parent's conversation.
    const depth = (id: string, seen = new Set<string>()): number => {
      const parent = byKey.get(byId.get(id)?.parent_session_key ?? "")?.current_session_id;
      return parent && !seen.has(parent) ? 1 + depth(parent, seen.add(id)) : 0;
    };
    wanted.sort((a, b) => depth(a) - depth(b));

    const out: Imported[] = [];
    const first = db.prepare("SELECT seq, event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq LIMIT 1");
    const next = db.prepare(`SELECT seq, event_json, event_zstd FROM transcript_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ${BATCH_EVENTS}`);
    for (const id of wanted) {
      const node = byId.get(id);
      const name = cleanName(node?.display_name || node?.label || "") || id.slice(0, 8);
      const added = withLock(repo, `save-${id}`, () => {
        const state = loadState(repo, id) ?? newState(id);
        state.harness = "openclaw";
        const parent = byKey.get(node?.parent_session_key ?? "")?.current_session_id;
        if (state.chunks === 0 && parent) state.conv = loadState(repo, parent)?.conv ?? parent;
        const head = first.get(id) as Row | undefined;
        if (!head) return 0;
        // The session line gives the converter its header; every batch starts with it.
        const headerLine = decode(head);
        const hasHeader = (JSON.parse(headerLine) as { type?: unknown }).type === "session";
        let last = state.importedSeq ?? (hasHeader ? head.seq : head.seq - 1);
        let total = 0;
        for (;;) {
          const rows: Row[] = [];
          let bytes = 0;
          for (const row of next.iterate(id, last) as IterableIterator<Row>) {
            rows.push(row);
            bytes += (row.event_json ?? "").length + (row.event_zstd?.length ?? 0) * 4;
            if (bytes > BATCH_BYTES) break;
          }
          if (rows.length === 0) break;
          const t = pi.toAtxf([...(hasHeader ? [headerLine] : []), ...rows.map(decode)].join("\n"), { integrity: false });
          // A parent in an earlier batch is unknown to the converter: keep the event's own link.
          const records = (t.records as unknown as Rec[]).map((r) => {
            const parentId = (r.native as { records?: { parentId?: unknown }[] } | undefined)?.records?.[0]?.parentId;
            return r.parentId == null && typeof parentId === "string" ? { ...r, parentId } : r;
          });
          const model = [...records].reverse().find((r) => r.role === "assistant")?.model as { provider?: string; id?: string } | undefined;
          const actor: Actor = { actorId: actorId(repo), userAgent: `openclaw${model?.id ? ` ${model.provider ?? "unknown"}:${model.id}` : ""}` };
          const chunk: Rec[] = [];
          if (state.chunks === 0) {
            if (state.conv === id) {
              const h = t.header as unknown as Record<string, unknown>;
              chunk.push({ type: "transcript", atxf: "0.1", id, time: String(h.time ?? new Date().toISOString()), source: { agent: "braid", version: VERSION }, ...(h.workspace ? { workspace: h.workspace } : {}), fidelity: { topology: "tree", native: "all" }, ext: { braid: { version: 1 } } });
            }
            const firstMessage = records.find((r) => r.type === "message");
            if (firstMessage && name !== id.slice(0, 8)) chunk.push({ type: "label", id: `braid-label-${id}`, time: firstMessage.time, targetId: firstMessage.id, label: `openclaw/${name}`.slice(0, 32), ext: { braid: { actor, session: id } } });
          }
          chunk.push(...records.map((r) => withBraid(r, { actor, session: id })));
          last = rows.at(-1)!.seq;
          appendChunk(storeRef(state.conv, id), chunk, { time: new Date().toISOString(), source: `openclaw:${dbPath}`, seq: last }, { gitDir: repo.store });
          state.chunks += 1;
          state.importedSeq = last;
          state.head = lastTurn(records) ?? state.head;
          total += records.length;
          if (rows.length < BATCH_EVENTS && bytes <= BATCH_BYTES) break;
        }
        saveState(repo, state);
        return total;
      });
      out.push({ session: id, name, added });
    }
    return out;
  } finally {
    db.close();
  }
}
