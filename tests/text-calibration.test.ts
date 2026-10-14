import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertCalibrationScope,readFrozenInput,sha256} from '../scripts/text-calibration-input.mjs';

test('text calibration refuses production/default schemas and altered frozen gold',()=>{
  assertCalibrationScope('postgresql://localhost/pdf_acceptance_20261006','text_calibration_case_1');
  assert.throws(()=>assertCalibrationScope('postgresql://localhost/study_kernel','text_calibration_case_1'),/never production/);
  assert.throws(()=>assertCalibrationScope('postgresql://localhost/pdf_acceptance_20261006','public'),/fresh explicit/);
  const root=mkdtempSync(join(tmpdir(),'frozen-text-'));
  try{
    const datasets=['content','syllabusqa','qasper','courseassist','mixed'];
    const cases=datasets.flatMap(dataset=>Array.from({length:50},(_,id)=>({dataset,id,expectedDocumentIds:['source'],expectedOriginalSources:['source']})));
    const truth=Array.from({length:50},(_,id)=>({question:`Original gold ${id}`}));
    const payloads={'cases.json':JSON.stringify(cases),'truth-cases.json':JSON.stringify(truth)};
    for(const [name,value] of Object.entries(payloads))writeFileSync(join(root,name),value);
    const manifest={schemaVersion:1,caseCounts:{truth:50,...Object.fromEntries(datasets.map(name=>[name,50]))},
      files:Object.entries(payloads).map(([path,value])=>({path,bytes:Buffer.byteLength(value),sha256:sha256(value)}))};
    writeFileSync(join(root,'manifest.json'),JSON.stringify(manifest));
    assert.equal(readFrozenInput(root).cases.length,250);
    writeFileSync(join(root,'truth-cases.json'),JSON.stringify(truth.slice(1)));
    assert.throws(()=>readFrozenInput(root),/checksum mismatch/);
    manifest.caseCounts.truth=49;writeFileSync(join(root,'manifest.json'),JSON.stringify(manifest));
    assert.throws(()=>readFrozenInput(root),/subset/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
