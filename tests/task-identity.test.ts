import test from 'node:test';
import assert from 'node:assert/strict';
import type { CanvasSource } from '../lib/domain.ts';
import { canvasTaskIdentity, canvasTaskReference } from '../lib/kernel/task-identity.ts';

const source=(sourceType:string,sourceId:string,other:Partial<CanvasSource>={}):CanvasSource=>({
  id:`7:${sourceType}:${sourceId}`,courseId:'7',sourceType,sourceId,title:'Same title',body:'',
  sourceUrl:null,updatedAt:null,dueAt:null,unlockAt:null,lockAt:null,...other,
});

test('typed planner reference and assignment share one identity regardless of URL',()=>{
  const assignment=source('assignment','42',{sourceUrl:'https://canvas.example/courses/7/assignments/42'});
  const planner=source('planner','900',{plannableType:'assignment',plannableId:'42'});
  assert.equal(canvasTaskIdentity(planner,0),canvasTaskIdentity(assignment,0));
  assert.deepEqual(canvasTaskReference(planner),{type:'assignment',id:'42'});
});

test('equal numeric IDs in different Canvas types and courses stay separate',()=>{
  const assignment=source('assignment','42');
  assert.notEqual(canvasTaskIdentity(assignment,0),canvasTaskIdentity(source('quiz','42'),0));
  assert.notEqual(canvasTaskIdentity(assignment,0),canvasTaskIdentity(source('assignment','42',{courseId:'8'}),0));
  assert.notEqual(canvasTaskIdentity(assignment,0),canvasTaskIdentity(source('planner','42'),0));
});

test('untyped or unsupported planner references remain separate despite URL shape',()=>{
  const external=source('planner','900',{
    sourceUrl:'https://external.example/courses/7/assignments/42'});
  assert.equal(canvasTaskReference(external),null);
  assert.notEqual(canvasTaskIdentity(external,0),canvasTaskIdentity(source('assignment','42'),0));
  assert.equal(canvasTaskReference(source('planner','900',{
    sourceUrl:'https://canvas.example/courses/7/assignments/42'})),null);
  assert.equal(canvasTaskReference(source('planner','900',{
    plannableType:'file',plannableId:'42'})),null);
});
