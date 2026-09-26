import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
const directory = mkdtempSync(join(tmpdir(), 'study-tests-'));
const postgres=process.env.KERNEL_DATABASE_URL?new Pool({connectionString:process.env.KERNEL_DATABASE_URL}):null;
try {
  const files=readdirSync('tests').filter(name=>name.endsWith('.test.ts')&&name!=='kernel-integration.test.ts');
  for(const [index,file] of files.entries()){
    const schema=`kernel_test_${process.pid}_${index}`;
    if(postgres)await postgres.query(`CREATE SCHEMA ${schema}`);
    const migration=postgres?spawnSync(process.execPath,['--experimental-strip-types','scripts/kernel-migrate.ts'],{
      stdio:'inherit',env:{...process.env,KERNEL_SCHEMA:schema,DATABASE_URL:':memory:'}}):null;
    const result=migration?.status ? migration : spawnSync(process.execPath,['--experimental-strip-types','--test',`tests/${file}`],{
      stdio:'inherit',env:{...process.env,KERNEL_SCHEMA:schema,DATABASE_URL:':memory:',SERVICE_VAULT_DIR:directory,
        LIBRARY_DIR:directory+'/library',CODEX_QUEUE_DIR:directory+'/codex-queue',AI_BUDGET_TEST_BYPASS:'true',CHATGPT_AUTO:'false'}});
    if(result.status!==0)process.exitCode=1;
    if(postgres)await postgres.query(`DROP SCHEMA ${schema} CASCADE`);
  }
} finally {
  await postgres?.end();
  // Only this test-created temporary directory is removed.
  rmSync(directory, { recursive: true, force: true });
}
