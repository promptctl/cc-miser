#!/usr/bin/env bash
#
# Does this repo contain anything that identifies the machine or the person it was
# written on? Scans the working tree, every blob in history, and every tracked binary.
#
# WHY THE IDENTIFIER LIST IS NOT WRITTEN DOWN HERE.
#
# The obvious design is a literal list — the author's login, surname and email, spelled
# out. It is also self-defeating twice over: committing those strings puts the very
# personal data this repo is meant to be free of INTO the repo, and the scan would then
# match itself forever. Worse, a hardcoded list only works for the one person who wrote
# it, and this tool exists precisely because cc-miser has to run on machines nobody here
# has ever seen.
#
# This is not hypothetical: the first draft of this comment listed the real identifiers
# as an illustration, and the scan's first clean-tree run flagged this file. The rule
# holds even inside the file that states the rule — so nothing below names a real
# person, a real host or a real path.
#
# So the RULE is what is written down, not the answers. Identifiers are derived from
# whoever runs this: the login name, the home directory, the git identity, the
# hostname. On the author's laptop that finds one set of strings; on a colleague's
# enterprise machine it finds theirs, with no edit. That is the epic's standing test
# applied to its own tooling — a check that only works on this laptop is not a check.
#
# Anything not derivable (an employer, a client, an internal codename) is passed as
# arguments:  bash scripts/privacy-scan.sh acme-corp project-thunder
#
# Exit 0 = clean. Exit 1 = something needs a human's eyes. The output is the finding,
# not a summary of it. [LAW:no-silent-failure]

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# --- Identity, derived ------------------------------------------------------
#
# Lean inclusive, but not blindly. The first cut of this script split the git email on
# punctuation and derived "com", "users", "noreply" and "github" as identifiers, which
# then matched `command`, `commander`, `compaction` and `outcome` — most of the repo.
#
# A scan that always fails is worse than no scan. It is ignored within a day, and the
# real leak then arrives inside a wall of noise nobody reads. So: an email contributes
# its whole self and its local part, never its domain; and words that cannot identify
# anyone are dropped by name below. [LAW:verifiable-goals] — "clean" has to be a state
# this repo can actually be in, or the check asserts nothing.

# Words that appear in every email address and identify no one. Dropping them is not a
# loosening of the scan: an identifier that is only "com" was never an identifier.
STOPWORDS=" com net org edu www mail gmail email users user noreply github gitlab local localhost home admin root none null test "

tokens=()
add() {
  # Under 3 characters, a token matches nearly everything and drowns the signal.
  [ "${#1}" -lt 3 ] && return 0
  # Case-fold before the stoplist check so "COM" is dropped as readily as "com".
  local lower
  lower="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$STOPWORDS" in *" $lower "*) return 0 ;; esac
  tokens+=("$1")
  return 0
}

add "${USER:-}"
add "$(basename "${HOME:-}")"
add "${HOME:-}"
add "$(hostname 2>/dev/null || true)"
add "$(hostname -s 2>/dev/null || true)"

