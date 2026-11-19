#!/usr/bin/env bash
# Record a deploy snapshot on the ghost-state branch.
#   scripts/save-state.sh <state.json> "<commit message>"
# The branch holds one file, state.json, and is only written by CI.
set -euo pipefail

file=$1
message=$2
branch=ghost-state

export GIT_AUTHOR_NAME="github-actions[bot]"
export GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

blob=$(git hash-object -w "$file")
tree=$(printf '100644 blob %s\tstate.json\n' "$blob" | git mktree)

parent_args=()
if git fetch --quiet origin "$branch" 2>/dev/null; then
  parent=$(git rev-parse FETCH_HEAD)
  if [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then
    echo "State unchanged; nothing to record."
    exit 0
  fi
  parent_args=(-p "$parent")
fi

commit=$(git commit-tree "$tree" "${parent_args[@]}" -m "$message")
git push origin "$commit:refs/heads/$branch"
echo "Recorded state as $commit on $branch."
