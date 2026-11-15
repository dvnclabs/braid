// Finding sessions in a project's .braid folder.
import { existsSync, readdirSync } from "node:fs";
import type { Repo } from "./repo.ts";
import { loadState } from "./state.ts";

export interface Found {
  session: string;
}

/** Every session the project keeps. */
export function allSessions(repo: Repo): Found[] {
  if (!existsSync(repo.sessions)) return [];
  return readdirSync(repo.sessions)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      const state = loadState(repo, f.slice(0, -".json".length));
      return state ? [{ session: state.session }] : [];
    });
}

/** A session's name for people: the one you gave it with /rename, else the first characters of its id. */
export function sessionName(repo: Repo, session: string): string {
  const title = loadState(repo, session)?.title;
  return title?.by === "user" ? title.text : session.slice(0, 8);
}

/** Finds sessions by id or its first characters, or by the name you gave one with /rename. */
export function resolve(repo: Repo, target: string): Found[] {
  const sessions = allSessions(repo);
  const byId = sessions.filter((s) => s.session.startsWith(target));
  if (byId.length > 0 || /^[0-9a-f-]{8,}$/.test(target)) return byId;
  return sessions.filter((s) => {
    const title = loadState(repo, s.session)?.title;
    return title?.by === "user" && title.text === target;
  });
}
