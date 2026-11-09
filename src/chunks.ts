// A session ref points to a commit whose tree holds the session's records as
// append-only chunks:
//
//   records/000001.jsonl          ATXF records, in the order written
//   meta/000001.json              HEAD and code commits at that save
//   agents/<id>/000001.jsonl      records of a subagent the session spawned
//
// A save adds one chunk and reuses the earlier ones, so it costs about the size
// of what the turn added.
import { catBlobs, commitTree, gitMaybe, lsTree, mktree, revParse, updateRef, writeBlob, type GitOptions, type TreeEntry } from "./git.ts";
import { parseJsonl, toJsonl, type Rec } from "./records.ts";

const name = (n: number, ext: string) => `${String(n).padStart(6, "0")}.${ext}`;

function subtree(root: TreeEntry[], dir: string, opts: GitOptions): TreeEntry[] {
  const entry = root.find((e) => e.name === dir && e.type === "tree");
  return entry ? lsTree(entry.sha, opts) : [];
}

/** The records of a session ref, one array per chunk. */
export function readChunks(ref: string, opts: GitOptions): Rec[][] {
  const commit = revParse(ref, opts);
  if (!commit) return [];
  const files = subtree(lsTree(commit, opts), "records", opts)
    .filter((e) => e.type === "blob")
    .sort((a, b) => a.name.localeCompare(b.name));
  return catBlobs(files.map((f) => f.sha), opts).map(parseJsonl);
}

export function readRecords(ref: string, opts: GitOptions): Rec[] {
  return readChunks(ref, opts).flat();
}

/** The subagents saved with a session ref: their records, one array per chunk, by agent id. */
export function readAgentChunks(ref: string, opts: GitOptions): Map<string, Rec[][]> {
  const out = new Map<string, Rec[][]>();
  const commit = revParse(ref, opts);
  if (!commit) return out;
  for (const dir of subtree(lsTree(commit, opts), "agents", opts).filter((e) => e.type === "tree")) {
    const files = lsTree(dir.sha, opts)
      .filter((e) => e.type === "blob")
      .sort((a, b) => a.name.localeCompare(b.name));
    out.set(dir.name, catBlobs(files.map((f) => f.sha), opts).map(parseJsonl));
  }
  return out;
}

export function readAgents(ref: string, opts: GitOptions): Map<string, Rec[]> {
  return new Map([...readAgentChunks(ref, opts)].map(([id, chunks]) => [id, chunks.flat()]));
}

/** The `agents` tree: each agent's chunks under agents/<id>/, adding `added` as each agent's next chunk. */
function agentsTree(existing: TreeEntry[], added: Map<string, Rec[][]>, opts: GitOptions): TreeEntry | undefined {
  const dirs = new Map(existing.filter((e) => e.type === "tree").map((e) => [e.name, lsTree(e.sha, opts)]));
  for (const [id, chunks] of added) {
    const files = dirs.get(id) ?? [];
    for (const chunk of chunks.filter((c) => c.length > 0)) {
      files.push({ mode: "100644", type: "blob", sha: writeBlob(toJsonl(chunk), opts), name: name(files.length + 1, "jsonl") });
    }
    dirs.set(id, files);
  }
  const entries: TreeEntry[] = [...dirs]
    .filter(([, files]) => files.length > 0)
    .map(([id, files]) => ({ mode: "040000", type: "tree", sha: mktree(files, opts), name: id }));
  return entries.length ? { mode: "040000", type: "tree", sha: mktree(entries, opts), name: "agents" } : undefined;
}

/** Appends one chunk to a session ref, and one to each subagent in `agents`, and returns the new commit. */
export function appendChunk(ref: string, records: Rec[], meta: object, opts: GitOptions, agents = new Map<string, Rec[]>()): string {
  const old = revParse(ref, opts);
  const root = old ? lsTree(old, opts) : [];
  const recs = subtree(root, "records", opts);
  const metas = subtree(root, "meta", opts);
  const n = recs.length + 1;
  recs.push({ mode: "100644", type: "blob", sha: writeBlob(toJsonl(records), opts), name: name(n, "jsonl") });
  metas.push({ mode: "100644", type: "blob", sha: writeBlob(JSON.stringify(meta) + "\n", opts), name: name(n, "json") });
  const agentEntry = agentsTree(subtree(root, "agents", opts), new Map([...agents].map(([id, r]) => [id, [r]])), opts);
  const tree = mktree(
    [
      { mode: "040000", type: "tree", sha: mktree(recs, opts), name: "records" },
      { mode: "040000", type: "tree", sha: mktree(metas, opts), name: "meta" },
      ...(agentEntry ? [agentEntry] : []),
    ],
    opts,
  );
  const commit = commitTree(tree, old ? [old] : [], `save ${n}`, opts);
  updateRef(ref, commit, old, opts);
  return commit;
}

/**
 * Writes a whole set of chunks, and the subagents' chunks, as one commit on top
 * of `parent`, for published copies. Unchanged chunks hash to the same blobs,
 * so republishing is cheap. Returns undefined when the tree is the parent's.
 */
export function writeChunks(chunks: Rec[][], parent: string | undefined, message: string, opts: GitOptions, agents = new Map<string, Rec[][]>()): string | undefined {
  const recs: TreeEntry[] = chunks.map((c, i) => ({
    mode: "100644",
    type: "blob",
    sha: writeBlob(toJsonl(c), opts),
    name: name(i + 1, "jsonl"),
  }));
  const agentEntry = agentsTree([], agents, opts);
  const tree = mktree([{ mode: "040000", type: "tree", sha: mktree(recs, opts), name: "records" }, ...(agentEntry ? [agentEntry] : [])], opts);
  if (parent && gitMaybe(["rev-parse", `${parent}^{tree}`], opts)?.trim() === tree) return undefined;
  return commitTree(tree, parent ? [parent] : [], message, opts);
}
