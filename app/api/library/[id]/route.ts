import {apiOwner,apiError} from '@/lib/api-guard';
import {getDocument,readBlob,removeDocument} from '@/lib/library';
import {kernel} from '@/lib/kernel/service';
import {documentSourceTextViewRequest,DOCUMENT_SOURCE_TEXT_VIEW_SCOPE} from '@/lib/kernel/document-source-text-view';
import {createHash} from 'node:crypto';
export async function GET(r:Request,{params}:{params:Promise<{id:string}>}){try{
 const owner=await apiOwner(r),id=(await params).id,query=new URL(r.url).searchParams;
 if(query.has('parserRegions')&&(query.get('parserRegions')!=='1'||query.get('evidence')!=='1'||
  ['snapshot','scope','nativeRegions','preview'].some(key=>query.has(key))))throw Error('Parser regions require an exclusive current-source evidence reader');
 const viewRequest=documentSourceTextViewRequest(id,query);
 if(viewRequest){
  const sourceTextView=await kernel.readDocumentSourceTextView(owner,viewRequest.source,viewRequest.manifestSha256);
  const pinned=sourceTextView.status==='available'?new URLSearchParams({evidence:'1',scope:DOCUMENT_SOURCE_TEXT_VIEW_SCOPE,
   version:sourceTextView.source.currentVersionId,sourceVersion:sourceTextView.source.sourceVersionId,sourceHash:sourceTextView.source.sourceHash,
   manifest:sourceTextView.manifest.manifestSha256}):undefined;
  return Response.json({sourceTextView,...(pinned?{sourceViewUrl:`/api/library/${encodeURIComponent(id)}?${pinned}`}:{})},
   {status:sourceTextView.status==='available'?200:409,headers:{'Cache-Control':'no-store'}});
 }
 if(query.get('evidence')==='1'){
  const source={documentId:id,currentVersionId:query.get('version')||'',sourceVersionId:query.get('sourceVersion')||'',sourceHash:query.get('sourceHash')||''};
  const evidenceId=query.get('evidenceId')||'';
  if(!evidenceId||[...Object.values(source),evidenceId].some(value=>!value||value.length>1000))throw Error('Invalid evidence reference');
  if(query.get('snapshot')==='1'){
   if(query.get('nativeRegions')==='1')throw Error('Native regions require the current-source reader');
   const snapshot=await kernel.readDocumentCitationSnapshot(owner,{documentId:id,documentVersionId:source.currentVersionId,
    sourceVersionId:source.sourceVersionId,sourceHash:source.sourceHash},[evidenceId]);
   return Response.json({snapshot,sourceContentIsUntrusted:true},{headers:{'Cache-Control':'no-store'}});
  }
  // This current-source/owner check is required even for PostgreSQL-only sources
  // with no legacy SQLite library row. Never fall back to a different version.
  const nodes=await kernel.readDocumentNodes(owner,source,[evidenceId]);
  const nativeRegions=query.get('nativeRegions')==='1'?await kernel.readDocumentNativeRegions(owner,source,nodes[0].page_number):undefined;
  const parserRegions=query.get('parserRegions')==='1'?await kernel.readDocumentPageRegions(owner,source,nodes[0].page_number):undefined;
  if(parserRegions?.status==='available'&&(parserRegions.pageEvidenceId!==evidenceId||
   parserRegions.pageBodySha256!==createHash('sha256').update(nodes[0].body).digest('hex')))throw Error('Parser observation page changed');
  return Response.json({source,nodes,...(nativeRegions!==undefined?{nativeRegions}:{}),...(parserRegions!==undefined?{parserRegions}:{}),sourceContentIsUntrusted:true},{headers:{'Cache-Control':'no-store'}});
 }
 const d=await getDocument(owner,id),preview=query.get('preview')==='1',inline=preview&&(d.mime==='application/pdf'||['image/png','image/jpeg','image/webp','image/gif','image/avif'].includes(d.mime));return new Response(await readBlob(d.hash),{headers:{'Content-Type':d.mime,'Content-Disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(d.name)}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}catch(e){return apiError(e);}}
export async function DELETE(r:Request,{params}:{params:Promise<{id:string}>}){try{await removeDocument(await apiOwner(r),(await params).id);return Response.json({ok:true});}catch(e){return apiError(e);}}
