import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {documentSearchTerms,documentSearchText,documentNumericQueryLiterals,searchDocumentText} from '../lib/kernel/document-search.ts';

test('decimal observations retain sign, precision and percent without altering indexed search text',()=>{
 const query='target domain 2.2% 3.6%';
 assert.deepEqual(documentNumericQueryLiterals(query).literals,['2.2%','3.6%']);
 assert.deepEqual(documentNumericQueryLiterals('gain -2.2 +3.60 and −4.5 %').literals,['-2.2','+3.60','−4.5%']);
 assert.deepEqual(documentNumericQueryLiterals('提高２．２％与３．６％').literals,['2.2%','3.6%']);
 assert.deepEqual(documentNumericQueryLiterals('same 2.2% and 2.2 %').literals,['2.2%']);
 assert.deepEqual(documentNumericQueryLiterals('decimal 0.5.').literals,['0.5']);
 assert.deepEqual(documentNumericQueryLiterals('v2.2 _2.2 1.2.3 42').literals,[]);
 const hostile=documentNumericQueryLiterals('gain 2.2%(a+)+');
 assert.equal(hostile.patterns.length,1);assert.ok(!hostile.patterns[0].includes('(a+)+'));
 assert.match(hostile.patterns[0],/2\\\.2/);
 assert.equal(documentSearchText(query),'target domain 2 2 3 6');
 assert.deepEqual(documentSearchTerms(query).words,['target','domain'],'old index/query normalization is not rewritten');
});

test('decimal observations have all-or-nothing bounds and reject unsupported composites without inventing conversions',()=>{
 for(const query of [Array.from({length:9},(_,i)=>`${i}.25%`).join(' '),'1'.repeat(41)+'.2%',
  '2.2% and 1,234.5%','2.2% and 1.2e-3']){
  const result=documentNumericQueryLiterals(query);assert.deepEqual(result.patterns,[]);assert.ok(result.unavailableReason);
 }
 assert.notDeepEqual(documentNumericQueryLiterals('2.2%').patterns,documentNumericQueryLiterals('2.20%').patterns);
 assert.notDeepEqual(documentNumericQueryLiterals('2.2%').patterns,documentNumericQueryLiterals('-2.2%').patterns);
});

test('numeric SQL binds escaped patterns after scope arguments and ranks original page and snippet observations',async()=>{
 const calls:{sql:string;args:unknown[]}[]=[],pool={query:async(sql:string,args:unknown[])=>{calls.push({sql,args});return {rows:[]};}} as unknown as Pool;
 await searchDocumentText(pool,'owner','target domain 2.2% 3.6%',{strict:true,courseId:'course-1',semantic:false,hybrid:false,aiRerank:false});
 assert.equal(calls.length,1);assert.equal(calls[0].args[5],'course-1');assert.deepEqual(calls[0].args[6],documentNumericQueryLiterals('2.2% 3.6%').patterns);
 assert.deepEqual(calls[0].args[7],['2.2','3.6']);
 assert.match(calls[0].sql,/unnest\(\$7::text\[\],\$8::text\[\]\)/);assert.match(calls[0].sql,/literal_counts\.matches=2/);
 assert.match(calls[0].sql,/numeric_pages AS MATERIALIZED/);assert.match(calls[0].sql,/numeric_observations AS MATERIALIZED/);
 assert.match(calls[0].sql,/CASE WHEN c\.body IS NFKC NORMALIZED THEN c\.body ELSE normalize\(c\.body,NFKC\) END/);
 assert.match(calls[0].sql,/CASE WHEN strpos\(c\.numeric_body,literal\.value\)>0 THEN/);
 assert.match(calls[0].sql,/normalize\(chunk\.body,NFKC\)/);assert.ok(!calls[0].sql.includes('2.2%'));
 await searchDocumentText(pool,'owner',Array.from({length:9},(_,i)=>`${i}.25%`).join(' '),{strict:true});
 assert.equal(calls.length,1,'strict over-capacity numeric conditions cannot silently become a partial numeric query');
});

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
