// `braid statusline`: Claude Code's status line command. Runs the user's previous
// status line command, if any, and appends braid's part:
//
//   braid · 5b0e2c1a.12 · Webhook retries · ↓ 3f2a91c0 +4 → /braid:merge
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { printable } from "./records.ts";
import { configDir, repoFor, type Repo } from "./repo.ts";
import { isBraidLine } from "./setup.ts";
import { loadState } from "./state.ts";
import { colors, computeStatus, render } from "./status.ts";

interface StatusInput {
  session_id?: string;
  cwd?: string;
  workspace?: { current_dir?: string };
}

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

function previous(stdin: string): string {
  const file = join(configDir(), "statusline.json");
  if (!existsSync(file)) return "";
  const { previous } = JSON.parse(readFileSync(file, "utf8")) as { previous?: string };
  // braid never runs another braid's status line before its own.
  if (!previous || isBraidLine(previous)) return "";
  const r = spawnSync("sh", ["-c", previous], { input: stdin, encoding: "utf8", timeout: 3000 });
  return (r.stdout ?? "").trimEnd();
}

/** The marks after the session's name, cached until a session of the project is saved again. */
function marks(repo: Repo, session: string): string {
  const files = existsSync(repo.sessions) ? readdirSync(repo.sessions).sort() : [];
  const key = hash([session, process.env.NO_COLOR ? "plain" : "color", ...files.map((f) => `${f} ${statSync(join(repo.sessions, f)).mtimeMs}`)].join("\n"));
  const file = join(repo.cache, `status-${key}`);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const { paint, sep } = colors();
  const text = render(computeStatus(repo, session), paint, sep);
  mkdirSync(repo.cache, { recursive: true });
  writeFileSync(file, text);
  return text;
}

export function statusline(stdin: string): string {
  let input: StatusInput = {};
  try {
    input = JSON.parse(stdin) as StatusInput;
  } catch {
    // not JSON: show nothing of ours
  }
  const prev = previous(stdin);
  const session = input.session_id;
  if (!session) return prev;
  const { sep, dim } = colors();
  const dir = input.workspace?.current_dir ?? input.cwd ?? process.cwd();
  const repo = repoFor(session, dir);
  const state = loadState(repo, session);
  // The session's newest turn by the name braid fork takes, and what the session is about.
  const name = `${session.slice(0, 8)}${state?.turn ? `.${state.turn}` : ""}`;
  const title = state?.title ? printable(state.title.text, 40) : undefined;
  const after = state ? marks(repo, session) : "";
  const ours = [dim("braid"), name, ...(title ? [title] : []), ...(after ? [after] : [])].join(sep);
  if (!prev) return ours;
  return prev.includes("\n") ? `${prev}\n${ours}` : `${prev} · ${ours}`;
}
