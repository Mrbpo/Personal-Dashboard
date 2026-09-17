#!/usr/bin/env bash
set -euo pipefail
# Root-owned forced command. authorized_keys must restrict forwarding, PTY and agent forwarding.
if [[ ! "${SSH_ORIGINAL_COMMAND:-}" =~ ^deploy\ ([a-f0-9]{40})$ ]]; then exit 64; fi
sha="${BASH_REMATCH[1]}"
exec 9>/srv/study/deploy.lock
flock -n 9 || exit 75
test -s /srv/study/runtime.env
test -s /srv/study/backup.recipient
test -n "$(find /srv/study/assets -maxdepth 1 -name '*.png' -print -quit)"
install -d -m 755 /srv/study/status
imagefile=$(mktemp /srv/study/image.XXXXXX)
trap 'rm -f -- "$imagefile"' EXIT
# Input is only a Docker image, never shell commands; cap incoming bytes at 2 GiB.
head -c 2147483649 > "$imagefile"
test "$(stat -c %s "$imagefile")" -lt 2147483649
gzip -dc "$imagefile" | docker load >/dev/null
test "$(docker image inspect "study-cabinet:$sha" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$sha"
previous=''
if test -f /srv/study/current-version; then previous=$(cat /srv/study/current-version); fi
export APP_VERSION="$sha"
compose=(docker compose -f /srv/study/compose.yml)
printf '{"version":"%s","status":"deploying"}\n' "$sha" > /srv/study/status/current.json
rollback() {
  "${compose[@]}" stop worker web || true
  if [[ "$previous" =~ ^[a-f0-9]{40}$ ]]; then APP_VERSION="$previous" "${compose[@]}" up -d web worker proxy; fi
  printf '{"version":"%s","previous":"%s","status":"failed"}\n' "$sha" "$previous" > /srv/study/status/current.json
}
trap 'rollback' ERR
if test -n "$previous"; then APP_VERSION="$previous" "${compose[@]}" stop worker web; fi
bash /srv/study/backup.sh
"${compose[@]}" run --rm web node --experimental-strip-types scripts/migrate.ts
started=$(date +%s%3N)
"${compose[@]}" up -d web worker proxy
healthy=0
for n in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/api/health/live >/dev/null && "${compose[@]}" exec -T worker node --experimental-strip-types --input-type=module -e "import {database} from './lib/database.ts'; const r=await database.prepare(\"SELECT heartbeat FROM worker_state WHERE id='primary'\").first();const s=await database.prepare('SELECT MAX(version) AS v FROM schema_releases').first();process.exit(r && r.heartbeat>$started && Date.now()-r.heartbeat<15000 && s.v===1?0:1);"; then healthy=1; break; fi
  sleep 2
done
test "$healthy" = 1
printf '%s' "$sha" > /srv/study/current-version
printf '{"version":"%s","previous":"%s","status":"complete","at":"%s"}\n' "$sha" "$previous" "$(date -u +%FT%TZ)" > /srv/study/status/current.json
trap - ERR
