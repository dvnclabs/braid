// Reading a Claude Code transcript incrementally. Each save converts only the
// lines written since the previous save, plus an overlap before them so that
// references across the boundary resolve, and never more than a bounded window
// at once, so a transcript of any size saves in bounded memory.
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { claudeCode } from "@leostera/atxf/claude-code";
import type { Rec } from "./records.ts";

export interface Cursor {
  /** Byte offset just past the last line saved. */
  offset: number;
  /** Lines before `offset`. */
  lines: number;
  /** A hash of the line that ends at `offset`, to notice a rewritten file. */
  mark: string;
}

export interface Window {
  records: Rec[];
  header: Record<string, unknown>;
  cursor: Cursor;
  /** The window stopped at its size limit, and more of the file may follow. */
  more: boolean;
}

export const START: Cursor = { offset: 0, lines: 0, mark: "" };
const OVERLAP = 2 * 1024 * 1024;
const MAX_WINDOW = 16 * 1024 * 1024;
const NL = 10;

function readAt(fd: number, start: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let n = 0;
  while (n < length) {
    const r = readSync(fd, buf, n, length - n, start + n);
    if (r === 0) break;
    n += r;
  }
  return buf.subarray(0, n);
}

function newlines(buf: Buffer, from: number, to: number): number {
  let n = 0;
  for (let i = buf.indexOf(NL, from); i !== -1 && i < to; i = buf.indexOf(NL, i + 1)) n++;
  return n;
}

const hash = (buf: Buffer) => createHash("sha256").update(buf).digest("base64");

/** Whether the line before the cursor is still the one the cursor saw. */
export function intact(path: string, cursor: Cursor): boolean {
  if (cursor.offset === 0) return true;
  const fd = openSync(path, "r");
  try {
    if (fstatSync(fd).size < cursor.offset) return false;
    const start = lineAt(fd, cursor.offset - 1);
    return hash(readAt(fd, start, cursor.offset - start)) === cursor.mark;
  } finally {
    closeSync(fd);
  }
}

/**
 * The converter names records without a uuid after their line in the text it
 * was given. Renumbers them to their line in the whole file, scoped to the
 * session, since line numbers repeat across sessions.
 */
function renumber(records: Rec[], base: number, session: string): Rec[] {
  const tag = session.slice(0, 8);
  const fix = (v: unknown) => {
    const m = typeof v === "string" ? /^claude-line-(\d+)(.*)$/.exec(v) : null;
    return m ? `claude-line-${Number(m[1]) + base}${m[2]}@${tag}` : v;
  };
  return records.map((r) => {
    const out: Rec = { ...r, id: fix(r.id) as string };
    for (const key of ["parentId", "targetId", "fromId"]) if (key in r) out[key] = fix(r[key]);
    // A parent before the window is unknown to the converter: keep the native link.
    const parentUuid = (r.native as { records?: { parentUuid?: unknown }[] } | undefined)?.records?.[0]?.parentUuid;
    if (out.parentId === null && typeof parentUuid === "string" && base > 0) out.parentId = parentUuid;
    return out;
  });
}

/** The start of the line holding byte `pos`: just after the newline before it. */
function lineAt(fd: number, pos: number): number {
  const block = 64 * 1024;
  for (let end = pos; end > 0; ) {
    const start = Math.max(0, end - block);
    const i = readAt(fd, start, end - start).lastIndexOf(NL);
    if (i !== -1) return start + i + 1;
    end = start;
  }
  return 0;
}

/** Where the last line of buf[0, end) starts. */
function lastLine(buf: Buffer, end: number): number {
  return end < 2 ? 0 : buf.lastIndexOf(NL, end - 2) + 1;
}

/** Converts the complete lines after `cursor`, or returns undefined when there are none. */
export function readWindow(path: string, cursor: Cursor, session: string, limits = { maxBytes: MAX_WINDOW, overlap: OVERLAP }): Window | undefined {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= cursor.offset) return undefined;
    // Start at a line boundary at least `overlap` bytes back, and always before
    // the last saved line, so records that hang off earlier ones find them.
    const start = lineAt(fd, Math.max(0, cursor.offset - Math.max(1, limits.overlap)));
    let end = Math.min(size, cursor.offset + limits.maxBytes);
    let buf = readAt(fd, start, end - start);
    // A line longer than the window: read on until it ends.
    while (start + buf.lastIndexOf(NL) + 1 <= cursor.offset && end < size) {
      end = Math.min(size, end + limits.maxBytes);
      buf = readAt(fd, start, end - start);
    }
    // Whole lines only: a line still being written waits for the next save.
    const used = buf.lastIndexOf(NL) + 1;
    if (start + used <= cursor.offset) return undefined;
    const base = cursor.lines - newlines(buf, 0, cursor.offset - start);
    const t = claudeCode.toAtxf(buf.toString("utf8", 0, used), { integrity: false });
    return {
      records: renumber(t.records as unknown as Rec[], base, session),
      header: t.header as unknown as Record<string, unknown>,
      cursor: {
        offset: start + used,
        lines: base + newlines(buf, 0, used),
        mark: hash(buf.subarray(lastLine(buf, used), used)),
      },
      more: end < size,
    };
  } finally {
    closeSync(fd);
  }
}
