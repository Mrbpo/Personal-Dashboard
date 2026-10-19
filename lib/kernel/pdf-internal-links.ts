import {PDFArray,PDFDict,PDFDocument,PDFHexString,PDFName,PDFNull,PDFNumber,PDFObject,PDFRef,PDFString} from 'pdf-lib';

export const PDF_INTERNAL_LINK_POLICY='pdf-native-goto-v1' as const;
export const PDF_INTERNAL_LINK_LIMITS=Object.freeze({pages:500,annotations:10000,links:2000,names:10000,depth:32,nameChars:512});
export type PdfInternalLink={sourcePageNumber:number;annotationIndex:number;annotationReference:string|null;
 sourceRect:[number,number,number,number]|null;coordinateSpace:'original-pdf-default-user-space';destinationName:string|null;
 target:{status:'resolved-page';physicalPageNumber:number;view:string;parameters:Array<number|null>}|{status:'unknown';reason:string}};
export type PdfInternalLinks={policy:typeof PDF_INTERNAL_LINK_POLICY;status:'available'|'partial'|'unavailable';
 semantics:'navigation-only';semanticVerified:false;pageCount:number;examinedAnnotations:number;ignoredActions:number;
 namedDestinationsComplete:boolean;notes:string[];links:PdfInternalLink[]};

/** Original PDF dictionary observations only. The caller binds the original
 * bytes/hash; a GoTo target does not verify citation meaning or visible text. */
