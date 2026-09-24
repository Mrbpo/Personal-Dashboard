import test from 'node:test';
import assert from 'node:assert/strict';
import {hitSketchStroke,hitSketchTrail,eraserDisplayRadius,type SketchStroke} from '../lib/sketch-ink.ts';
import {isPenEraser} from '../lib/pdf-input.ts';

const stroke=(id:string,points:SketchStroke['points'],shape?:SketchStroke['shape']):SketchStroke=>({id,color:'#123456',width:0.003,points,...(shape?{shape}:{})});

test('eraser selects complete pen strokes across a drag, including a point',()=>{
  const first=stroke('a',[{x:.1,y:.2},{x:.5,y:.2}]);
  const second=stroke('b',[{x:.5,y:.4}]);
  const third=stroke('c',[{x:.9,y:.8},{x:.95,y:.9}]);
  assert.deepEqual([...hitSketchTrail([first,second,third],{x:.3,y:.2},{x:.5,y:.4})].sort(),['a','b']);
});

test('line, circle and rectangle hit only their outlines',()=>{
  assert.equal(hitSketchStroke(stroke('line',[{x:.1,y:.1},{x:.9,y:.9}],'line'),{x:.5,y:.5}),true);
  assert.equal(hitSketchStroke(stroke('circle',[{x:.5,y:.5},{x:.7,y:.5}],'circle'),{x:.7,y:.5}),true);
  assert.equal(hitSketchStroke(stroke('circle',[{x:.5,y:.5},{x:.7,y:.5}],'circle'),{x:.5,y:.5}),false);
  assert.equal(hitSketchStroke(stroke('rect',[{x:.2,y:.2},{x:.8,y:.8}],'rectangle'),{x:.8,y:.5}),true);
  assert.equal(hitSketchStroke(stroke('rect',[{x:.2,y:.2},{x:.8,y:.8}],'rectangle'),{x:.5,y:.5}),false);
});

test('stylus tail selects the eraser and its preview scales with the displayed canvas',()=>{
  assert.equal(isPenEraser({pointerType:'pen',button:5,buttons:0}),true);
  assert.equal(isPenEraser({pointerType:'pen',button:0,buttons:32}),true);
  assert.equal(eraserDisplayRadius(1000),14);
  assert.equal(eraserDisplayRadius(500),7);
});
