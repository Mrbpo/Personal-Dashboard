import {test} from 'node:test';
import assert from 'node:assert/strict';
import {visualTileCropBox,visualTileRotation,VISUAL_CROP_VIEWS} from '../lib/pdf-visual-tiles.ts';

test('visual crop inverse handles each orthogonal angle and a nonzero CropBox origin',()=>{
 const box={x:-30,y:70,width:400,height:600},region={left:.1,bottom:.2,width:.3,height:.4};
 const expected=[
  {x:10,y:190,width:120,height:240},
  {x:130,y:130,width:160,height:180},
  {x:210,y:310,width:120,height:240},
  {x:50,y:430,width:160,height:180},
 ];
 for(const [index,angle] of [0,90,180,270].entries()){
  const actual=visualTileCropBox(box,angle,region);
  for(const key of ['x','y','width','height'] as const)assert.ok(Math.abs(actual[key]-expected[index][key])<1e-10,`${angle} ${key}`);
 }
 assert.equal(visualTileRotation(-90),270);assert.equal(visualTileRotation(450),90);
 assert.deepEqual(visualTileCropBox(box,360,VISUAL_CROP_VIEWS[0]),visualTileCropBox(box,0,VISUAL_CROP_VIEWS[0]));
 for(const angle of [45,-45,90.1,NaN,Infinity])assert.throws(()=>visualTileRotation(angle),/仅支持/);
 assert.throws(()=>visualTileCropBox({...box,width:0},0,region),/CropBox 无效/);
});
