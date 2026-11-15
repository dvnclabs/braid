// What the status line shows after a session's name: ⚠ when braid verify found
// a problem the last time the session ended.
import type { Repo } from "./repo.ts";
import { loadState } from "./state.ts";

export interface Status {
  session: string;
  saved: boolean;
  /** The last braid verify, when the session ended, found problems. */
  broken?: boolean;
}

export function computeStatus(repo: Repo, session: string): Status {
  const state = loadState(repo, session);
  return { session, saved: (state?.chunks ?? 0) > 0, broken: state?.verified?.ok === false };
}

/** How the status line colors each kind of mark. */
export type Tone = "quiet" | "broken";
export type Paint = (tone: Tone, text: string) => string;
const plain: Paint = (_tone, text) => text;

const SGR: Record<Tone | "sep", [string, string]> = {
  quiet: ["2", "22"],
  broken: ["31", "39"],
  sep: ["2", "22"],
};

/** Terminal colors, unless NO_COLOR is set. */
export function colors(env: NodeJS.ProcessEnv = process.env): { paint: Paint; sep: string; dim: (s: string) => string } {
  if (env.NO_COLOR) return { paint: plain, sep: " · ", dim: (s) => s };
  const wrap = (k: Tone | "sep", t: string) => `\x1b[${SGR[k][0]}m${t}\x1b[${SGR[k][1]}m`;
  return { paint: wrap, sep: wrap("sep", " · "), dim: (t) => wrap("quiet", t) };
}

/** The marks after a session's name: a failed check. */
export function render(s: Status, paint: Paint = plain): string {
  return s.broken ? paint("broken", "⚠ braid verify") : "";
}
