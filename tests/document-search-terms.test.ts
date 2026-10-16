import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {documentSearchTerms,documentSearchText,searchDocumentText} from '../lib/kernel/document-search.ts';

test('an otherwise empty query retains short variables and numbers without changing indexed normalization',()=>{
 const query='4T(n/4) 5n';
 assert.deepEqual(documentSearchTerms(query),{normalized:'4 t n 4 5 n',words:['4','t','n','5']});
 assert.equal(documentSearchTerms(query).normalized,documentSearchText(query));
 assert.deepEqual(documentSearchTerms('7S(k/3) 8k').words,['7','s','k','3','8']);
 assert.deepEqual(documentSearchTerms('9').words,['9']);
 assert.deepEqual(documentSearchTerms('x y').words,['x','y']);
 assert.deepEqual(documentSearchTerms('a x').words,['x'],'fallback still applies the stopword rule');
 for(const empty of ['a an the of','', '() / +'])assert.deepEqual(documentSearchTerms(empty).words,[]);
 assert.deepEqual(documentSearchTerms('What is the Gaussian surface of the sphere?').words,['gaussian','surface','sphere']);
 assert.deepEqual(documentSearchTerms('radius x').words,['radius'],'a nonempty ordinary query keeps its existing policy');
 assert.deepEqual(documentSearchTerms('x^2').words,['x','2','mathx'],'existing explicit formula expansion is preserved');
 assert.equal(documentSearchTerms('x '.repeat(3000)).normalized.length,4000);
 const shortTokens=Array.from({length:60},(_,i)=>String.fromCodePoint(0x4e00+i)).join(' ');
 assert.equal(documentSearchTerms(shortTokens).words.length,40,'fallback retains the existing term bound');
});

test('short-only strict and broad searches reach SQL while stopword-only searches remain empty',async()=>{
 const calls:{sql:string;args:unknown[]}[]=[];
 const pool={query:async(sql:string,args:unknown[])=>{calls.push({sql,args});return {rows:[]};}} as unknown as Pool;
 const query='4T(n/4) 5n';
 await searchDocumentText(pool,'owner',query,{strict:true,semantic:false,hybrid:false,aiRerank:false});
 assert.equal(calls.length,1,'the regression returned before dispatching any SQL');
 assert.match(calls[0].sql,/c\.search_vector @@ q\.exact/);
 assert.equal(calls[0].args[0],'owner');
 assert.equal(calls[0].args[1],'4 t n 4 5 n','strict matching retains the unchanged normalized query');
 assert.deepEqual(calls[0].args[4],['4','t','n','5']);
 await searchDocumentText(pool,'owner',query,{semantic:false,hybrid:false,aiRerank:false});
 assert.equal(calls.length,2);
 assert.match(calls[1].sql,/c\.search_vector @@ q\.broad/);
 assert.equal(calls[1].args[1],'4 t n 5');
 assert.equal(calls[1].args[2],'"4" OR "t" OR "n" OR "5"');
 await searchDocumentText(pool,'owner','a an the',{strict:true});
 assert.equal(calls.length,2,'stopwords do not dispatch an unbounded search');
});
