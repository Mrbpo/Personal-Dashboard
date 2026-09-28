#!/usr/bin/env bash
set -euo pipefail

image="${1:?Pass the built image tag}"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
phase=fixture
trap 'status=$?; echo "SQLite backup smoke failed in $phase (exit $status)" >&2' ERR
mkdir -p "$temporary/data/library"
printf 'backup fixture' > "$temporary/data/library/fixture-blob"

# Kill an uncommitted writer to leave the same hot rollback journal shape seen
# in the v1 archive. Only this disposable directory is mounted in the tests.
if docker run --rm --network none --user 0 --read-only --cap-drop ALL \
  -v "$temporary/data:/restore:rw" "$image" node --input-type=module -e '
    import {DatabaseSync} from "node:sqlite";
    const db=new DatabaseSync("/restore/course-radar-v2.db");
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=1; CREATE TABLE library_documents(hash TEXT, deleted INTEGER, payload TEXT)");
    db.prepare("INSERT INTO library_documents VALUES (?,?,?)").run("fixture-blob",0,"");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE library_documents SET deleted=1,payload=?").run("x".repeat(1000000));
    process.kill(process.pid,"SIGKILL");
  ' >/dev/null 2>&1; then
  echo 'Expected the fixture writer to terminate with an open transaction' >&2
  exit 1
fi
phase=hot-journal
if ! test -s "$temporary/data/course-radar-v2.db-journal"; then
  echo 'Fixture did not leave a rollback journal' >&2
  exit 1
fi
echo 'SQLite hot rollback journal fixture created'

# The old read-only SQLite open cannot recover the hot journal even on :rw.
phase=readonly-open
if docker run --rm --network none --user 0 --read-only --cap-drop ALL \
  -v "$temporary/data:/restore:rw" "$image" node --input-type=module -e '
    import {DatabaseSync} from "node:sqlite";
    const db=new DatabaseSync("/restore/course-radar-v2.db",{readOnly:true});
    db.prepare("PRAGMA integrity_check").get();
  ' >/dev/null 2>&1; then
  echo 'Expected readOnly SQLite to reject hot-journal recovery' >&2
  exit 1
fi

# A read-only bind also blocks recovery; the disposable extraction must be rw.
phase=readonly-bind
if docker run --rm --network none --user 0 --read-only --cap-drop ALL \
  -v "$temporary/data:/restore:ro" "$image" node scripts/verify-sqlite-backup.mjs >/dev/null 2>&1; then
  echo 'Expected the read-only bind to reject hot-journal recovery' >&2
  exit 1
fi

phase=writable-recovery
docker run --rm --network none --user 0 --read-only --cap-drop ALL \
  -v "$temporary/data:/restore:rw" "$image" node scripts/verify-sqlite-backup.mjs
phase=journal-cleanup
if test -s "$temporary/data/course-radar-v2.db-journal"; then
  echo 'Recovered rollback journal is still active' >&2
  exit 1
fi
echo 'SQLite recovery smoke passed on isolated writable extraction'
