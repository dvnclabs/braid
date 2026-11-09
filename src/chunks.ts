// A session ref points to a commit whose tree holds the session's records as
// append-only chunks:
//
//   records/000001.jsonl   ATXF records, in the order written
//   meta/000001.json       HEAD and code commits at that save
//
// A save adds one chunk and reuses the earlier ones, so it costs about the size
// of what the turn added.
import { catBlobs, commitTree, lsTree, mktree, revParse, updateRef, writeBlob, type GitOptions, type TreeEntry } from "./git.ts";
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

/** Appends one chunk to a session ref and returns the new commit. */
export function appendChunk(ref: string, records: Rec[], meta: object, opts: GitOptions): string {
  const old = revParse(ref, opts);
  const root = old ? lsTree(old, opts) : [];
  const recs = subtree(root, "records", opts);
  const metas = subtree(root, "meta", opts);
  const n = recs.length + 1;
  recs.push({ mode: "100644", type: "blob", sha: writeBlob(toJsonl(records), opts), name: name(n, "jsonl") });
  metas.push({ mode: "100644", type: "blob", sha: writeBlob(JSON.stringify(meta) + "\n", opts), name: name(n, "json") });
  const tree = mktree(
    [
      { mode: "040000", type: "tree", sha: mktree(recs, opts), name: "records" },
      { mode: "040000", type: "tree", sha: mktree(metas, opts), name: "meta" },
    ],
    opts,
  );
  const commit = commitTree(tree, old ? [old] : [], `save ${n}`, opts);
  updateRef(ref, commit, old, opts);
  return commit;
}

/**
 * Writes a whole set of chunks as one commit on top of `parent`, for published
 * copies. Unchanged chunks hash to the same blobs, so republishing is cheap.
 * Returns undefined when the tree is the same as the parent's.
 */
export function writeChunks(chunks: Rec[][], parent: string | undefined, message: string, opts: GitOptions): string | undefined {
  const recs: TreeEntry[] = chunks.map((c, i) => ({
    mode: "100644",
    type: "blob",
    sha: writeBlob(toJsonl(c), opts),
    name: name(i + 1, "jsonl"),
  }));
  const recordsTree = mktree(recs, opts);
  if (parent && lsTree(parent, opts).find((e) => e.name === "records")?.sha === recordsTree) return undefined;
  const tree = mktree([{ mode: "040000", type: "tree", sha: recordsTree, name: "records" }], opts);
  return commitTree(tree, parent ? [parent] : [], message, opts);
}
