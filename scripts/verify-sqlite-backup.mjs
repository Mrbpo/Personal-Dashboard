import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';

// Opening this isolated extraction writable lets SQLite recover a hot journal.
const db = new DatabaseSync('/restore/course-radar-v2.db');
try {
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') process.exitCode = 1;
  if (process.exitCode !== 1) {
    for (const row of db.prepare('SELECT hash FROM library_documents WHERE deleted=0').all()) {
      if (!existsSync(`/restore/library/${row.hash}`)) {
        process.exitCode = 2;
        break;
      }
    }
  }
} finally {
  db.close();
}
