import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {findMentionedDocumentSources,type ResolvedDocumentSource} from '../lib/kernel/document-source.ts';

const doc=(documentId:string,title:string):ResolvedDocumentSource=>({documentId,title,currentVersionId:`v-${documentId}`,
 sourceVersionId:`s-${documentId}`,sourceHash:`h-${documentId}`});
function metadata(rows:ResolvedDocumentSource[]){
 const calls:Array<{sql:string;args:unknown[]}>=[];
 return {calls,pool:{query:async(sql:string,args:unknown[])=>{calls.push({sql,args});return {rows};}} as unknown as Pool};
}

test('full NFKC title resolves only current owner/course metadata and preserves the source tuple',async()=>{
 const source=doc('one','Finite Ｆield Methods for Students'),db=metadata([source]);
 const result=await findMentionedDocumentSources(db.pool,'alice','Please use “Finite Field Methods for Students” to explain the construction.',{courseId:'math'});
 assert.deepEqual(result,{status:'resolved',matches:[source]});
 assert.deepEqual(db.calls[0].args,['alice','Please use “Finite Field Methods for Students” to explain the construction.','math']);
 const sql=db.calls[0].sql;
 assert.match(sql,/d\.owner_id=\$1 AND NOT d\.hidden/);assert.match(sql,/d\.course_id=\$3/);
 assert.match(sql,/v\.id=d\.current_version_id AND v\.document_id=d\.id/);assert.match(sql,/newer\.owner_id=d\.owner_id/);
 assert.match(sql,/newer\.origin=d\.origin AND newer\.origin_key=d\.origin_key AND NOT newer\.hidden/);
 assert.doesNotMatch(sql,/document_text_pages|\.body\b|\bLIMIT\b/i,'no bodies or pre-boundary LIMIT');
});

test('short names, partial titles, case changes and embedded words do not select a source',async()=>{
 const title='Reliable inference methods',db=metadata([doc('short','Learning'),doc('single','Generalization'),doc('exam','Final exam'),doc('full',title)]);
 for(const question of ['Learning and Generalization before the Final exam','Reliable inference','reliable inference methods','preReliable inference methodsSuffix'])
  assert.deepEqual(await findMentionedDocumentSources(db.pool,'alice',question),{status:'not-mentioned',matches:[]});
 assert.equal((await findMentionedDocumentSources(db.pool,'alice',`pre${title}Suffix; now “${title}”.`)).status,'resolved','later bounded occurrence is still found');
});

test('different current documents with the same normalized title and multiple named sources stay ambiguous; at most two return',async()=>{
 const a=doc('a','Reliable inference methods'),b=doc('b','Reliable inference methods'),c=doc('c','Practical matrix calculations');
 const result=await findMentionedDocumentSources(metadata([a,b,c]).pool,'alice',`Compare “${a.title}” with “${c.title}”.`);
 assert.deepEqual(result,{status:'ambiguous',matches:[a,b]});
 const distinct=await findMentionedDocumentSources(metadata([a,c]).pool,'alice',`Compare “${a.title}” with “${c.title}”.`);
 assert.deepEqual(distinct,{status:'ambiguous',matches:[a,c]});
});

test('conservative Han-title boundary, rejected early substrings and empty input do not conceal a unique full title',async()=>{
 const han=doc('han','高等数学课程学习资料'),one=doc('one','Reliable inference methods'),two=doc('two','Practical matrix calculations');
 assert.deepEqual(await findMentionedDocumentSources(metadata([han]).pool,'alice',`请用《${han.title}》解释。`),{status:'resolved',matches:[han]});
 assert.equal((await findMentionedDocumentSources(metadata([han]).pool,'alice',`请用${han.title}解释。`)).status,'not-mentioned','unseparated Han text keeps retrieval');
 const result=await findMentionedDocumentSources(metadata([one,two,han]).pool,'alice',`pre${one.title}X pre${two.title}X 《${han.title}》`);
 assert.deepEqual(result,{status:'resolved',matches:[han]});
 const empty=metadata([]);assert.deepEqual(await findMentionedDocumentSources(empty.pool,'alice',' '),{status:'not-mentioned',matches:[]});assert.equal(empty.calls.length,0);
});
