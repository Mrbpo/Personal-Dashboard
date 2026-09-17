import {readFileSync} from 'node:fs';
// Deployment gate: schema initialization may only add tables/columns/indexes, never remove data.
const source=['lib/database.ts','scripts/migrate.ts'].map(p=>readFileSync(p,'utf8')).join('\n');
if(/\b(?:DROP\s+(?:TABLE|COLUMN|INDEX)|TRUNCATE\s|DELETE\s+FROM|UPDATE\s+\w+\s+SET|REPLACE\s+INTO|ALTER\s+TABLE[^;`]+(?:RENAME|DROP))\b/i.test(source))throw new Error('Destructive schema or data migration requires a separate manual migration');
console.log('Additive schema check passed');
