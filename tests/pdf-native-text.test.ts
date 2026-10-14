import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativePdfTextIsComplete} from '../lib/kernel/docling.ts';

function prose(topic:string){
 return `The ${topic} example explains how a physical model is derived from observations and assumptions. `+
  `For ${topic}, the reader must identify the variables, justify the initial conditions, and interpret the resulting equation. `+
  `The ${topic} calculation then compares its prediction with measured data and discusses approximation errors and the limits of the model.`;
}

function page(topic:string,number:number){
 return `MIT course material 2026\n${prose(topic)}\nChapter notes - page ${number}`;
}

test('four-up pages containing only long repeated footer labels cannot qualify as native prose',()=>{
 const pages=Array.from({length:4},(_,index)=>Array.from({length:4},(_,slide)=>
  `AT Patera - Numerical Computation for Mechanical Engineers - Integration lecture - February 7, 2013 - slide ${index*4+slide+1}`
 ).join('\n'));
 assert.ok(pages.every(text=>text.length>300),'footer-only pages would pass the old length threshold');
 assert.equal(nativePdfTextIsComplete(pages,4),false);
});

test('distinct substantial page prose remains usable despite repeated headers and numbered footers',()=>{
 const pages=['inertia','oscillation','heat transfer','energy'].map((topic,index)=>page(topic,index+1));
 assert.equal(nativePdfTextIsComplete(pages,4),true);
});

test('native text requires all pages and accepts an empty page only with original blank verification',()=>{
 const pages=['interpolation','quadrature','linear algebra'].map((topic,index)=>page(topic,index+1));
 assert.equal(nativePdfTextIsComplete(null,4),false);
 assert.equal(nativePdfTextIsComplete(pages,4),false,'missing PDF page cannot be inferred blank');
 assert.equal(nativePdfTextIsComplete([pages[0],pages[1],'Short heading','Short heading'],4),false,'a few long pages cannot hide incomplete remaining pages');
 assert.equal(nativePdfTextIsComplete([...pages,''],4),false,'empty text is not proof of a blank original');
 assert.equal(nativePdfTextIsComplete([...pages,''],4,[3]),false,'blank verification must belong to the exact source page');
 assert.equal(nativePdfTextIsComplete([...pages,''],4,[4]),true);
 assert.equal(nativePdfTextIsComplete(pages,4,[4]),false,'blank verification cannot excuse a missing array entry');
});