export function observePdfInternalLinks(pdf:PDFDocument,limits:{[K in keyof typeof PDF_INTERNAL_LINK_LIMITS]:number}=PDF_INTERNAL_LINK_LIMITS):PdfInternalLinks{
 for(const [key,max]of Object.entries(PDF_INTERNAL_LINK_LIMITS)){
  const value=limits[key as keyof typeof limits];if(!Number.isInteger(value)||value<1||value>max)throw Error('Invalid bounded PDF link limits');
 }
 const result:PdfInternalLinks={policy:PDF_INTERNAL_LINK_POLICY,status:'available',semantics:'navigation-only',semanticVerified:false,
  pageCount:pdf.getPageCount(),examinedAnnotations:0,ignoredActions:0,namedDestinationsComplete:true,notes:[],links:[]};
 const partial=(reason:string)=>{result.status='partial';if(!result.notes.includes(reason))result.notes.push(reason);};
 if(result.pageCount>limits.pages){result.status='unavailable';result.notes=['page-limit'];return result;}
 const resolve=(value:PDFObject|undefined):PDFObject|undefined=>{try{return value===undefined?undefined:pdf.context.lookup(value);}catch{return undefined;}};
 const field=(dict:PDFDict,key:string)=>resolve(dict.get(PDFName.of(key),true));
 const string=(value:PDFObject|undefined)=>value instanceof PDFString||value instanceof PDFHexString||value instanceof PDFName?value.decodeText():null;
 const names=new Map<string,{value:PDFObject;count:number}>(),seen=new Set<PDFDict>();let nameCount=0;
 const badNames=(reason:string)=>{result.namedDestinationsComplete=false;partial(reason);};
 const addName=(key:string|null,value:PDFObject|undefined)=>{
  if(key===null||!value||key.length>limits.nameChars||++nameCount>limits.names){badNames('destination-name-limit-or-invalid');return;}
  const known=names.get(key);if(known)known.count++;else names.set(key,{value,count:1});
 };
 function nameTree(value:PDFObject|undefined,depth:number):void{
  const node=resolve(value);
  if(!(node instanceof PDFDict)||depth>limits.depth||seen.has(node)||seen.size>=limits.names){badNames('incomplete-or-cyclic-destination-tree');return;}
  seen.add(node);
  const entries=field(node,'Names'),kids=field(node,'Kids');
  if(entries!==undefined){
   if(!(entries instanceof PDFArray)||entries.size()%2||entries.size()>limits.names*2){badNames('invalid-destination-pairs');return;}
   for(let i=0;i<entries.size();i+=2)addName(string(resolve(entries.get(i))),entries.get(i+1));
  }
  if(kids!==undefined){
   if(!(kids instanceof PDFArray)||kids.size()>limits.names){badNames('invalid-destination-children');return;}
   for(let i=0;i<kids.size();i++){if(nameCount>=limits.names){badNames('destination-name-limit');break;}nameTree(kids.get(i),depth+1);}
  }
 }
 const catalogNames=field(pdf.catalog,'Names');
 if(catalogNames instanceof PDFDict){const dests=catalogNames.get(PDFName.of('Dests'));if(dests!==undefined)nameTree(dests,0);}
 else if(catalogNames!==undefined)badNames('invalid-names-dictionary');
 const legacy=field(pdf.catalog,'Dests');
 if(legacy instanceof PDFDict){
  if(legacy.keys().length>limits.names)badNames('destination-name-limit');
  else for(const key of legacy.keys())addName(key.decodeText(),legacy.get(key));
 }else if(legacy!==undefined)badNames('invalid-legacy-destinations');
 const pages=pdf.getPages(),pageByRef=new Map(pages.map((page,index)=>[page.ref.toString(),index+1]));
 const unknown=(reason:string):PdfInternalLink['target']=>({status:'unknown',reason});
 function target(value:PDFObject|undefined):{destinationName:string|null;target:PdfInternalLink['target']}{
  let dest=resolve(value);const key=string(dest),destinationName=key!==null&&key.length<=limits.nameChars?key:null;
  const finish=(target:PdfInternalLink['target'])=>({destinationName,target});
  if(key!==null){
   if(key.length>limits.nameChars)return finish(unknown('destination-name-limit'));
   if(!result.namedDestinationsComplete)return finish(unknown('destination-tree-incomplete'));
   const matches=names.get(key);
   if(!matches)return finish(unknown('destination-name-missing'));
   if(matches.count!==1)return finish(unknown('destination-name-ambiguous'));
   dest=resolve(matches.value);
  }
  if(dest instanceof PDFDict)dest=field(dest,'D');
  if(!(dest instanceof PDFArray)||dest.size()<2||dest.size()>6)return finish(unknown('destination-array-unavailable'));
  const page=dest.get(0),physicalPageNumber=page instanceof PDFRef?pageByRef.get(page.toString()):undefined;
  if(!physicalPageNumber)return finish(unknown('destination-page-not-an-original-page-ref'));
  const mode=resolve(dest.get(1)),view=mode instanceof PDFName?mode.decodeText():null,
   sizes:Record<string,number>={XYZ:5,Fit:2,FitH:3,FitV:3,FitR:6,FitB:2,FitBH:3,FitBV:3};
  if(!view||sizes[view]!==dest.size())return finish(unknown('destination-view-unsupported'));
  const parameters:Array<number|null>=[];
  for(let i=2;i<dest.size();i++){
   const v=resolve(dest.get(i));
   if(v===PDFNull)parameters.push(null);
   else if(v instanceof PDFNumber&&Number.isFinite(v.asNumber()))parameters.push(v.asNumber());
   else return finish(unknown('destination-parameter-unknown'));
  }
  return finish({status:'resolved-page',physicalPageNumber,view,parameters});
 }
 outer:for(const [index,page]of pages.entries()){
  const annotations=resolve(page.node.get(PDFName.of('Annots')));
  if(annotations===undefined)continue;
  if(!(annotations instanceof PDFArray)){partial('invalid-annotations-array');continue;}
  for(let i=0;i<annotations.size();i++){
   if(result.examinedAnnotations>=limits.annotations||result.links.length>=limits.links){partial('annotation-or-link-limit');break outer;}
   result.examinedAnnotations++;
   const raw=annotations.get(i),annotation=resolve(raw);
   if(!(annotation instanceof PDFDict)){partial('invalid-annotation');continue;}
   if(string(field(annotation,'Subtype'))!=='Link'){result.ignoredActions++;continue;}
   const action=field(annotation,'A'),direct=annotation.get(PDFName.of('Dest'));
   if(action!==undefined&&(!(action instanceof PDFDict)||string(field(action,'S'))!=='GoTo')){result.ignoredActions++;continue;}
   if(action===undefined&&direct===undefined){result.ignoredActions++;continue;}
   const destination=action instanceof PDFDict?action.get(PDFName.of('D')):direct;
   const rect=field(annotation,'Rect');let sourceRect:PdfInternalLink['sourceRect']=null;
   if(rect instanceof PDFArray&&rect.size()===4){const ns=Array.from({length:4},(_,n)=>resolve(rect.get(n)));
    if(ns.every(n=>n instanceof PDFNumber&&Number.isFinite(n.asNumber())))sourceRect=ns.map(n=>(n as PDFNumber).asNumber()) as [number,number,number,number];}
   const observed=action!==undefined&&direct!==undefined?{destinationName:null,target:unknown('both-action-and-direct-destination')}:target(destination);
   result.links.push({sourcePageNumber:index+1,annotationIndex:i,annotationReference:raw instanceof PDFRef?raw.toString():null,
    sourceRect,coordinateSpace:'original-pdf-default-user-space',...observed});
  }
 }
 return result;
}
