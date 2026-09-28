import { readFileSync, readdirSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { resolve } from 'node:path';

let pool: Pool | undefined;

export function kernelPool(): Pool {
  if (!pool) {
    const connectionString = process.env.KERNEL_DATABASE_URL;
    if (!connectionString) throw new Error('KERNEL_DATABASE_URL is required for v1 core data');
    const schema=process.env.KERNEL_SCHEMA;
    if(schema && !/^[a-z][a-z0-9_]{0,62}$/.test(schema))throw new Error('Invalid KERNEL_SCHEMA');
    pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, allowExitOnIdle:true,
      options:schema?`-c search_path=${schema}`:undefined });
  }
  return pool;
}

export async function kernelTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await kernelPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function migrateKernel(): Promise<void> {
  const directory=resolve(process.cwd(),'lib/kernel/migrations');
  const files=kernelMigrationFiles();
  await kernelTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(927441)');
    await client.query('CREATE TABLE IF NOT EXISTS kernel_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
    const applied=new Set((await client.query<{version:number}>('SELECT version FROM kernel_migrations')).rows.map(row=>row.version));
    for(const file of files){
      const version=Number(file.slice(0,3));
      if(applied.has(version))continue;
      await client.query(readFileSync(resolve(directory,file),'utf8'));
      await client.query('INSERT INTO kernel_migrations(version) VALUES ($1)',[version]);
    }
  });
}

function kernelMigrationFiles(): string[] {
  return readdirSync(resolve(process.cwd(),'lib/kernel/migrations'))
    .filter(name=>/^\d{3}_[a-z0-9_-]+\.sql$/.test(name)).sort();
}

export function expectedKernelMigrationVersion(): number {
  const latest=kernelMigrationFiles().at(-1);
  if(!latest)throw new Error('No kernel migrations found in the current image');
  return Number(latest.slice(0,3));
}
