#!/usr/bin/env bash
set -euo pipefail

image="${1:?Pass the built image tag}"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
phase=fixture
trap 'status=$?; echo "SQLite backup smoke failed in $phase (exit $status)" >&2' ERR
mkdir -p "$temporary/data/library"
printf 'backup fixture' > "$temporary/data/library/fixture-blob"

# Exit a host SQLite writer without closing its uncommitted transaction. A
# small cache forces journal sync, producing a genuinely hot rollback journal.
python3 - "$temporary/data/course-radar-v2.db" <<'PY'
import os
import sqlite3
import sys

db = sqlite3.connect(sys.argv[1])
db.execute('PRAGMA journal_mode=DELETE')
db.execute('PRAGMA synchronous=FULL')
db.execute('PRAGMA cache_size=1')
db.execute('CREATE TABLE library_documents(hash TEXT, deleted INTEGER, payload TEXT)')
db.execute('INSERT INTO library_documents VALUES (?,?,?)', ('fixture-blob', 0, ''))
db.commit()
db.execute('BEGIN IMMEDIATE')
db.execute('UPDATE library_documents SET deleted=1,payload=?', ('x' * 1_000_000,))
os._exit(0)
PY
phase=hot-journal
if ! test -s "$temporary/data/course-radar-v2.db-journal"; then
  echo 'Fixture did not leave a rollback journal' >&2
  exit 1
fi
test "$(od -An -tx1 -N8 "$temporary/data/course-radar-v2.db-journal" | tr -d '[:space:]')" = d9d505f920a163d7
# The CI runner owns mktemp; container UID 0 has all capabilities dropped.
# Make only this synthetic mounted copy writable to model root-owned extracts.
chmod 0777 "$temporary/data"
chmod 0666 "$temporary/data/course-radar-v2.db" "$temporary/data/course-radar-v2.db-journal"
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
