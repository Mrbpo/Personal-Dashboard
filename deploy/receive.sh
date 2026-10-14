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
# Input is the application and pinned PostgreSQL images, never shell commands.
# Keep the existing 2 GiB compressed transfer cap.
head -c 2147483649 > "$imagefile"
test "$(stat -c %s "$imagefile")" -lt 2147483649
gzip -dc "$imagefile" | docker load >/dev/null
test "$(docker image inspect "study-cabinet:$sha" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$sha"
docker image inspect study-postgres:18.6-pgvector0.8.7 >/dev/null
previous=''
if test -f /srv/study/current-version; then previous=$(cat /srv/study/current-version); fi
export APP_VERSION="$sha"
compose=(docker compose -f /srv/study/compose.yml)
printf '{"version":"%s","status":"deploying"}\n' "$sha" > /srv/study/status/current.json
recovery_required=0
rollback() {
  "${compose[@]}" stop worker web || true
  # The stopped worker can leave its short-lived primary lease behind when npm
  # receives SIGTERM before the Node child. No executor is running here, so the
  # lease is safe to clear before restoring the previous worker.
  "${compose[@]}" run --rm web node --experimental-strip-types --input-type=module -e "import {database} from './lib/database.ts'; await database.prepare(\"DELETE FROM service_leases WHERE id='worker-primary'\").run();" || true
  if test "$recovery_required" = 0 && [[ "$previous" =~ ^[a-f0-9]{40}$ ]]; then
    APP_VERSION="$previous" "${compose[@]}" up -d web worker proxy
    printf '{"version":"%s","previous":"%s","status":"failed_before_cutover"}\n' "$sha" "$previous" > /srv/study/status/current.json
  else
    # New schema or application writes may already be committed. Preserve them.
    printf '{"version":"%s","previous":"%s","status":"blocked_requires_recovery"}\n' "$sha" "$previous" > /srv/study/status/current.json
  fi
}
trap 'rollback' ERR
if test -z "$previous"; then
  # Initial installation has no running kernel to dump yet. Bootstrap it;
  # upgrades below snapshot the existing database before any new migration.
  "${compose[@]}" up -d postgres docling
  "${compose[@]}" exec -T postgres pg_isready -U study_kernel -d study_kernel
  "${compose[@]}" run --rm web node --experimental-strip-types scripts/kernel-migrate.ts
fi
if test -n "$previous"; then APP_VERSION="$previous" "${compose[@]}" stop worker web; fi
backup_key=$(bash /srv/study/backup.sh)
backup_name=${backup_key##*/}
[[ "$backup_name" =~ ^study-v1-[0-9]{8}T[0-9]{6}Z\.tar\.age$ ]]
bash /srv/study/verify-backup.sh "$backup_name"
bash /srv/study/verify-offsite-backup.sh "/srv/study/backups/$backup_name" "$backup_key"
# The one required pre-switch backup precedes PostgreSQL recreation and all
# new migrations. The same existing volume remains authoritative.
"${compose[@]}" up -d postgres docling
"${compose[@]}" exec -T postgres pg_isready -U study_kernel -d study_kernel
# New kernel migrations can commit before the application writer starts. The
# previous application's schema gate may reject that database, so any failure
# from this point must preserve it for recovery instead of booting old code.
recovery_required=1
"${compose[@]}" run --rm web node --experimental-strip-types scripts/kernel-migrate.ts
"${compose[@]}" run --rm web node -e "fetch('http://docling:5001/docs').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
printf '{"version":"%s","status":"services_deployed"}\n' "$sha" > /srv/study/status/current.json
"${compose[@]}" run --rm web node --experimental-strip-types scripts/migrate.ts
"${compose[@]}" run --rm web node --experimental-strip-types scripts/kernel-migrate.ts --import-legacy
# Stop before any cache import if this bounded owner batch needs pagination.
# Machine formula fidelity is not approved for automatic production enrichment.
"${compose[@]}" run --rm -T web node --input-type=module <<'JS'
import {createClient} from '@libsql/client';
if(process.env.DOCLING_FORMULA_ENRICHMENT!=='false'||(process.env.PDF_SCAN_TRANSCRIPTION_BACKEND||'docling')!=='docling')
  throw new Error('PDF cutover requires formula enrichment disabled and Docling scan backend');
const sqlite=createClient({url:process.env.DATABASE_URL||'file:./data/course-radar-v2.db',authToken:process.env.DATABASE_AUTH_TOKEN||undefined});
try{
  const count=Number((await sqlite.execute({sql:"SELECT count(*) n FROM library_documents WHERE owner_id=? AND deleted=0 AND mime='application/pdf'",args:['local-owner']})).rows[0].n);
  if(count>500)throw new Error('PDF cache cutover exceeds 500 documents; complete an explicit paginated migration before cutover');
}finally{sqlite.close();}
JS
cache_report="/app/data/private/pdf-cache-cutover-${sha}.json"
"${compose[@]}" run --rm web node --experimental-strip-types scripts/import-legacy-pdf-cache.ts \
  --owner local-owner --limit 500 --report "$cache_report" --apply
"${compose[@]}" run --rm -T web node --input-type=module - "$cache_report" <<'JS'
import {readFile} from 'node:fs/promises';
const report=JSON.parse(await readFile(process.argv[2],'utf8'));
const actions=report.actionCounts;
if(report.mode!=='apply'||report.scope.owner!=='local-owner'||report.scope.total>500||
   report.records.length!==report.scope.total||report.counts.error||actions.blocked||
   actions.imported+actions.protected+actions.alreadyImported+actions.queued!==report.scope.total)
  throw new Error('PDF cache cutover report is incomplete; preserve new database and resolve before starting writers');
console.log(JSON.stringify({action:'pdf-cache-cutover',total:report.scope.total,actionCounts:actions,
  note:'Queued documents remain processing; parser and vector work run after worker startup'}));
JS
# All old executors are stopped. Clear only the executor lease so the new
# worker can become primary immediately; job leases and progress are retained.
"${compose[@]}" run --rm web node --experimental-strip-types --input-type=module -e "import {database} from './lib/database.ts'; await database.prepare(\"DELETE FROM service_leases WHERE id='worker-primary'\").run();"
started=$(date +%s%3N)
# The migration boundary above already prevents automatic old-code rollback.
"${compose[@]}" up -d web worker proxy
healthy=0
for n in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/api/health/live >/dev/null && "${compose[@]}" exec -T worker node --experimental-strip-types --input-type=module -e "import {database} from './lib/database.ts';import {kernelPool,expectedKernelMigrationVersion} from './lib/kernel/db.ts';const r=await database.prepare(\"SELECT heartbeat FROM worker_state WHERE id='primary'\").first();const s=await database.prepare('SELECT MAX(version) AS v FROM schema_releases').first();const k=await kernelPool().query('SELECT MAX(version) AS v FROM kernel_migrations');process.exit(r && r.heartbeat>$started && Date.now()-r.heartbeat<15000 && s.v===1 && k.rows[0].v===expectedKernelMigrationVersion()?0:1);" && "${compose[@]}" exec -T worker node -e "fetch('http://docling:5001/docs').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then healthy=1; break; fi
  sleep 2
done
test "$healthy" = 1
printf '%s' "$sha" > /srv/study/current-version
printf '{"version":"%s","previous":"%s","status":"production_switched","at":"%s"}\n' "$sha" "$previous" "$(date -u +%FT%TZ)" > /srv/study/status/current.json
trap - ERR
