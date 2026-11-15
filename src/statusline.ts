// `braid statusline`: Claude Code's status line command. Runs the user's previous
// status line command, if any, and appends braid's part:
//
//   braid · 5b0e2c1a.12 · Webhook retries
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { printable } from "./records.ts";
import { configDir, repoFor } from "./repo.ts";
import { isBraidLine } from "./setup.ts";
import { loadState } from "./state.ts";
import { colors, computeStatus, render } from "./status.ts";

interface StatusInput {
  session_id?: string;
  cwd?: string;
  workspace?: { current_dir?: string };
}

function previous(stdin: string): string {
  const file = join(configDir(), "statusline.json");
  if (!existsSync(file)) return "";
  const { previous } = JSON.parse(readFileSync(file, "utf8")) as { previous?: string };
  // braid never runs another braid's status line before its own.
  if (!previous || isBraidLine(previous)) return "";
  const r = spawnSync("sh", ["-c", previous], { input: stdin, encoding: "utf8", timeout: 3000 });
  return (r.stdout ?? "").trimEnd();
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
  const { paint, sep, dim } = colors();
  const dir = input.workspace?.current_dir ?? input.cwd ?? process.cwd();
  const repo = repoFor(session, dir);
  const state = loadState(repo, session);
  // The session's newest turn by the name braid fork takes, and what the session is about.
  const name = `${session.slice(0, 8)}${state?.turn ? `.${state.turn}` : ""}`;
  const title = state?.title ? printable(state.title.text, 40) : undefined;
  const after = render(computeStatus(repo, session), paint);
  const ours = [dim("braid"), name, ...(title ? [title] : []), ...(after ? [after] : [])].join(sep);
  if (!prev) return ours;
  return prev.includes("\n") ? `${prev}\n${ours}` : `${prev} · ${ours}`;
}
