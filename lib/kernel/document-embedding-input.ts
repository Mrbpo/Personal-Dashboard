import{createHash}from'node:crypto';
import{Tiktoken}from'js-tiktoken/lite';
import cl100k from'js-tiktoken/ranks/cl100k_base';

export type DocumentEmbeddingInputPolicy='page-prefix-v1'|'page-full-v1';
export const DOCUMENT_EMBEDDING_TOKEN_LIMIT=8192;
let encoding:Tiktoken|undefined;

/** Process configuration only; legacy jobs explicitly retain the prefix policy. */
export function documentEmbeddingInputPolicy(value=process.env.KERNEL_DOCUMENT_EMBEDDING_INPUT??'page-prefix-v1'):DocumentEmbeddingInputPolicy{
 if(value!=='page-prefix-v1'&&value!=='page-full-v1')throw Error('Invalid PDF embedding input policy');
 return value;
}

export function documentEmbeddingTokenCount(input:string):number{
 encoding??=new Tiktoken(cl100k);
 // Source strings that resemble special tokens remain literal document text.
 return encoding.encode(input,[],[]).length;
}

/** No truncation or model call on overflow; the lexical path remains available. */
export function assertDocumentEmbeddingInput(input:string):void{
 if(!input.trim())throw Error('PDF embedding input is empty');
 if(!input.isWellFormed())throw Error('PDF embedding input contains an unpaired surrogate');
 if(documentEmbeddingTokenCount(input)>DOCUMENT_EMBEDDING_TOKEN_LIMIT)
  throw Error('PDF embedding input exceeds 8192 tokens; complete text was not indexed');
}

export function documentEmbeddingInput(body:string,policy:DocumentEmbeddingInputPolicy=documentEmbeddingInputPolicy()):{input:string;inputHash:string}{
 documentEmbeddingInputPolicy(policy);
 const input=(policy==='page-full-v1'?body:Array.from(body).slice(0,6000).join('')).trim();
 if(policy==='page-full-v1'&&input)assertDocumentEmbeddingInput(input);
 return{input,inputHash:createHash('sha256').update(input).digest('hex')};
}

/** Fixed internal columns only; SQL and JS hash the same chosen input bytes. */
export function documentEmbeddingSqlBody(column:'p.body'|'old_page.body',policy:DocumentEmbeddingInputPolicy){
 return policy==='page-full-v1'?column:`left(${column},6000)`;
}
