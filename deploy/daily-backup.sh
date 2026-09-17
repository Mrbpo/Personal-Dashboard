#!/usr/bin/env bash
set -euo pipefail
exec 9>/srv/study/deploy.lock
flock -w 1800 9
export APP_VERSION
APP_VERSION=$(cat /srv/study/current-version)
[[ "$APP_VERSION" =~ ^[a-f0-9]{40}$ ]]
compose=(docker compose -f /srv/study/compose.yml)
# Stop writers for a consistent SQLite and attachment snapshot; always restore services.
trap '"${compose[@]}" up -d web worker' EXIT
"${compose[@]}" stop worker web
bash /srv/study/backup.sh
"${compose[@]}" up -d web worker
trap - EXIT
bash /srv/study/verify-backup.sh
