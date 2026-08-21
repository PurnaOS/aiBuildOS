#!/bin/sh
# The record's hard rules as enforcement (RQ-0049): a Claude Code PreToolUse hook that denies an
# edit breaking AGENTS.md before it happens. Exit 2 denies the tool call and hands stderr back to
# the agent as the reason; exit 0 allows. This file is inert data until the person accepts it in
# Claude Code's own trust flow — nothing here activates it silently.
#
# Dependency-free on purpose — POSIX sh, grep and sed — because a scaffolded project can assume
# nothing else. ponytail: regex-based JSON field extraction misreads a payload whose string
# content embeds other keys, and cannot see a replace-all edit that rewrites a state value
# without quoting the whole line; the upgrade path for both is jq, the day the template may
# assume it.

payload=$(cat)

# The last "<key>":"<value>" pair in the payload, still JSON-escaped. A JSON string cannot hold
# a raw newline, so line-oriented sed sees every value whole; escaped quotes stay in the match.
field() {
  printf '%s\n' "$payload" |
    sed -En 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"((\\.|[^"\\])*)".*/\1/p' |
    head -n 1
}

# The `state:` lines of a still-escaped JSON string: unescape (\n and friends), keep only what
# the state discipline is about.
state_lines() {
  printf '%b\n' "$1" | grep '^state:'
}

tool=$(field tool_name)
path=$(field file_path)

# No file path means no rule to apply. Failing open matters: failing closed would block every
# tool call this parser does not understand.
[ -n "$path" ] || exit 0

# AGENTS.md "Conventions": the record's schema — docs/profile/ and docs/guidelines/ — is not an
# agent's to edit.
case "$path" in
*/docs/profile/* | docs/profile/* | */docs/guidelines/* | docs/guidelines/*)
  echo "guard-record: $path is protected record schema (docs/profile, docs/guidelines) — see AGENTS.md." >&2
  exit 2
  ;;
esac

# AGENTS.md "State discipline": never change a `state:` field — the application walks the
# states. Only record markdown is in scope; everything else is allowed as-is.
case "$path" in
*/docs/*.md | docs/*.md) ;;
*) exit 0 ;;
esac

case "$tool" in
Edit)
  old=$(state_lines "$(field old_string)")
  new=$(state_lines "$(field new_string)")
  ;;
Write)
  # Writing a file that does not exist yet is minting a new artifact — `state: draft` and all —
  # which is legitimate agent work (PB-0001). Only rewriting an existing file can change a state.
  [ -f "$path" ] || exit 0
  old=$(grep '^state:' "$path")
  new=$(state_lines "$(field content)")
  ;;
MultiEdit)
  # ponytail: MultiEdit carries an array of edits this parser cannot pair up, so any mention of
  # a state line denies coarsely — the agent can fall back to single Edits. Upgrade path is jq.
  if printf '%s' "$payload" | grep -q -e '\\nstate:' -e '"state:'; then
    echo "guard-record: a MultiEdit touching a \`state:\` line in $path is denied — the application walks the states, not the agent (AGENTS.md, State discipline)." >&2
    exit 2
  fi
  exit 0
  ;;
*)
  exit 0
  ;;
esac

if [ "$old" != "$new" ]; then
  echo "guard-record: this edit changes a \`state:\` line in $path — the application walks the states, not the agent (AGENTS.md, State discipline)." >&2
  exit 2
fi

exit 0
