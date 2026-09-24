import test from 'node:test';
import assert from 'node:assert/strict';
import { createSketchDraftSaver } from '../lib/sketch-draft.ts';

test('typing during a draft request sends the new text after the old request finishes',async()=>{
  let current='A',saved='';const writes:string[]=[];
  let signalStarted=()=>{};const started=new Promise<void>(resolve=>{signalStarted=resolve;});
  let releaseFirst=()=>{};const firstPending=new Promise<void>(resolve=>{releaseFirst=resolve;});
  const flush=createSketchDraftSaver(
    ()=>({bookId:'book',status:'active',current,saved}),
    async(_bookId,text)=>{writes.push(text);if(text==='A'){signalStarted();await firstPending;}},
    (_bookId,text)=>{saved=text;},
  );
  const first=flush();await started;
  current='B';const second=flush();
  releaseFirst();await Promise.all([first,second]);
  assert.deepEqual(writes,['A','B']);assert.equal(saved,'B');
});
