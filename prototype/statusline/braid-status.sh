#!/bin/sh
# braid status line segment (prototype). See docs/design.md#status.
#
# Reads Claude Code's status line JSON on stdin and prints one line:
#
#   5b0e2c1a · #128 · ↑4 · ↓ review/bob +5 → /braid:sync
#
# Where it reads (docs/design.md#storage):
#   .git/braid/store, refs/sessions/<conv>/<session>    your sessions, unredacted
#   refs/braid/remotes/origin/sessions/<conv>/<session>  published copies, fetched
#   .git/braid/withheld/<session>                        record ids kept private
#   .git/braid/merge/<session>                           a merge waiting on conflicts
# Each session ref holds records/*.jsonl chunks with the records that session wrote.
#
# Needs git and jq. gh is optional, for the pull request number.
# BRAID_STATUS_NO_PR=1 skips the pull request lookup.

input=$(cat)
if command -v jq >/dev/null 2>&1; then
  sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
  dir=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // empty' 2>/dev/null)
else
  sid=$(printf '%s' "$input" | sed -n 's/.*"session_id" *: *"\([0-9A-Za-z-]*\)".*/\1/p')
fi
[ -n "$sid" ] || exit 0
[ -n "${dir-}" ] || dir=$PWD

out=$(printf '%.8s' "$sid")
emit() { printf '%s\n' "$out"; exit 0; }
command -v jq >/dev/null 2>&1 || emit

