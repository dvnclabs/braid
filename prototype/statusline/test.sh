#!/bin/sh
# Builds a throwaway repository whose session refs are cut from the example
# conversation, then checks what braid-status.sh prints as the story unfolds.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
example="$here/../../examples/pr-review/conversation.atxf.jsonl"
alice=5b0e2c1a-7f3d-4c2e-9a61-0d8e4b2f6c13
bob=01a1bc3e-e950-7c4b-9e7a-62f0e9a7c418
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

repo=$(mktemp -d)
trap 'rm -rf "$repo"' EXIT
git -C "$repo" init -q
git -C "$repo" commit -q --allow-empty -m "initial"
store="$repo/.git/braid/store"
git init -q --bare "$store"
mkdir -p "$repo/.git/braid/withheld" "$repo/.git/braid/merge"

# save <git-dir> <ref> <jq filter>...: points ref at a commit whose tree holds
# one chunk file per filter, each with the example records the filter emits.
save() {
  gitdir=$1 name=$2
  shift 2
  n=0 entries=
  for filter in "$@"; do
    n=$((n + 1))
    jq -c "$filter" "$example" >"$repo/chunk"
    blob=$(git --git-dir="$gitdir" hash-object -w "$repo/chunk")
    entries="$entries$(printf '100644 blob %s\t%06d.jsonl' "$blob" "$n")
"
  done
  sub=$(printf '%s' "$entries" | git --git-dir="$gitdir" mktree)
  tree=$(printf '040000 tree %s\trecords\n' "$sub" | git --git-dir="$gitdir" mktree)
  commit=$(git --git-dir="$gitdir" commit-tree "$tree" -m "$name" </dev/null)
  git --git-dir="$gitdir" update-ref "$name" "$commit"
}
mine="refs/sessions/$alice/$alice"
pub="refs/braid/remotes/origin/sessions/$alice"
only() { printf 'select(.id | IN(%s))' "$1"; }
A1='select(.type == "transcript" or (.id | IN("e1","e2","e3","e4","e5","e6","e7","e8")))'
A2=$(only '"e9","e10","e11","e12"')
A3=$(only '"s1","s2","s3","s4","m1","e13","e14","e15","e16","e17"')
B=$(only '"r1","r2","r3","r4","r5","l1"')
R6='select(.id == "r5") | .id = "r6" | .parentId = "r5"'
SKIP='select(.id == "m1") | .id = "k1" | .parentId = "e17" | .fromId = "r6" | .summary = "Skipped review/bob."
  | .ext.braid.merge = {base: "r5", heads: ["e17", "r6"], instruction: "skip review/bob", strategy: "skip", model: "none", conflicts: []}'
CAROL='select(.id == "r4") | .id = "c1" | .parentId = "r3"'
DAVE='select(.id == "e9" or .id == "e10") | .parentId = (if .id == "e9" then "e12" else "de9" end) | .id = "d" + .id'
EVE='(select(.id == "e9") | .id = "v1" | .parentId = "e17"),
  (select(.id == "l1") | .id = "v2" | .targetId = "v1" | .label = "\u001b[2Kall clear ✓")'

status=0
check() {
  cwd=${3:-$repo}
  got=$(printf '{"session_id":"%s","workspace":{"current_dir":"%s"}}' "$alice" "$cwd" \
    | BRAID_STATUS_NO_PR=1 "$here/braid-status.sh")
  if [ "$got" = "$2" ]; then echo "ok    $1: $got"; else echo "FAIL  $1: got '$got', want '$2'"; status=1; fi
}

check "repository without braid" "5b0e2c1a"

mkdir -p "$repo/.braid" "$repo/src/webhooks"
touch "$repo/.braid/config.toml"
check "braid set up, session not saved" "5b0e2c1a · not saved"
check "same, from a subfolder" "5b0e2c1a · not saved" "$repo/src/webhooks"

save "$store" "$mine" "$A1"
check "saved, no commit, never published" "5b0e2c1a · local"

git -C "$repo" commit -q --allow-empty -m "Retry webhook deliveries on 5xx

Braid-Session: $alice"
check "committed, not pushed" "5b0e2c1a · ↑8"

save "$repo/.git" "$pub/$alice" "$A1"
save "$store" "$mine" "$A1" "$A2"
save "$repo/.git" "$pub/$bob" "$B"
check "4 to push, review waiting" "5b0e2c1a · ↑4 · ↓ review/bob +5 → /braid:sync"
check "same, from a subfolder" "5b0e2c1a · ↑4 · ↓ review/bob +5 → /braid:sync" "$repo/src/webhooks"

echo e9 >"$repo/.git/braid/withheld/$alice"
check "one record withheld" "5b0e2c1a · ↑3 · ↓ review/bob +5 → /braid:sync"
rm "$repo/.git/braid/withheld/$alice"

save "$repo/.git" "$pub/carol" "$CAROL"
check "a fork of bob's session is not counted" "5b0e2c1a · ↑4 · ↓ review/bob +5 → /braid:sync"

save "$repo/.git" "$pub/dave" "$DAVE"
check "two sessions waiting" "5b0e2c1a · ↑4 · ↓ 2 sessions +7 → /braid:sync"
git -C "$repo" update-ref -d "$pub/dave"

touch "$repo/.git/braid/merge/$alice"
check "merge pending" "5b0e2c1a · ↑4 · ↓ review/bob +5 → /braid:sync · ⚠ merge pending"
rm "$repo/.git/braid/merge/$alice"

save "$store" "$mine" "$A1" "$A2" "$A3"
save "$repo/.git" "$pub/$alice" "$A1" "$A2" "$A3"
check "review merged and pushed" "5b0e2c1a · ✓"

save "$repo/.git" "$pub/$bob" "$B" "$R6"
check "bob adds a record after the merge" "5b0e2c1a · ↓ review/bob +1 → /braid:sync"

save "$store" "$mine" "$A1" "$A2" "$A3" "$SKIP"
save "$repo/.git" "$pub/$alice" "$A1" "$A2" "$A3" "$SKIP"
check "alice skips it" "5b0e2c1a · ✓"

save "$repo/.git" "$pub/eve" "$EVE"
check "control characters in a name are removed" "5b0e2c1a · ↓ 2Kallclear +1 → /braid:sync"

exit $status
