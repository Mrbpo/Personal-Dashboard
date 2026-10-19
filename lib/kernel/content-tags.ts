import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';

export const CONTENT_TAG_TAXONOMY='academic-content-tags-v1';
export const CONTENT_TAG_PRODUCER='source-metadata-rules-v1';
export const CONTENT_TAG_FACETS=['course','term','source','format','document_type','topic','chapter','assignment'] as const;
type Facet=typeof CONTENT_TAG_FACETS[number];
export type ContentTag={id:string;facet:Facet;key:string;scope:'document';
 method:'metadata-observation'|'filename-rule';confidence:number;routingUse:'identity-only'|'soft-only';
 witness:{field:string;value:string}};
export type ContentTagMetadata={courseId:string|null;termId:string|null;origin:string;originKey:string;name:string;mime:string};
const canonical=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?
 Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');

export function contentTagIngestionEnabled(){
 const mode=process.env.KERNEL_CONTENT_TAGS??'off';
 if(!['off','metadata-v1'].includes(mode))throw Error('Invalid KERNEL_CONTENT_TAGS');
 return mode==='metadata-v1';
}

/** Tags describe stored metadata, never canonical truth or answer evidence.
 * Confidence 1 means an exact metadata observation, not verified relevance. */
export function classifyContentMetadata(input:ContentTagMetadata){
 const metadata=structuredClone(input);
 if(Object.keys(metadata).sort().join(',')!=='courseId,mime,name,origin,originKey,termId'||
  ['name','mime','origin','originKey'].some(key=>typeof metadata[key as keyof ContentTagMetadata]!=='string')||
  [metadata.courseId,metadata.termId].some(value=>value!==null&&(typeof value!=='string'||!value.trim()))||
  !metadata.origin.trim()||Object.values(metadata).some(value=>typeof value==='string'&&(value.length>4000||value.includes('\0'))))
  throw Error('Invalid content tag metadata');
 const tags:ContentTag[]=[],add=(facet:Facet,key:string,field:string,value:string,method:ContentTag['method']='metadata-observation')=>{
  if(tags.some(tag=>tag.facet===facet&&tag.key===key))return;
  tags.push({id:'tag:'+sha(canonical({taxonomy:CONTENT_TAG_TAXONOMY,facet,key})),facet,key,scope:'document',method,
   confidence:method==='metadata-observation'?1:0.7,routingUse:method==='metadata-observation'?'identity-only':'soft-only',witness:{field,value}});
 };
 if(metadata.courseId)add('course',metadata.courseId,'course_id',metadata.courseId);
 if(metadata.termId)add('term',metadata.termId,'courses.term_id',metadata.termId);
 const source=({canvas:'canvas',quercus:'canvas',piazza:'piazza',gmail:'gmail',kaltura:'kaltura',upload:'upload'} as Record<string,string>)[metadata.origin.toLowerCase()]??'other';
 add('source',source,'origin',metadata.origin);
 const mime=metadata.mime.toLowerCase().split(';')[0].trim(),format=mime==='application/pdf'?'pdf':
  ['text/vtt','application/x-subrip','application/ttml+xml'].includes(mime)?'subtitle':
  mime.startsWith('text/')?'text':mime.startsWith('image/')?'image':
  ['application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation'].includes(mime)?'slides':
  ['application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(mime)?'word':null;
 if(format)add('format',format,'mime',metadata.mime);
 const name=metadata.name.normalize('NFKC').toLowerCase();
 const rules:Array<[string,RegExp]>=[['syllabus',/\bsyllabus\b|课程大纲/u],['assignment',/\b(?:assignments?|problem[ _-]*sets?|homework|tutorials?|labs?)\b|作业|实验说明/u],
  ['lecture-notes',/\b(?:lecture[ _-]*notes?|notes?)\b|讲义/u],['slides',/\bslides?\b|课件/u],['announcement',/\bannouncements?\b|公告/u]];
 for(const [key,pattern]of rules)if(pattern.test(name))add('document_type',key,'name',metadata.name,'filename-rule');
 // An origin key is a naming observation too, not evidence of document content.
 if(source==='canvas'&&/(?:^|:)announcement(?::|$)/u.test(metadata.originKey))
  add('document_type','announcement','origin_key',metadata.originKey,'filename-rule');
 if(source==='piazza')add('document_type','discussion','origin',metadata.origin,'filename-rule');
 if(format==='subtitle')add('document_type','transcript','mime',metadata.mime,'filename-rule');
 tags.sort((a,b)=>a.facet<b.facet?-1:a.facet>b.facet?1:a.key<b.key?-1:a.key>b.key?1:0);
 const payload={taxonomyVersion:CONTENT_TAG_TAXONOMY,producer:CONTENT_TAG_PRODUCER,coverage:'source-metadata-only' as const,
  metadata,tags,unknownFacets:CONTENT_TAG_FACETS.filter(facet=>!tags.some(tag=>tag.facet===facet)),
  semanticVerified:false as const,filterAuthorization:false as const};
 return {...payload,inputSha256:sha(canonical(metadata)),classificationSha256:sha(canonical(payload))};
}

/** Called inside the existing ingestion transaction after its current-version
 * pointer is set. Read actual stored provenance rather than caller-supplied tags. */
export async function recordContentMetadataTags(client:PoolClient,owner:string,documentId:string,versionId:string){
 const row=(await client.query<{source_hash:string;source_version_id:string;course_id:string|null;term_id:string|null;
  origin:string;origin_key:string;name:string;mime:string}>(
  `SELECT d.source_hash,v.source_version_id,d.course_id,c.term_id,d.origin,d.origin_key,
   coalesce(s.raw_value->>'name',d.name) name,coalesce(s.raw_value->>'mime','') mime
   FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
   JOIN source_item_versions s ON s.id=v.source_version_id AND s.source_item_id=d.source_item_id
   LEFT JOIN courses c ON c.id=d.course_id
   WHERE d.owner_id=$1 AND d.id=$2 AND v.id=$3 AND NOT d.hidden FOR UPDATE OF d`,[owner,documentId,versionId])).rows[0];
 if(!row)throw Error('Content tag source is not a current owned document');
 const classification=classifyContentMetadata({courseId:row.course_id,termId:row.term_id,origin:row.origin,originKey:row.origin_key,name:row.name,mime:row.mime});
 const id=sha(canonical({owner,documentId,versionId,sourceHash:row.source_hash,sourceVersionId:row.source_version_id,
  classificationSha256:classification.classificationSha256}));
 await client.query(`INSERT INTO document_tag_sets(id,owner_id,document_id,version_id,source_version_id,source_hash,
  taxonomy_version,producer,input_sha256,classification_sha256,metadata,tags,unknown_facets)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING`,
 [id,owner,documentId,versionId,row.source_version_id,row.source_hash,classification.taxonomyVersion,classification.producer,
  classification.inputSha256,classification.classificationSha256,JSON.stringify(classification.metadata),JSON.stringify(classification.tags),classification.unknownFacets]);
 return {id,...classification};
}

/** Return current-version observations, including multiple metadata revisions.
 * No winner or exclusive routing scope is inferred from these snapshots. */
export async function readContentMetadataTags(pool:Pool,owner:string,documentId:string){
 return (await pool.query(`SELECT t.* FROM document_tag_sets t JOIN document_texts d ON d.id=t.document_id
  AND d.owner_id=t.owner_id AND d.source_hash=t.source_hash AND d.current_version_id=t.version_id
  WHERE d.owner_id=$1 AND d.id=$2 AND NOT d.hidden ORDER BY t.created_at,t.id`,[owner,documentId])).rows;
}
