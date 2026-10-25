import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {readCompleteDocumentText,DocumentContextError,type DocumentContextSource,type DocumentTextSourceRead} from './document-context.ts';
import {preparePersistedTextCoverage} from './document-text-coverage.ts';

export const DOCUMENT_SOURCE_TEXT_VIEW_SCOPE='current-persisted-text-v1';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const canonical=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
 ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const invalid=():never=>{throw new DocumentContextError('DOCUMENT_CONTEXT_INVALID','Invalid source text view request');};
function assertPin(value:unknown){if(value!==undefined&&(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)))invalid();}

/** Parse only this explicit scope. It cannot silently become a one-node view,
 * binary download, native-region request or historical snapshot. */
export function documentSourceTextViewRequest(documentId:string,query:URLSearchParams){
 if(!query.has('scope'))return;
 if(query.get('scope')!==DOCUMENT_SOURCE_TEXT_VIEW_SCOPE||query.get('evidence')!=='1'||
  ['snapshot','evidenceId','nativeRegions','preview'].some(key=>query.has(key)))invalid();
 const source={documentId,currentVersionId:query.get('version')??'',sourceVersionId:query.get('sourceVersion')??'',sourceHash:query.get('sourceHash')??''};
 if(Object.values(source).some(value=>!value.trim()||value.length>1000))invalid();
 const manifestSha256=query.has('manifest')?query.get('manifest')!:undefined;assertPin(manifestSha256);
 return {source,manifestSha256};
}

/** Pure projection of a Kernel-authorized read, not an authorization method.
 * Preserve original node boundaries and IDs: no synthetic cross-page quote. */
type SourceTextViewRead=Extract<DocumentTextSourceRead,{status:'unavailable'}>|{
 status:'available';manifest:DocumentTextSourceRead['manifest'];context:Pick<Extract<DocumentTextSourceRead,{status:'available'}>['context'],'anchors'>};
export function buildDocumentSourceTextView(read:SourceTextViewRead,manifestSha256?:string){
 assertPin(manifestSha256);
 const {manifest}=read,{manifestSha256:actual,...unsignedManifest}=manifest;
 if(sha(canonical(unsignedManifest))!==actual)invalid();
 if(manifestSha256!==undefined&&manifestSha256!==actual)
  throw new DocumentContextError('DOCUMENT_CONTEXT_CHANGED','Pinned source text manifest changed');
 const common={scope:DOCUMENT_SOURCE_TEXT_VIEW_SCOPE,source:structuredClone(manifest.source),manifest:structuredClone(manifest),
  sourceContentIsUntrusted:true as const,originalFileCompletenessVerified:false as const,visualCompletenessVerified:false as const,
  textFaithfulness:'unassessed' as const,currentSourceOnly:true as const};
 if(read.status==='unavailable'){
  if(!['source-size-limit','structure-unavailable'].includes(read.reason)||manifest.textCoverage!=='unavailable'||
   manifest.returnedNodeCount!==0||manifest.orderedTextSha256!==null||manifest.structureManifestSha256!==null||
   manifest.originalFileCompletenessVerified!==false||manifest.visualCompletenessVerified!==false)invalid();
  return {...common,status:'unavailable' as const,reason:read.reason};
 }
 if(read.context.anchors.length!==manifest.returnedNodeCount)invalid();
 const proof=preparePersistedTextCoverage(manifest,read.context.anchors),byId=new Map(read.context.anchors.map(node=>[node.evidence_id,node]));
 const nodes=proof.nodes.map(node=>{
  const original=byId.get(node.evidenceId)!;
  return {...node,locator:original.locator,body:original.body,parserVersion:original.parser_version,parserWarnings:[...original.parser_warnings??[]]};
 });
 const value={...common,status:'available' as const,coverage:'all-current-persisted-nodes' as const,nodes};
 return {...value,viewSha256:sha(canonical(value))};
}

/** Reuse the existing complete-text reader's owner/current-version checks and
 * limits. An unavailable read never falls back to another source or subset. */
export async function readDocumentSourceTextView(pool:Pool,owner:string,source:DocumentContextSource,manifestSha256?:string){
 assertPin(manifestSha256);
 return buildDocumentSourceTextView(await readCompleteDocumentText(pool,owner,source),manifestSha256);
}
