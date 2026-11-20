#!/usr/bin/env bash
# Wait until every older run of the sync workflows has finished, so two jobs
# never change Ghost or the ghost-state branch at the same time.
#
# GitHub's own `concurrency` setting keeps only one waiting run per group and
# cancels the rest, which could silently drop a release deploy. Waiting here
# keeps them all, in the order they started.
set -euo pipefail

me=${GITHUB_RUN_ID:?}
for attempt in $(seq 1 240); do
  older=""
  for wf in deploy.yml revert.yml accept.yml pull.yml; do
    ids=$(gh run list --workflow "$wf" --limit 50 --json databaseId,status \
      --jq ".[] | select(.status != \"completed\" and .databaseId < $me) | .databaseId" 2>/dev/null || true)
    older="$older $ids"
  done
  older=$(echo $older)
  if [ -z "$older" ]; then
    exit 0
  fi
  [ "$attempt" = 1 ] && echo "Waiting for earlier sync run(s) to finish: $older"
  sleep 15
done
echo "::error::Gave up after an hour waiting for earlier sync runs ($older) to finish."
exit 1
