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
# Keep the running release for rollback, but remove older application images
# before receiving another multi-gigabyte image. Persistent data and backups
# live under /srv/study and are never touched by this cleanup.
current=''
if test -f /srv/study/current-version; then current=$(cat /srv/study/current-version); fi
while IFS= read -r image; do
  if test -n "$image" && test "$image" != "study-cabinet:$current"; then docker image rm "$image" >/dev/null 2>&1 || true; fi
done < <(docker image ls study-cabinet --format '{{.Repository}}:{{.Tag}}')
docker image prune -f >/dev/null
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
cutover_started=0
rollback() {
  "${compose[@]}" stop worker web || true
  # The stopped worker can leave its short-lived primary lease behind when npm
  # receives SIGTERM before the Node child. No executor is running here, so the
  # lease is safe to clear before restoring the previous worker.
  "${compose[@]}" run --rm web node --experimental-strip-types --input-type=module -e "import {database} from './lib/database.ts'; await database.prepare(\"DELETE FROM service_leases WHERE id='worker-primary'\").run();" || true
  if test "$cutover_started" = 0 && [[ "$previous" =~ ^[a-f0-9]{40}$ ]]; then
    APP_VERSION="$previous" "${compose[@]}" up -d web worker proxy
    printf '{"version":"%s","previous":"%s","status":"failed_before_cutover"}\n' "$sha" "$previous" > /srv/study/status/current.json
  else
    # A v1 writer may have committed PostgreSQL changes. Never roll back to v0 automatically.
    printf '{"version":"%s","previous":"%s","status":"blocked_after_cutover"}\n' "$sha" "$previous" > /srv/study/status/current.json
  fi
}
trap 'rollback' ERR
"${compose[@]}" up -d postgres docling
"${compose[@]}" exec -T postgres pg_isready -U study_kernel -d study_kernel
"${compose[@]}" run --rm web node --experimental-strip-types scripts/kernel-migrate.ts
"${compose[@]}" run --rm web node -e "fetch('http://docling:5001/docs').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
printf '{"version":"%s","status":"services_deployed"}\n' "$sha" > /srv/study/status/current.json
if test -n "$previous"; then APP_VERSION="$previous" "${compose[@]}" stop worker web; fi
backup_key=$(bash /srv/study/backup.sh)
backup_name=${backup_key##*/}
[[ "$backup_name" =~ ^study-v1-[0-9]{8}T[0-9]{6}Z\.tar\.age$ ]]
bash /srv/study/verify-backup.sh "$backup_name"
bash /srv/study/verify-offsite-backup.sh "/srv/study/backups/$backup_name" "$backup_key"
"${compose[@]}" run --rm web node --experimental-strip-types scripts/migrate.ts
"${compose[@]}" run --rm web node --experimental-strip-types scripts/kernel-migrate.ts --import-legacy
# All old executors are stopped. Clear only the executor lease so the new
# worker can become primary immediately; job leases and progress are retained.
"${compose[@]}" run --rm web node --experimental-strip-types --input-type=module -e "import {database} from './lib/database.ts'; await database.prepare(\"DELETE FROM service_leases WHERE id='worker-primary'\").run();"
started=$(date +%s%3N)
# Docker may start a v1 writer before `up` returns. From this point, a failed
# command must preserve PostgreSQL writes rather than booting the v0 writer.
cutover_started=1
"${compose[@]}" up -d web worker proxy
healthy=0
for n in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/api/health/live >/dev/null && "${compose[@]}" exec -T worker node --experimental-strip-types --input-type=module -e "import {database} from './lib/database.ts';import {kernelPool} from './lib/kernel/db.ts';const r=await database.prepare(\"SELECT heartbeat FROM worker_state WHERE id='primary'\").first();const s=await database.prepare('SELECT MAX(version) AS v FROM schema_releases').first();const k=await kernelPool().query('SELECT MAX(version) AS v FROM kernel_migrations');process.exit(r && r.heartbeat>$started && Date.now()-r.heartbeat<15000 && s.v===1 && k.rows[0].v===1?0:1);" && "${compose[@]}" exec -T worker node -e "fetch('http://docling:5001/docs').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then healthy=1; break; fi
  sleep 2
done
test "$healthy" = 1
printf '%s' "$sha" > /srv/study/current-version
printf '{"version":"%s","previous":"%s","status":"production_switched","at":"%s"}\n' "$sha" "$previous" "$(date -u +%FT%TZ)" > /srv/study/status/current.json
trap - ERR
