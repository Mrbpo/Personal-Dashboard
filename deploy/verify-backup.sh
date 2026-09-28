#!/usr/bin/env bash
set -euo pipefail
umask 077
test -s /srv/study/backup.identity
if test "$#" -gt 1; then exit 64; fi
latest=${1:-$(find /srv/study/backups -maxdepth 1 -name 'study-v1-*.tar.age' -type f -printf '%f\n' | sort | tail -1)}
[[ "$latest" =~ ^study-v1-[0-9]{8}T[0-9]{6}Z\.tar\.age$ ]]
temporary=$(mktemp -d /srv/study/restore-check.XXXXXX)
restore_db="kernel_restore_$(date -u +%s)_$$"
compose=(docker compose -f /srv/study/compose.yml)
cleanup(){
  "${compose[@]}" exec -T postgres dropdb -U study_kernel --if-exists "$restore_db" >/dev/null 2>&1 || true
  rm -rf -- "$temporary"
}
trap cleanup EXIT
age -d -i /srv/study/backup.identity "/srv/study/backups/$latest" | tar --no-same-owner -xf - -C "$temporary"
(cd "$temporary" && sha256sum -c manifest.sha256 >/dev/null)
test -s "$temporary/data/course-radar-v2.db"
version=${APP_VERSION:-$(cat /srv/study/current-version)}
[[ "$version" =~ ^[a-f0-9]{40}$ ]]
docker run --rm --network none --user 0 --read-only --cap-drop ALL \
  -v "$temporary/data:/restore:ro" "study-cabinet:$version" \
  node --input-type=module -e 'import {DatabaseSync} from "node:sqlite";import {existsSync} from "node:fs";const db=new DatabaseSync("/restore/course-radar-v2.db",{readOnly:true});if(db.prepare("PRAGMA integrity_check").get().integrity_check!=="ok")process.exit(1);for(const row of db.prepare("SELECT hash FROM library_documents WHERE deleted=0").all())if(!existsSync(`/restore/library/${row.hash}`))process.exit(2);'
"${compose[@]}" exec -T postgres createdb -U study_kernel "$restore_db"
"${compose[@]}" exec -T postgres pg_restore -U study_kernel -d "$restore_db" --no-owner --exit-on-error < "$temporary/kernel.dump"
test "$("${compose[@]}" exec -T postgres psql -U study_kernel -d "$restore_db" -Atc 'SELECT count(*) FROM kernel_migrations')" -ge 1
printf '{"status":"verified","at":"%s"}\n' "$(date -u +%FT%TZ)" > /srv/study/status/backup.json
