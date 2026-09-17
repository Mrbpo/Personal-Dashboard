import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgenda, zonedTime } from '../lib/study-agenda.ts';
import type { LearningTask } from '../lib/domain.ts';
const task = { id:'p',updatedAt:'v1', courseId:'c', sourceId:'s',sourceType:'assignment',courseCode:'CHMA10', localStatus:'active',canvasStatus:'upcoming',requirements:['整理要求','完成初稿'], estimatedMinutes:160, action:'准备项目', dueAt:'2026-09-18T23:00:00Z',priorityScore:10 } as LearningTask;
test('agenda splits across days, avoids events and preserves step order', () => {
  const result = buildAgenda([task], [{title:'class',startAt:'2026-09-14T23:00:00Z',endAt:'2026-09-15T00:00:00Z'}], {start:'19:00',end:'22:00',minutes:80,confirmed:true}, 'America/Toronto',[],Date.parse('2026-09-14T12:00:00Z'));
  assert.equal(result.blocks.length,4);
  assert.equal(new Set(result.blocks.map(b => b.date)).size,2);
  assert.ok(result.blocks[0].start >= '2026-09-15T00:00:00.000Z');
  assert.deepEqual(result.blocks.map(b => b.action), ['整理要求','整理要求','完成初稿','完成初稿']);
  assert.equal(zonedTime('2026-12-01','19:00','America/Toronto'),Date.parse('2026-12-02T00:00:00Z'));
});
test('deadline overflow is reported; completion does not mark Canvas completed', () => {
  const prefs = {start:'19:00',end:'20:00',minutes:40,confirmed:true};
  const now=Date.parse('2026-09-14T12:00:00Z');
  const result=buildAgenda([{...task,dueAt:'2026-09-15T00:00:00Z'}],[],prefs,'America/Toronto',[],now);
  assert.equal(result.blocks.length,1); assert.ok(result.warnings.length);
  const next=buildAgenda([task],[],prefs,'America/Toronto',[result.blocks[0].id],now);
  assert.ok(!next.blocks.some(b=>b.id===result.blocks[0].id));
  assert.equal(task.localStatus,'active');
});
