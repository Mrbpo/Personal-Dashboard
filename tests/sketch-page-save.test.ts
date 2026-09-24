import test from 'node:test';
import assert from 'node:assert/strict';
import { createSketchPageSaveScheduler } from '../lib/sketch-page-save.ts';

function fakeClock(){
  let time=0,nextId=0;
  const timers=new Map<number,{due:number;callback:()=>void}>();
  return {
    now:()=>time,
    setTimer:(callback:()=>void,delay:number)=>{const id=++nextId;timers.set(id,{due:time+delay,callback});return id as unknown as ReturnType<typeof setTimeout>;},
    clearTimer:(timer:ReturnType<typeof setTimeout>)=>{timers.delete(timer as unknown as number);},
    advance:(amount:number)=>{time+=amount;for(;;){const due=[...timers].find(([,timer])=>timer.due<=time);if(!due)break;timers.delete(due[0]);due[1].callback();}},
  };
}

test('consecutive strokes coalesce into one save, with a maximum wait',async()=>{
  const clock=fakeClock();let saves=0;
  const scheduler=createSketchPageSaveScheduler(async()=>{saves++;},{...clock,delayMs:900,maxWaitMs:5000});
  scheduler.schedule();
  for(let i=0;i<6;i++){clock.advance(800);scheduler.schedule();assert.equal(saves,0);}
  clock.advance(199);assert.equal(saves,0);
  clock.advance(1);assert.equal(saves,1);
  clock.advance(5000);assert.equal(saves,1);
});

test('switching pages flushes immediately and cancels the delayed save',async()=>{
  const clock=fakeClock();const writes:string[]=[];let drawing='first stroke';
  const scheduler=createSketchPageSaveScheduler(async()=>{writes.push(drawing);},{...clock,delayMs:900,maxWaitMs:5000});
  scheduler.schedule();clock.advance(200);scheduler.pause();
  drawing='two strokes';scheduler.schedule();
  await scheduler.flush();
  assert.deepEqual(writes,['two strokes']);
  clock.advance(5000);assert.deepEqual(writes,['two strokes']);
});

test('a failed forced save can be retried',async()=>{
  let calls=0;
  const scheduler=createSketchPageSaveScheduler(async()=>{if(++calls===1)throw new Error('conflict');});
  await assert.rejects(scheduler.flush(),/conflict/);
  await scheduler.flush();
  assert.equal(calls,2);
});
