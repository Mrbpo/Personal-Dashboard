import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
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
