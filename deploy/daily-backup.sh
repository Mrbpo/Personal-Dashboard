#!/usr/bin/env bash
set -euo pipefail
exec 9>/srv/study/deploy.lock
flock -w 1800 9
export APP_VERSION
APP_VERSION=$(cat /srv/study/current-version)
[[ "$APP_VERSION" =~ ^[a-f0-9]{40}$ ]]
compose=(docker compose -f /srv/study/compose.yml)
# Stop writers for a consistent SQLite and attachment snapshot; always restore services.
restart_needed=1
writers_stopped=0
clear_primary_lease() {
  "${compose[@]}" run --rm web node --experimental-strip-types scripts/clear-worker-primary-lease.ts
}
resume_on_exit() {
  local status=$?
  trap - EXIT
  if (( restart_needed )); then
    # The delete is safe to retry only while both original writers remain stopped.
    if (( writers_stopped )); then
      clear_primary_lease || echo 'Could not clear worker-primary lease before recovery restart' >&2
    fi
    "${compose[@]}" up -d web worker || echo 'Could not restart web and worker after backup failure' >&2
  fi
  exit "$status"
}
trap resume_on_exit EXIT
"${compose[@]}" stop worker web
running_services=$("${compose[@]}" ps --status running --services)
if grep -Eq '^(worker|web)$' <<<"$running_services"; then
  echo 'Refusing to clear worker-primary lease while a writer is still running' >&2
  exit 1
fi
writers_stopped=1
clear_primary_lease
bash /srv/study/backup.sh
writers_stopped=0
"${compose[@]}" up -d web worker
restart_needed=0
trap - EXIT
bash /srv/study/verify-backup.sh
