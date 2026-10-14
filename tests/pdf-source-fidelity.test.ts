import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {mkdtemp,writeFile,readFile,link,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {auditPdfSourceFidelity,stagePdfSourceFidelity,type PdfSourceMathEvidence} from '../lib/pdf-source-fidelity.ts';

async function fixture(){
 const pdf=await PDFDocument.create();pdf.addPage([100,100]);const original=await pdf.save();
 const evidence:PdfSourceMathEvidence={sourceSha256:createHash('sha256').update(original).digest('hex'),pageNumber:1,pageCount:1,
  pageSize:[100,100],extractor:'synthetic source geometry fixture',regions:[
   {number:'A',bbox:[1,1,80,30],vectorOrderVerified:true,glyphs:[
    {symbol:'q',subscript:'i',font:'fixture-bold',bold:true,bbox:[5,5,10,15]},
    {symbol:'q',subscript:'j',font:'fixture-bold',bold:true,bbox:[20,5,25,15]}]},
   {number:'B',bbox:[1,40,80,70],vectorOrderVerified:true,glyphs:[]}]};
 return {original,evidence};
}

test('source audit maps vectors within numbered regions and reports external math boundaries without editing',async()=>{
 const {original,evidence}=await fixture();
 const body='\\[q_i+q_j\\tag{A}\\]\n\\(r=0\\)\\tag{B}';
 const result=await auditPdfSourceFidelity(original,evidence,body);
 assert.equal(result.regions[0].vectorMappingUnique,true);
 assert.deepEqual(result.regions[0].mappings.map(mapping=>mapping.subscript),['i','j']);
 assert.ok(result.regions[0].reasons.includes('possible-vector-font-loss'));
 assert.deepEqual(result.outsideMath.map(token=>token.token),['\\tag{B}']);
 assert.ok(result.regions[1].reasons.includes('numbered-equation-is-inline'));
 assert.equal(result.derivedStaging,null);
 assert.equal(result.requiresReview,true);
 const staging=await stagePdfSourceFidelity(original,evidence,body+'\n\\{\\(u,v\\)\\}');
 assert.equal(staging.text,'\\[\\mathbf{q}_i+\\mathbf{q}_j\\tag{A}\\]\n\\[r=0\\tag{B}\\]\n\\(\\{u,v\\}\\)');
 assert.equal(staging.rawRecognitionSha256,createHash('sha256').update(body+'\n\\{\\(u,v\\)\\}').digest('hex'));
 assert.equal(staging.notForApplyPageRepair,true);
 assert.equal(staging.remainingBoundaryIssues.length,0);
 const after=await auditPdfSourceFidelity(original,evidence,staging.text);
 assert.equal(after.regions[0].vectorMappingUnique,true);
 const greek=structuredClone(evidence);greek.regions[0].glyphs.forEach(glyph=>{glyph.symbol='α';});
 const greekStaging=await stagePdfSourceFidelity(original,greek,body.replaceAll('q_','\\alpha_'));
 assert.ok(greekStaging.text.includes('\\boldsymbol{\\alpha}_i+\\boldsymbol{\\alpha}_j'));
 const reordered=await auditPdfSourceFidelity(original,evidence,body.replace('q_i+q_j','q_j+q_i'));
 assert.equal(reordered.regions[0].vectorMappingUnique,false,'equal counts cannot authorize reordered subscripts');
 await assert.rejects(stagePdfSourceFidelity(original,evidence,body.replace('q_i+q_j','q_j+q_i')),/needs review/);
 const duplicated=await auditPdfSourceFidelity(original,evidence,body+'\n\\[q_i\\tag{A}\\]');
 assert.equal(duplicated.regions[0].matchingEnvironments,2);
 assert.equal(duplicated.regions[0].vectorMappingUnique,false);
});

test('complete tokens/scripts and one-to-one equation labels refuse prefix or shared-environment repairs',async()=>{
 const {original,evidence}=await fixture();
 const one={...evidence,regions:[{...evidence.regions[0],glyphs:[evidence.regions[0].glyphs[0]]}]};
 for(const token of ['q_{i+j}','q_\\ell','\\q_i','q_{i}_j'])
  await assert.rejects(stagePdfSourceFidelity(original,one,`\\[${token}\\tag{A}\\]`),/needs review/);
 one.regions[0].glyphs[0]={...one.regions[0].glyphs[0],subscript:null};
 await assert.rejects(stagePdfSourceFidelity(original,one,'\\[q_\\ell\\tag{A}\\]'),/needs review/);
 for(const body of ['\\[q_i+q_j\\tag{A}\\]\\tag{B}','\\[q_i+q_j\\tag{A}\\tag{B}\\]'])
  await assert.rejects(stagePdfSourceFidelity(original,evidence,body),/needs review/);
});

test('CLI refuses input aliases, existing output/cache files and equal outputs before any write',async()=>{
 const {original,evidence}=await fixture(),directory=await mkdtemp(join(tmpdir(),'source-fidelity-output-'));
 const pdf=join(directory,'original.pdf'),proof=join(directory,'evidence.json'),text=join(directory,'text.txt'),cache=join(directory,'cache.txt');
 await writeFile(pdf,original);await writeFile(proof,JSON.stringify(evidence));await writeFile(text,'\\[q_i+q_j\\tag{A}\\]\n\\(r=0\\)\\tag{B}');await writeFile(cache,'Existing raw cache');
 const before=await Promise.all([pdf,proof,text,cache].map(path=>readFile(path)));
 const run=(extra:string[])=>spawnSync(process.execPath,['--experimental-strip-types',resolve('scripts/audit-pdf-source-fidelity.ts'),'--original',pdf,'--evidence',proof,'--text',text,...extra],{encoding:'utf8'});
 try{
  for(const output of [pdf,proof,text,cache])assert.notEqual(run(['--report',output]).status,0);
  const same=join(directory,'same.json');assert.notEqual(run(['--report',same,'--stage',same]).status,0);
  const hard=join(directory,'hard.txt');await link(text,hard);assert.notEqual(run(['--report',hard]).status,0);
  const aliasDir=join(directory,'alias');await symlink(directory,aliasDir,process.platform==='win32'?'junction':'dir');
  assert.notEqual(run(['--report',join(directory,'fresh.json'),'--stage',join(aliasDir,'fresh.json')]).status,0);
  assert.deepEqual(await Promise.all([pdf,proof,text,cache].map(path=>readFile(path))),before);
  assert.equal(run(['--report',join(directory,'valid-audit.json'),'--stage',join(directory,'valid-stage.json')]).status,0);
  assert.notEqual(run(['--report',join(directory,'valid-audit.json')]).status,0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('source audit refuses changed originals, wrong physical pages and unproved geometry',async()=>{
 const {original,evidence}=await fixture(),body='\\[q_i+q_j\\tag{A}\\]';
 await assert.rejects(auditPdfSourceFidelity(original,{...evidence,sourceSha256:'0'.repeat(64)},body),/identity mismatch/);
 await assert.rejects(auditPdfSourceFidelity(original,{...evidence,pageNumber:2},body),/identity mismatch/);
 await assert.rejects(auditPdfSourceFidelity(original,{...evidence,regions:[{...evidence.regions[0],bbox:[1,1,6,6]}]},body),/geometry/);
 const uncertain=structuredClone(evidence);uncertain.regions[0].vectorOrderVerified=false;
 const result=await auditPdfSourceFidelity(original,uncertain,body);
 assert.equal(result.regions[0].vectorMappingUnique,false);
 assert.equal(result.regions[0].repairAuthorized,false);
 await assert.rejects(stagePdfSourceFidelity(original,uncertain,body),/needs review/);
});
