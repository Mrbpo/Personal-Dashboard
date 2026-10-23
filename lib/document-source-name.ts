/** A filename is not a path. Preserve source spelling separately from the
 * existing safe attachment label; no fuzzy or reverse-sanitization aliases. */
export const safeAttachmentName=(name:string)=>name.replace(/[\\/\x00-\x1f]/g,'_').slice(-160);
export type DocumentSourceName={policy:'original-before-filename-sanitization-v1';originalName:string;storageName:string};
export function documentSourceName(name:string,originalName?:string|null,registered?:unknown):DocumentSourceName|undefined{
 if(originalName==null&&registered==null)return undefined;
 const value=originalName!=null?{policy:'original-before-filename-sanitization-v1',originalName,storageName:safeAttachmentName(originalName)}:registered;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='originalName,policy,storageName')throw Error('Invalid document source-name observation');
 const v=value as DocumentSourceName;
 if(v.policy!=='original-before-filename-sanitization-v1'||typeof v.originalName!=='string'||!v.originalName.trim()||v.originalName.length>4000||v.originalName.includes('\0')||
  typeof v.storageName!=='string'||!v.storageName||v.storageName!==safeAttachmentName(v.originalName)||name!==v.storageName&&name!==v.originalName)
  throw Error('Document source name does not match its stored filename');
 return {policy:v.policy,originalName:v.originalName,storageName:v.storageName};
}
