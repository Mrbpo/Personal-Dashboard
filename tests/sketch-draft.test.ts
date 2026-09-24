import test from 'node:test';
import assert from 'node:assert/strict';
import { createSketchDraftSaver, reconcileSketchDraft } from '../lib/sketch-draft.ts';

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

test('stale refreshes preserve edits and acknowledgements across draft writes',async()=>{
  type State={book:{id:string;draft_text:string}};
  let state:State={book:{id:'book',draft_text:''}},current='A',revision=1;
  const writes:string[]=[];
  let releaseA=()=>{},releaseB=()=>{},startedA=()=>{},startedB=()=>{};
  const pendingA=new Promise<void>(resolve=>{releaseA=resolve;});
  const pendingB=new Promise<void>(resolve=>{releaseB=resolve;});
  const aStarted=new Promise<void>(resolve=>{startedA=resolve;});
  const bStarted=new Promise<void>(resolve=>{startedB=resolve;});
  const flush=createSketchDraftSaver(
    ()=>({bookId:state.book.id,status:'active',current,saved:state.book.draft_text}),
    async(_bookId,text)=>{writes.push(text);if(text==='A'){startedA();await pendingA;}else if(text==='B'){startedB();await pendingB;}},
    (_bookId,text)=>{revision++;state={book:{...state.book,draft_text:text}};},
  );
  const apply=(next:State,revisionAtLoad:number)=>{const merged=reconcileSketchDraft(state,next,current,revisionAtLoad,revision);state=merged.snapshot;current=merged.draft;};
  const first=flush();await aStarted;
  current='B';revision++;
  apply({book:{id:'book',draft_text:'A'}},revision);
  assert.equal(current,'B');assert.equal(state.book.draft_text,'');
  releaseA();await bStarted;
  const revisionAtStaleLoad=revision;
  apply({book:{id:'book',draft_text:'A'}},revisionAtStaleLoad);
  assert.equal(current,'B');assert.equal(state.book.draft_text,'A');
  releaseB();await first;
  apply({book:{id:'book',draft_text:'A'}},revisionAtStaleLoad);
  assert.equal(current,'B');assert.equal(state.book.draft_text,'B');
  assert.deepEqual(writes,['A','B']);
  apply({book:{id:'other-book',draft_text:'C'}},revision);
  assert.equal(current,'C');assert.equal(state.book.id,'other-book');
});
