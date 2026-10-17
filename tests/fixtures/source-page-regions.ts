import {createHash} from 'node:crypto';
import {decodeDoclingResult} from '../../lib/kernel/docling-result.ts';
import {pdfVisualCanonical} from '../../lib/kernel/pdf-visual-evidence.ts';
import type {DocumentContextSource} from '../../lib/kernel/document-context.ts';
export const fixtureSha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
/** Synthetic declarations only, reusable by a separate isolated PG runner.
 * No historical raw is presented as a registered current source. */
export function sourcePageRegionsFixture(source?:DocumentContextSource,owner='regions-fixture-owner',
 options:{sourceHash?:string;inputHash?:string;pageEvidenceId?:string}={}){
 const sourceHash=options.sourceHash??fixtureSha('synthetic regions source; not an original-PDF fidelity fixture');
 source??={documentId:'regions-fixture-doc',currentVersionId:'regions-fixture-version',sourceVersionId:'regions-fixture-source',sourceHash,courseId:''};
 if(source.sourceHash!==sourceHash)throw Error('Fixture source hash differs');
 const ref=(n:string)=>({$ref:'#/'+n}),box={l:10,t:180,r:80,b:160,coord_origin:'BOTTOMLEFT'},
  prov=(bbox:unknown=box)=>[{page_no:1,...(bbox?{bbox}:{})}],
  result={status:'success',errors:[],document:{json_content:{schema_name:'DoclingDocument',version:'fixture-v1',
   pages:{1:{page_no:1,size:{width:100,height:200}}},furniture:{children:[]},
   body:{children:[ref('texts/0'),ref('groups/0'),ref('texts/1'),ref('tables/0'),ref('pictures/0')]},
   texts:[{self_ref:'#/texts/0',label:'section_header',parent:ref('body'),text:'Observed heading',orig:'Observed heading',prov:prov()},
    {label:'paragraph',parent:ref('body'),orig:'Original paragraph without geometry.',text:'',prov:prov(null)},
    {label:'caption',parent:ref('tables/0'),text:'Table A. Declared caption.',prov:prov()},
    {label:'formula',parent:ref('groups/0'),orig:'x2',text:'x^2',formatting:{italic:true},prov:prov()}],
   groups:[{label:'inline',parent:ref('body'),children:[ref('texts/3')]}],
   tables:[{self_ref:'#/tables/0',label:'table',parent:ref('body'),prov:prov(),captions:[ref('texts/2')],
    data:{num_rows:1,num_cols:1,table_cells:[{text:'3.5',start_row_offset_idx:0,start_col_offset_idx:0}]}}],
   pictures:[{self_ref:'#/pictures/0',label:'picture',parent:ref('body'),prov:prov(),children:[]}]}}};
 const body=decodeDoclingResult(result,1).pages[0].text,optionsHash=fixtureSha('synthetic Docling settings'),inputHash=options.inputHash??fixtureSha('synthetic derived input'),
  identity={owner,documentId:source.documentId,sourceHash,totalPages:1,optionsHash,start:1,end:1,inputHash,copyIndices:[0]},
  raw=Buffer.from(JSON.stringify({identity,result})),rawHash=fixtureSha(raw),
  reference={resultBlobSha256:rawHash,derivedInputSha256:inputHash,copyIndices:[0]},
  layout={status:'available' as const,regions:[],pageSizes:[{pageNumber:1,width:100,height:200}],resultReferences:[reference]},
  progress={schema:1,identity:{owner,documentId:source.documentId,sourceHash,totalPages:1,optionsHash},batchSize:1,
   batches:[{start:1,end:1,resultHash:rawHash,inputHash,copyIndices:[0]}]},
  png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQWQAAAAASUVORK5CYII=','base64'),pngSha=fixtureSha(png),
  evidenceId=options.pageEvidenceId??'regions-fixture-evidence',
  asset={kind:'pdf-page' as const,physicalPage:1,sha256:pngSha,width:1,height:1,byteLength:png.length,
   provenance:{rawPdfSha256:sourceHash,pageRenderSha256:pngSha,pageSizePoints:{width:100,height:200},rotation:0,
    rendererPolicy:'synthetic-test-only',sourcePageCropBox:{x:0,y:0,width:100,height:200}}},
  content={schema:1,rawPdfSha256:sourceHash,pageCount:1,layout,layoutStatus:'available',renderStatus:'available',assets:[asset]},
  visualManifest={content,bindings:[{index:0,anchorEvidenceId:evidenceId}]},
  visual={manifest:visualManifest,manifest_sha256:fixtureSha(pdfVisualCanonical(visualManifest)),content_sha256:fixtureSha(pdfVisualCanonical(content))},
  structure={rawSourceHash:sourceHash,parserVersion:'synthetic-regions-fixture-v1',parents:[],
   nodes:[{evidenceId,locator:'page:1',ordinal:0,kind:'page' as const,bodySha256:fixtureSha(body)}]};
 return {source,owner,result,body,identity,raw,rawHash,reference,layout,progress,png,pngSha,evidenceId,asset,visual,structure,
  casBlobs:[{sha256:rawHash,bytes:raw},{sha256:pngSha,bytes:png}]};
}
