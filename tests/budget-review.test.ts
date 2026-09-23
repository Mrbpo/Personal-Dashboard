import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL=':memory:';
process.env.AI_MONTHLY_BUDGET='1';
const {reserveBudget,budgetStatus}=await import('../lib/ai-budget.ts');
const {database:db}=await import('../lib/database.ts');
const {confirmReview}=await import('../lib/review-schedule.ts');
test('concurrent requests reserve funds atomically without overspending the monthly cap',async()=>{
 const results=await Promise.allSettled([reserveBudget(.6,'test'),reserveBudget(.6,'test')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await budgetStatus()).used,.6);
 await assert.rejects(reserveBudget(Number.NaN,'test'));await assert.rejects(reserveBudget(-1,'test'));
});
test('PDF formula requests stop at a separate UTC daily count',async()=>{
 const results=await Promise.allSettled([reserveBudget(.001,'pdf-formula',2),reserveBudget(.001,'pdf-formula',2),reserveBudget(.001,'pdf-formula',2)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM ai_ledger WHERE kind='pdf-formula'").first<{n:number}>())?.n,2);
});
test('review confirmation verifies source ownership and does not overwrite conflicting schedules',async()=>{
 await db.prepare("INSERT INTO tutor_threads VALUES ('t','alice','','Test','now','now')").run();
 await db.prepare("INSERT INTO tutor_messages VALUES ('m','t','assistant','Review evidence','[]','{}',0,'now')").run();
 const input={source:'tutor',id:'m',title:'Review concentration',start:'2026-09-20T12:00:00Z',minutes:30};
 await assert.rejects(confirmReview('bob',input));
 const first=await confirmReview('alice',input);assert.equal((await confirmReview('alice',input)).id,first.id);
 await assert.rejects(confirmReview('alice',{...input,title:'Other',start:'2026-09-20T12:15:00Z'}),/重叠/);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM schedule_events').first<{n:number}>())?.n,1);
});
