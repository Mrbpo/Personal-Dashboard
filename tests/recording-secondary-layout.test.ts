import test from 'node:test';
import assert from 'node:assert/strict';
import {secondaryLayout,secondaryRect,secondaryLayoutFromPixels,defaultSecondaryLayout} from '../lib/recording-secondary-layout.ts';
test('camera geometry remains 16:9 inside narrow, normal and caption-excluding areas',()=>{
 for(const area of [{width:320,height:116},{width:1280,height:656},{width:1707,height:790}]){
  for(const layout of [defaultSecondaryLayout,{x:-100,y:100,width:2},{x:0.2,y:0.4,width:0.4}]){
   const rect=secondaryRect(secondaryLayout(layout),area);
   assert.ok(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=area.width+0.001&&rect.y+rect.height<=area.height+0.001);
   assert.ok(Math.abs(rect.width/rect.height-16/9)<0.0001);
   const resized=secondaryRect(secondaryLayoutFromPixels(-200,100000,100000,area),area);
   assert.ok(resized.x>=0&&resized.y+resized.height<=area.height+0.001);
  }
 }
 assert.deepEqual(secondaryLayout({x:NaN,y:0,width:0.25}),defaultSecondaryLayout);
 assert.deepEqual(secondaryLayout('not-json'),defaultSecondaryLayout);
});
