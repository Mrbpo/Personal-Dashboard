import {database} from '../lib/database.ts';
await database.prepare('SELECT 1').first();
await database.prepare('CREATE TABLE IF NOT EXISTS schema_releases (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)').run();
await database.prepare('INSERT OR IGNORE INTO schema_releases VALUES (1,?)').bind(new Date().toISOString()).run();
console.log('Additive schema v1 ready');