top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || emit
common=$(git -C "$top" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || emit
store="$common/braid/store"
cache="$common/braid/cache"
mkdir -p "$cache" 2>/dev/null || emit

# Pull request of the current branch. gh is slow, so the number is cached for
# five minutes and refreshed in the background; the line never waits for it.
if [ -z "${BRAID_STATUS_NO_PR-}" ] && command -v gh >/dev/null 2>&1; then
  branch=$(git -C "$top" branch --show-current 2>/dev/null)
  if [ -n "$branch" ]; then
    f="$cache/pr-$(printf '%s' "$branch" | shasum | cut -c1-16)"
    if [ -z "$(find "$f" -mmin -5 2>/dev/null)" ]; then
      touch "$f"
      ( t=$(mktemp "$cache/pr.XXXXXX") && cd "$top" && gh pr view --json number -q .number >"$t" 2>/dev/null
        mv "$t" "$f" ) </dev/null >/dev/null 2>&1 &
    fi
    pr=$(head -c 12 "$f" 2>/dev/null | tr -cd '0-9')
    [ -n "$pr" ] && out="$out · #$pr"
  fi
fi

# This session in the local store. The folder above it names the conversation.
mine=$(git --git-dir="$store" for-each-ref --count=1 --format='%(refname)' "refs/sessions/*/$sid" 2>/dev/null)
if [ -z "$mine" ]; then
  [ -f "$top/.braid/config.toml" ] && out="$out · not saved"
  emit
fi
conv=${mine#refs/sessions/}
conv=${conv%/*}
remote="refs/braid/remotes/origin/sessions/$conv"

# The rest changes only when a ref of this conversation, HEAD, the withheld list
# or a pending merge changes, so it is cached under a key made of exactly those.
key=$({
  printf '%s\n' "$sid"
  git --git-dir="$store" for-each-ref --format='%(objectname) %(refname)' "refs/sessions/$conv/"
  git -C "$top" for-each-ref --format='%(objectname) %(refname)' "$remote/"
  git -C "$top" rev-parse -q HEAD
  cat "$common/braid/withheld/$sid" 2>/dev/null
  [ -f "$common/braid/merge/$sid" ] && echo merge-pending
} | shasum | cut -c1-16)
if [ -f "$cache/state-$key" ]; then
  out="$out$(cat "$cache/state-$key")"
  emit
fi

tmp=$(mktemp -d) || emit
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' HUP INT TERM

# records <git-dir> <ref>: every record in the ref's chunks, in chunk order.
records() {
  git --git-dir="$1" ls-tree -r --name-only "$2" -- records/ 2>/dev/null | sort \
    | sed "s|^|$2:|" | git --git-dir="$1" cat-file --batch 2>/dev/null | grep '^{'
}
# written: sorted ids of the messages and merges in a record stream.
written() { jq -r 'select(.type == "message" or .type == "branch_summary") | .id' | sort; }

state=

# ↑ records of this session that are not published and not withheld. A session
# that was never published and has no commit yet is shown as local.
records "$store" "$mine" >"$tmp/mine"
written <"$tmp/mine" >"$tmp/mine.ids"
records "$common" "$remote/$sid" | written >"$tmp/published.ids"
sort "$common/braid/withheld/$sid" 2>/dev/null >"$tmp/withheld.ids"
ahead=$(comm -23 "$tmp/mine.ids" "$tmp/published.ids" | comm -23 - "$tmp/withheld.ids" | wc -l | tr -d ' ')
if ! git -C "$top" rev-parse -q --verify "$remote/$sid" >/dev/null &&
   ! git -C "$top" log -n 200 --format=%B HEAD 2>/dev/null | grep -qF "Braid-Session: $sid"; then
  state=" · local"
elif [ "$ahead" -gt 0 ]; then
  state=" · ↑$ahead"
fi

# ↓ sessions that forked from this one, counting their records that no merge in
# this session covers. A merge covers its heads and everything before them.
jq -s '[.[].id]' "$tmp/mine" >"$tmp/mine.json"
jq -s '[.[] | select(.type == "branch_summary") | .ext.braid.merge.heads[]?]' "$tmp/mine" >"$tmp/heads.json"
: >"$tmp/behind"
for ref in $(git -C "$top" for-each-ref --format='%(refname)' "$remote/"); do
  [ "${ref##*/}" = "$sid" ] && continue
  records "$common" "$ref" | jq -r -s --slurpfile mine "$tmp/mine.json" --slurpfile heads "$tmp/heads.json" '
    . as $t
    | ($mine[0] | map({key: ., value: true}) | from_entries) as $m
    | ($t | map({key: .id, value: .parentId}) | from_entries) as $p
    | select(any($t[]; .parentId != null and $m[.parentId]))
    | ([$heads[0][] | select(. as $h | $p | has($h))
        | recurse($p[.] // empty | select(. as $x | $p | has($x)))]
       | map({key: ., value: true}) | from_entries) as $cov
    | ([$t[] | select((.type == "message" or .type == "branch_summary") and ($cov[.id] | not))] | length) as $n
    | select($n > 0)
    | "\($n)\t\(first($t[] | select(.type == "label") | .label) // "")"' 2>/dev/null \
    | while IFS='	' read -r n name; do
        # Names come from other people's records: keep them short and printable.
        name=$(printf '%s' "$name" | tr -cd 'A-Za-z0-9/._-' | cut -c1-32)
        [ -n "$name" ] || name=$(printf '%.8s' "${ref##*/}")
        printf '%s\t%s\n' "$n" "$name"
      done >>"$tmp/behind"
done
sessions=$(wc -l <"$tmp/behind" | tr -d ' ')
if [ "$sessions" -eq 1 ]; then
  IFS='	' read -r n name <"$tmp/behind"
  state="$state · ↓ $name +$n → /braid:sync"
elif [ "$sessions" -gt 1 ]; then
  total=$(awk -F'\t' '{ s += $1 } END { print s }' "$tmp/behind")
  state="$state · ↓ $sessions sessions +$total → /braid:sync"
fi

[ -f "$common/braid/merge/$sid" ] && state="$state · ⚠ merge pending"
[ -n "$state" ] || state=" · ✓"

printf '%s' "$state" >"$cache/state-$key"
find "$cache" -name 'state-*' -mmin +1440 -delete 2>/dev/null
out="$out$state"
emit