git_name="$(git config user.name || true)"
git_email="$(git config user.email || true)"
add "$git_email"
add "${git_email%%@*}"
# A display name is several identifiers wearing one string: "Ada Lovelace" leaks as
# "ada" and as "lovelace" independently of each other.
for word in $git_name; do add "$word"; done
# The LOCAL part only. The domain is shared with millions of people and is pure noise.
email_local="${git_email%%@*}"
for word in ${email_local//[.+_-]/ }; do add "$word"; done

# Caller-supplied terms this machine cannot know about.
for extra in "$@"; do add "$extra"; done

# Dedupe, lowercase. The scan is case-insensitive, so a name and its capitalisation are
# one token, and reporting both would just double every hit.
#
# Written as a read loop rather than `mapfile` on purpose: macOS still ships bash 3.2 as
# /bin/bash, and a portability tool that needs a newer shell than the target machine has
# is not a portability tool.
_deduped="$(printf '%s\n' "${tokens[@]}" | tr '[:upper:]' '[:lower:]' | sort -u)"
tokens=()
while IFS= read -r _t; do
  [ -n "$_t" ] && tokens+=("$_t")
done <<EOF
$_deduped
EOF

if [ "${#tokens[@]}" -eq 0 ]; then
  echo "ERROR: derived no identifiers to scan for — git identity and \$USER are both empty," >&2
  echo "       so a clean result here would mean nothing. Refusing to report success." >&2
  exit 1
fi

# One alternation, so each file and each blob is read exactly once regardless of how
# many identifiers there are. [LAW:dataflow-not-control-flow] — the token list is data
# flowing into one fixed scan, not a branch per identifier.
#
# Matched with grep -w throughout. A three-letter hostname is a substring of ordinary
# English words, and without word boundaries it reports every one of them. Boundaries
# are what make a short token usable at all rather than pure noise.
pattern="$(printf '%s\n' "${tokens[@]}" | sed 's/[][\.^$*+?(){}|/\\]/\\&/g' | paste -sd '|' -)"

echo "scanning for ${#tokens[@]} derived identifiers: ${tokens[*]}"
echo

failed=0

# --- 1. The working tree ----------------------------------------------------

echo "== tracked files =="
# The scanner scans itself too. It stores no identifiers, so it has nothing to hide —
# and exempting it would carve out exactly the blind spot where a future hardcoded
# term could sit unnoticed.
tree_hits="$(git grep -I -n -i -w -E "$pattern" -- . || true)"
if [ -n "$tree_hits" ]; then
  echo "$tree_hits"
  echo "FAIL: identifiers present in tracked files."
  failed=1
else
  echo "clean"
fi
echo

# --- 2. Every blob that has ever existed ------------------------------------
#
# A file deleted in the working tree is still in the pack until history is rewritten,
# and `git grep` on HEAD cannot see it. This is the check that actually answers
# "is it gone", and the one most likely to be skipped.

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# EVERY blob in the object database, not just the reachable ones. After a history
# rewrite the old objects linger, unreferenced but perfectly readable, until they are
# gc'd — and "unreachable" is not "gone". Scanning only `rev-list` output would declare
# victory the moment the refs moved and miss the data still sitting in the pack.
git cat-file --batch-all-objects --batch-check='%(objectname) %(objecttype)' \
  | awk '$2 == "blob" { print $1 }' > "$work/blobs"

# Paths, where a blob still has one. `git rev-list --objects` emits trees and commits
# alongside blobs; an earlier cut of this script fed all of them to `cat-file blob`,
# which failed on every tree and reported each failure as "binary content". Hence the
# type filter above rather than a filter on the shape of the line.
git rev-list --objects --all | awk 'NF > 1 { print $1 "\t" $2 }' | sort -u > "$work/paths"

blob_path() {
  local p
  p="$(grep -m1 "^$1	" "$work/paths" | cut -f2- || true)"
  printf '%s' "${p:-(unreachable — no path; still in the object database)}"
}

echo "== history (every blob in the object database) =="
history_hits=0
while read -r sha; do
  [ -z "$sha" ] && continue
  # `grep -c`, never `grep -q`. Under `pipefail`, a quitting grep kills `git cat-file`
  # with SIGPIPE, the pipeline reports 141, and a MATCH is read as a miss — a silent
  # false negative that only appears once a blob is bigger than the pipe buffer. In a
  # privacy scan that is the one failure that must not exist. [LAW:no-silent-failure]
  if [ "$(git cat-file blob "$sha" 2>/dev/null | grep -cI -i -w -E "$pattern" || true)" != "0" ]; then
    echo "  $sha  $(blob_path "$sha")"
    history_hits=$((history_hits + 1))
  fi
done < "$work/blobs"

if [ "$history_hits" -gt 0 ]; then
  echo "FAIL: $history_hits historical blob(s) contain identifiers. History rewrite required."
  failed=1
else
  echo "clean"
fi
echo

# --- 3. Binaries, which no grep can clear -----------------------------------
#
# A screenshot of a terminal contains paths, prompts and project names as PIXELS. Every
# text scan above passes over it in silence. The only honest thing this script can do
# is refuse to call the repo clean while an unreviewed binary is in it.

echo "== binaries (grep cannot read these) =="
binaries=""
while read -r f; do
  [ -z "$f" ] && continue
  case "$(file --mime "$f" 2>/dev/null)" in
    *charset=binary*) binaries="${binaries}${f}"$'\n' ;;
  esac
done < <(git ls-files)

# `grep -I` treats a blob containing a NUL byte as binary — the same rule git itself
# uses, so this agrees with what `git grep` silently skipped above rather than applying
# a second, different definition of "binary". [LAW:single-enforcer]
hist_binaries=0
while read -r sha; do
  [ -z "$sha" ] && continue
  # A binary blob yields zero countable lines under `-I`; so does an empty one, which
  # is why size is consulted rather than trusting the line count alone.
  size="$(git cat-file -s "$sha" 2>/dev/null || echo 0)"
  lines="$(git cat-file blob "$sha" 2>/dev/null | grep -cI '' || true)"
  if [ "$size" -gt 0 ] && [ "${lines:-0}" -eq 0 ]; then
    echo "  in history: $sha  $(blob_path "$sha")"
    hist_binaries=$((hist_binaries + 1))
  fi
done < "$work/blobs"

if [ -n "$binaries" ] || [ "$hist_binaries" -gt 0 ]; then
  printf '%s' "$binaries" | sed 's/^/  in tree: /'
  echo "FAIL: binary content present. OPEN EACH ONE AND LOOK AT IT — confirm no real path,"
  echo "      prompt, project name or command is visible — then record that you did."
  failed=1
else
  echo "clean"
fi
echo

if [ "$failed" -ne 0 ]; then
  echo "PRIVACY SCAN FAILED"
  exit 1
fi
echo "PRIVACY SCAN CLEAN"
