import type {Pool} from 'pg';
import {documentRoutingScopeSql,type DocumentRoutingScope} from './document-routing-scope.ts';

/** A visible client selection, kept separate from the relevance query. */
export type DocumentSourceHint={selectedDocumentTitle:string};
export type ResolvedDocumentSource={documentId:string;title:string;currentVersionId:string;sourceVersionId:string;sourceHash:string};
type SourceResolutionScope={scope:'selected-title-scoped';selectedDocumentTitle:string};
export type DocumentSourceResolution=SourceResolutionScope&(
 {status:'resolved';document:ResolvedDocumentSource}|
 {status:'not-found'}|
 {status:'ambiguous';matches:ResolvedDocumentSource[]}
);
export type DocumentSourceErrorCode='DOCUMENT_SOURCE_INVALID_HINT'|'DOCUMENT_SOURCE_NOT_FOUND'|
 'DOCUMENT_SOURCE_AMBIGUOUS'|'DOCUMENT_SOURCE_SCOPE_CONFLICT'|'DOCUMENT_SOURCE_CHANGED';

export class DocumentSourceResolutionError extends Error{
 readonly code:DocumentSourceErrorCode;
 readonly scope='selected-title-scoped' as const;
 readonly resolution?:DocumentSourceResolution;
 constructor(code:DocumentSourceErrorCode,message:string,resolution?:DocumentSourceResolution){
  super(message);this.name='DocumentSourceResolutionError';this.code=code;this.resolution=resolution;
 }
}

/** Resolve a complete NFKC title against the same current corpus as search.
 * No aliases, title tokens, bodies, question IDs, or author gold participate.
 * Two matches establish ambiguity; order never selects a preferred match.
 */
export async function resolveDocumentSource(pool:Pool,owner:string,hint:DocumentSourceHint,
 options:{courseId?:string;routingScope?:DocumentRoutingScope}={}):Promise<DocumentSourceResolution>{
 if(typeof hint?.selectedDocumentTitle!=='string'||!hint.selectedDocumentTitle.trim()
  ||hint.selectedDocumentTitle.length>4000)
  throw new DocumentSourceResolutionError('DOCUMENT_SOURCE_INVALID_HINT','A complete selected document title is required');
 const title=hint.selectedDocumentTitle.normalize('NFKC');
 const scope:SourceResolutionScope={scope:'selected-title-scoped',selectedDocumentTitle:hint.selectedDocumentTitle};
 const args:unknown[]=[owner,title,options.courseId||null],routing=documentRoutingScopeSql(options.routingScope,args);
 const matches=(await pool.query<ResolvedDocumentSource>(`SELECT d.id "documentId",d.name title,
  v.id "currentVersionId",v.source_version_id "sourceVersionId",d.source_hash "sourceHash"
  FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
  WHERE d.owner_id=$1 AND NOT d.hidden AND ($3::text IS NULL OR d.course_id=$3) ${routing}
   AND normalize(d.name,NFKC)=$2
   AND NOT EXISTS (SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id
    AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND NOT newer.hidden
    AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))
  ORDER BY d.id LIMIT 2`,args)).rows;
 if(!matches.length)return {...scope,status:'not-found'};
 if(matches.length>1)return {...scope,status:'ambiguous',matches};
 return {...scope,status:'resolved',document:matches[0]};
}

export function requireResolvedDocumentSource(resolution:DocumentSourceResolution):ResolvedDocumentSource{
 if(resolution.status==='not-found')throw new DocumentSourceResolutionError('DOCUMENT_SOURCE_NOT_FOUND',
  'Selected document title was not found in the current visible scope',resolution);
 if(resolution.status==='ambiguous')throw new DocumentSourceResolutionError('DOCUMENT_SOURCE_AMBIGUOUS',
  'Selected document title is ambiguous in the current visible scope',resolution);
 return resolution.document;
}

/** A small metadata gate, not semantic intent detection. Exact complete titles
 * of other current visible sources prevent an exclusive initial-source read.
 * Two examples suffice to establish a cross-source question; no bodies load. */
export async function mentionedOtherDocumentSources(pool:Pool,owner:string,question:string,selectedDocumentId:string){
 return (await pool.query<Pick<ResolvedDocumentSource,'documentId'|'title'>>(`SELECT d.id "documentId",d.name title
  FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
  WHERE d.owner_id=$1 AND NOT d.hidden AND d.id<>$2 AND length(trim(d.name))>0
   AND strpos($3,normalize(d.name,NFKC))>0
   AND NOT EXISTS (SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id
    AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND NOT newer.hidden
    AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))
  ORDER BY d.id LIMIT 2`,[owner,selectedDocumentId,question.normalize('NFKC')])).rows;
}
