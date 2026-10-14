import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function assertCalibrationScope(connection,schema){
  if(new URL(connection).pathname!=='/pdf_acceptance_20261006')throw new Error('Use the existing isolated acceptance database, never production');
  if(!/^text_calibration_[a-z0-9_]{1,40}$/u.test(schema||''))throw new Error('A fresh explicit text_calibration_ schema is required');
}
export function readFrozenInput(directory){
  const root=realpathSync(directory),bytes=readFileSync(resolve(root,'manifest.json')),manifest=JSON.parse(bytes);
  if(manifest.schemaVersion!==1||manifest.caseCounts?.truth!==50||
    ['content','syllabusqa','qasper','courseassist','mixed'].some(name=>manifest.caseCounts[name]!==50))
    throw new Error('Do not replace the full original gold with a subset');
  for(const file of manifest.files){
    const path=realpathSync(resolve(root,file.path)),rel=relative(root,path);
    if(isAbsolute(rel)||rel==='..'||rel.startsWith('../')||rel.startsWith('..\\'))throw new Error('Frozen path escapes its root');
    const value=readFileSync(path);
    if(value.length!==file.bytes||sha256(value)!==file.sha256)throw new Error(`Frozen checksum mismatch: ${file.path}`);
  }
  const cases=JSON.parse(readFileSync(resolve(root,'cases.json'),'utf8'));
  const truth=JSON.parse(readFileSync(resolve(root,'truth-cases.json'),'utf8'));
  if(cases.length!==250||truth.length!==50||new Set(truth.map(row=>row.question)).size!==50||
    ['content','syllabusqa','qasper','courseassist','mixed'].some(name=>cases.filter(row=>row.dataset===name).length!==50))
    throw new Error('Full original gold case count changed');
  if(cases.some(row=>!row.expectedDocumentIds?.length||!row.expectedOriginalSources?.length))throw new Error('Expected source identities are required');
  return {root,manifest,manifestSha256:sha256(bytes),cases,truth};
}
