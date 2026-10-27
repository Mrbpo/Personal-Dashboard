import{createHash}from'node:crypto';

export const CONTENT_TAXONOMY_FACETS=['course','term','source','format','document_type','topic','chapter','assignment']as const;
export const CONTENT_METADATA_CATALOG_VERSION='academic-metadata-catalog-v1';
/** Literal normalized alias boundary only, never semantic identity. A shared
 * alias may match several entries; callers must not choose the first one. */
export function literalTaxonomyMention(query:string,key:string){
 const normalize=(s:string)=>s.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu,' '),q=normalize(query),k=normalize(key);if(!k)return false;
 for(let at=q.indexOf(k);at>=0;at=q.indexOf(k,at+1)){
  const left=Array.from(q.slice(0,at)).at(-1)??'',right=Array.from(q.slice(at+k.length))[0]??'',first=Array.from(k)[0],last=Array.from(k).at(-1)!;
  if((/\p{Script=Han}/u.test(first)||!/[\p{L}\p{N}_]/u.test(left))&&(/\p{Script=Han}/u.test(last)||!/[\p{L}\p{N}_]/u.test(right)))return true;
 }
 return false;
}
// Controlled metadata/navigation vocabulary only. Dynamic subjects, course IDs
// and relationships still need source-bound revisions; these are not facts.
const sources=[
 {key:'canvas',origins:['canvas','quercus'],query:/\b(?:canvas|quercus)\b/giu},
 {key:'piazza',origins:['piazza'],query:/\bpiazza\b/giu},
 {key:'gmail',origins:['gmail'],query:/\b(?:gmail|emails?)\b|邮件/giu},
 {key:'kaltura',origins:['kaltura'],query:/\bkaltura\b/giu},
 {key:'upload',origins:['upload']},{key:'other',origins:[]},
];
type TypeRule={key:string;query:RegExp;name:RegExp;legacyName?:RegExp};
const types:TypeRule[]=[
 {key:'syllabus',query:/\bsyllabus\b|\bcourse\s+outline\b|课程大纲/giu,
  name:/\bsyllabus\b|\bcourse[ _-]+outline\b|课程大纲/u,legacyName:/\bsyllabus\b|课程大纲/u},
 {key:'assignment',query:/\b(?:assignments?|homework|problem\s+sets?|tutorials?|labs?)\b|作业|实验说明/giu,
  name:/\b(?:assignments?|problem[ _-]*sets?|homework|tutorials?|labs?)\b|作业|实验说明/u,
  legacyName:/\b(?:assignments?|problem[ _-]*sets?|homework|tutorials?|labs?)\b|作业|实验说明/u},
 {key:'lecture-notes',query:/\blecture\s+notes?\b|讲义/giu,name:/\b(?:lecture[ _-]*notes?|notes?)\b|讲义/u,
  legacyName:/\b(?:lecture[ _-]*notes?|notes?)\b|讲义/u},
 {key:'slides',query:/\bslides?\b|课件/giu,name:/\bslides?\b|课件/u,legacyName:/\bslides?\b|课件/u},
 {key:'announcement',query:/\bannouncements?\b|公告/giu,name:/\bannouncements?\b|公告/u,legacyName:/\bannouncements?\b|公告/u},
 {key:'discussion',query:/\bdiscussions?\b|论坛|讨论/giu,name:/\bdiscussions?\b|论坛|讨论/u},
 {key:'transcript',query:/\b(?:transcripts?|subtitles?)\b|字幕|转写/giu,name:/\b(?:transcripts?|subtitles?)\b|字幕|转写/u},
];
const formats:Array<{key:string;mime:string[];prefix:string[]}>= [
 {key:'pdf',mime:['application/pdf'],prefix:[]},
 {key:'subtitle',mime:['text/vtt','application/x-subrip','application/ttml+xml'],prefix:[]},
 {key:'text',mime:[],prefix:['text/']},{key:'image',mime:[],prefix:['image/']},
 {key:'slides',mime:['application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation'],prefix:[]},
 {key:'word',mime:['application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],prefix:[]},
];
const pattern=(r:RegExp|undefined)=>r?{source:r.source,flags:r.flags}:null;
const manifest={version:CONTENT_METADATA_CATALOG_VERSION,facets:CONTENT_TAXONOMY_FACETS,
 sources:sources.map(s=>({key:s.key,origins:s.origins,query:pattern(s.query)})),
 documentTypes:types.map(t=>({key:t.key,query:pattern(t.query),name:pattern(t.name),legacyName:pattern(t.legacyName)})),formats};
export const CONTENT_METADATA_CATALOG_SHA256=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
export const CONTENT_METADATA_PRODUCER='source-metadata-rules-v2/'+CONTENT_METADATA_CATALOG_SHA256;
export function contentMetadataCatalog(){return structuredClone(manifest);}
export function contentMetadataSource(origin:string){return sources.find(s=>s.origins.includes(origin.toLowerCase()))?.key??'other';}
export function contentMetadataFormat(mime:string){
 const normalized=mime.toLowerCase().split(';')[0].trim();
 return formats.find(f=>f.mime.includes(normalized)||f.prefix.some(p=>normalized.startsWith(p)))?.key??null;
}
export function contentMetadataNameTypes(normalizedName:string,version:'legacy-v1'|'catalog-v2'){
 return types.filter(t=>{const r=version==='legacy-v1'?t.legacyName:t.name;return r?new RegExp(r.source,r.flags).test(normalizedName):false;}).map(t=>t.key);
}
export function contentMetadataQueryAliases():Array<['document_type'|'source',string,RegExp]>{
 return [...types.map(t=>['document_type',t.key,new RegExp(t.query.source,t.query.flags)]as ['document_type',string,RegExp]),
  ...sources.flatMap(s=>s.query?[['source',s.key,new RegExp(s.query.source,s.query.flags)]as ['source',string,RegExp]]:[])];
}
