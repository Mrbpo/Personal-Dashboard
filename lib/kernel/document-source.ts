import type {Pool} from 'pg';

/** A visible client selection, kept separate from the relevance query. */
export type DocumentSourceHint={selectedDocumentTitle:string};
export type ResolvedDocumentSource={documentId:string;title:string;currentVersionId:string;sourceVersionId:string;sourceHash:string};
export type MentionedDocumentSources={status:'not-mentioned'|'resolved'|'ambiguous';matches:ResolvedDocumentSource[]};
/** A question mention is not a replacement for the canonical stored name. Only
 * the terminal PDF extension may be omitted; no case folding or fuzzy aliases. */
export function documentTitleMention(question:string,canonicalName:string){
 const query=question.normalize('NFKC'),canonical=canonicalName.normalize('NFKC');
 const forms=[canonical,...(/\.pdf$/i.test(canonical)?[canonical.slice(0,-4)]:[])];
 for(const text of forms){
  if(!text)continue;
  let start=query.indexOf(text);
  while(start>=0){
   const before=query.slice(0,start),after=query.slice(start+text.length);
   if(!(/^[\p{L}\p{N}\p{M}_]/u.test(text)&&/[\p{L}\p{N}\p{M}_]$/u.test(before))&&
    !(/[\p{L}\p{N}\p{M}_]$/u.test(text)&&/^[\p{L}\p{N}\p{M}_]/u.test(after))&&
    !/^\.[\p{L}\p{N}]/u.test(after))return {text,start,end:start+text.length};
   start=query.indexOf(text,start+1);
  }
 }
 return null;
}
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
 options:{courseId?:string}={}):Promise<DocumentSourceResolution>{
 if(typeof hint?.selectedDocumentTitle!=='string'||!hint.selectedDocumentTitle.trim()
  ||hint.selectedDocumentTitle.length>4000)
  throw new DocumentSourceResolutionError('DOCUMENT_SOURCE_INVALID_HINT','A complete selected document title is required');
 const title=hint.selectedDocumentTitle.normalize('NFKC');
 const scope:SourceResolutionScope={scope:'selected-title-scoped',selectedDocumentTitle:hint.selectedDocumentTitle};
 const matches=(await pool.query<ResolvedDocumentSource>(`SELECT d.id "documentId",d.name title,
  v.id "currentVersionId",v.source_version_id "sourceVersionId",d.source_hash "sourceHash"
  FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
  WHERE d.owner_id=$1 AND NOT d.hidden AND ($3::text IS NULL OR d.course_id=$3)
   AND normalize(d.name,NFKC)=$2
   AND NOT EXISTS (SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id
    AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND NOT newer.hidden
    AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))
  ORDER BY d.id LIMIT 2`,[owner,title,options.courseId||null])).rows;
 if(!matches.length)return {...scope,status:'not-found'};
 if(matches.length>1)return {...scope,status:'ambiguous',matches};
 return {...scope,status:'resolved',document:matches[0]};
}

/** Conservative metadata-only discovery, not intent or evidence validation.
 * Match a full case-sensitive NFKC name or its terminal-PDF-extension-free form.
 * Automatic selection requires >=12 codepoints and two alphanumeric words, or
 * >=8 Han characters; short/single-word titles keep ordinary retrieval. Titles
 * embedded in a larger word do not count. Explicit sourceHint remains unchanged.
 * Apply LIMIT only after these checks: two false substrings must not hide a real
 * match, and two different current documents with the same title stay ambiguous.
 */
export async function findMentionedDocumentSources(pool:Pool,owner:string,question:string,
 options:{courseId?:string}={}):Promise<MentionedDocumentSources>{
 if(typeof owner!=='string'||!owner.trim()||owner.length>4000||typeof question!=='string'||question.length>12000||
  (options.courseId!==undefined&&(typeof options.courseId!=='string'||options.courseId.length>4000)))
  throw new Error('Invalid current document title mention scope');
 if(!question.trim())return {status:'not-mentioned',matches:[]};
 const query=question.normalize('NFKC');
 const rows=(await pool.query<ResolvedDocumentSource>(`SELECT d.id "documentId",d.name title,
  v.id "currentVersionId",v.source_version_id "sourceVersionId",d.source_hash "sourceHash"
  FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
  WHERE d.owner_id=$1 AND NOT d.hidden AND ($3::text IS NULL OR d.course_id=$3)
   AND length(normalize(d.name,NFKC)) BETWEEN 8 AND 4000
   AND (strpos($2,normalize(d.name,NFKC))>0 OR strpos($2,regexp_replace(normalize(d.name,NFKC),'[.][pP][dD][fF]$',''))>0)
   AND NOT EXISTS (SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id
    AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND NOT newer.hidden
    AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))
  ORDER BY d.id`,[owner,query,options.courseId||null])).rows;
 const matches:ResolvedDocumentSource[]=[];
 for(const row of rows){
  const mention=documentTitleMention(question,row.title);if(!mention)continue;
  const title=mention.text,words=title.match(/[\p{L}\p{N}]+/gu)??[];
  if(!((Array.from(title).length>=12&&words.filter(word=>Array.from(word).length>=2).length>=2)||
   (title.match(/\p{Script=Han}/gu)?.length??0)>=8))continue;
  matches.push(row);
  if(matches.length===2)break;
 }
 return {status:matches.length===1?'resolved':matches.length?'ambiguous':'not-mentioned',matches};
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
 const rows=(await pool.query<Pick<ResolvedDocumentSource,'documentId'|'title'>>(`SELECT d.id "documentId",d.name title
  FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
  WHERE d.owner_id=$1 AND NOT d.hidden AND d.id<>$2 AND length(trim(d.name))>0
   AND (strpos($3,normalize(d.name,NFKC))>0 OR strpos($3,regexp_replace(normalize(d.name,NFKC),'[.][pP][dD][fF]$',''))>0)
   AND NOT EXISTS (SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id
    AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND NOT newer.hidden
    AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))
  ORDER BY d.id`,[owner,selectedDocumentId,question.normalize('NFKC')])).rows;
 return rows.filter(row=>documentTitleMention(question,row.title)).slice(0,2);
}
