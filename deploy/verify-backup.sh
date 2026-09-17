#!/usr/bin/env bash
set -euo pipefail
umask 077
test -s /srv/study/backup.identity
latest=$(find /srv/study/backups -maxdepth 1 -name 'study-*.tar.age' -type f -printf '%f\n' | sort | tail -1)
[[ "$latest" =~ ^study-[0-9]{8}T[0-9]{6}Z\.tar\.age$ ]]
temporary=$(mktemp -d /srv/study/restore-check.XXXXXX)
# Only this explicitly created directory is removed, never the live data directory.
trap 'rm -rf -- "$temporary"' EXIT
age -d -i /srv/study/backup.identity "/srv/study/backups/$latest" | tar --no-same-owner -xf - -C "$temporary"
test -s "$temporary/data/course-radar-v2.db"
version=$(cat /srv/study/current-version)
[[ "$version" =~ ^[a-f0-9]{40}$ ]]
docker run --rm --network none --user 0 --read-only --cap-drop ALL \
  -v "$temporary/data:/restore:ro" "study-cabinet:$version" \
  node --input-type=module -e 'import {DatabaseSync} from "node:sqlite";const db=new DatabaseSync("/restore/course-radar-v2.db",{readOnly:true});const r=db.prepare("PRAGMA integrity_check").get();if(r.integrity_check!=="ok")process.exit(1);console.log("Backup decryption and SQLite integrity verified");'
printf '{"status":"verified","at":"%s"}\n' "$(date -u +%FT%TZ)" > /srv/study/status/backup.json
