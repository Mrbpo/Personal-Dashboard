/** Required cue keys prevent a model from dropping or duplicating array entries. */
export function subtitleTranslationSchema(indices:number[]){
 if(!indices.length||indices.some(index=>!Number.isSafeInteger(index)||index<0)||new Set(indices).size!==indices.length)throw new Error('Invalid subtitle selection');
 const keys=indices.map(String);
 return {type:'object',additionalProperties:false,properties:{translations:{type:'object',additionalProperties:false,
  properties:Object.fromEntries(keys.map(key=>[key,{type:'string',pattern:'\\S'}])),required:keys}},required:['translations']};
}

export function parseSubtitleTranslations(value:unknown,indices:number[]):Array<{index:number;zh:string}>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!('translations' in value))throw new Error('Incomplete/mismatched translation; response saved, no auto-correction');
 const translations=(value as {translations:unknown}).translations;
 if(!translations||typeof translations!=='object'||Array.isArray(translations))throw new Error('Incomplete/mismatched translation; response saved, no auto-correction');
 const rows=translations as Record<string,unknown>,expected=new Set(indices.map(String));
 if(Object.keys(rows).length!==indices.length||Object.keys(rows).some(key=>!expected.has(key)))throw new Error('Incomplete/mismatched translation; response saved, no auto-correction');
 return indices.map(index=>{
  const zh=rows[String(index)];
  if(typeof zh!=='string'||!zh.trim()||zh.length>10000)throw new Error('Incomplete/mismatched translation; response saved, no auto-correction');
  return {index,zh};
 });
}
