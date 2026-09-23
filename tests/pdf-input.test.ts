import test from 'node:test';
import assert from 'node:assert/strict';
import {annotationShortcut,isPenEraser} from '../lib/pdf-input.ts';

test('pen eraser detection accepts the eraser button and bitmask only for pen input',()=>{
  assert.equal(isPenEraser({pointerType:'pen',button:5,buttons:32}),true);
  assert.equal(isPenEraser({pointerType:'pen',button:-1,buttons:33}),true);
  assert.equal(isPenEraser({pointerType:'pen',button:0,buttons:1}),false);
  assert.equal(isPenEraser({pointerType:'mouse',button:5,buttons:32}),false);
});

test('annotation shortcuts handle common undo and redo keys without unmodified keys',()=>{
  const base={key:'z',ctrlKey:true,metaKey:false,shiftKey:false,altKey:false};
  assert.equal(annotationShortcut(base),'undo');
  assert.equal(annotationShortcut({...base,metaKey:true,ctrlKey:false}),'undo');
  assert.equal(annotationShortcut({...base,shiftKey:true}),'redo');
  assert.equal(annotationShortcut({...base,key:'y'}),'redo');
  assert.equal(annotationShortcut({...base,ctrlKey:false}),null);
  assert.equal(annotationShortcut({...base,altKey:true}),null);
});
