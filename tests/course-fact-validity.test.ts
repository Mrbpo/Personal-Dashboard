import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {evaluateFactValidity} from '../lib/kernel/fact-validity.ts';
import {answerCourseFacts,renderCourseFacts,refreshCourseFactValidity,type CourseFactRow} from '../lib/kernel/course-facts.ts';

const now=new Date('2026-10-25T15:00:00Z');
function row(overrides:Partial<CourseFactRow>={}):CourseFactRow {
 return {fact_id:'due-fact',entity_id:'task-1',entity_kind:'task',attribute:'due',
  value:{date:'2026-10-24',at:null,timezone:'America/Toronto',precision:'date',original:'2026-10-24'},version:1,current_version:1,
  course_id:'course-1',course_code:'CS101',course_name:'Introduction to Computing',course_ends_at:'2026-10-01T00:00:00Z',term_ends_on:'2026-10-01',
  candidate_id:'candidate-1',evidence_id:'evidence-1',source_version_id:'source-version-1',source_item_id:'source-item-1',
  source:'canvas',locator:'due:0',original_excerpt:'Due October 24',confirmation:'accepted',pending_conflict:false,source_missing:false,
  valid_from:'2026-09-01T00:00:00Z',valid_to:null,validity_basis:'explicit',recorded_at:'2026-09-01T00:00:00Z',
  acquired_at:'2026-09-01T00:00:00Z',published_at:null,document_id:null,document_version_id:null,document_source_hash:null,page_evidence_id:null,...overrides};
}
const task=(overrides:Partial<CourseFactRow>={})=>row({fact_id:'payload-fact',attribute:'task_payload',value:{title:'Assignment 1',canvasStatus:'upcoming'},...overrides});
function facts(result:ReturnType<typeof renderCourseFacts>){return result.meta.facts as Array<{value:unknown;validity:ReturnType<typeof evaluateFactValidity>}>;}

test('overdue, source missing and ended course/term remain separate from cancellation and completion',()=>{
 const validity=evaluateFactValidity({validityBasis:'explicit',validFrom:'2026-09-01T00:00:00Z',sourceMissing:true,
  courseEndsAt:'2026-10-01T00:00:00Z',termEndsOn:'2026-10-01',courseTimezone:'America/Toronto',due:{date:'2026-10-24',precision:'date',timezone:'America/Toronto'}},now);
 assert.equal(validity.action,'overdue');assert.equal(validity.time,'current');assert.equal(validity.source,'source_missing');
 assert.equal(validity.courseEnded,true);assert.equal(validity.termEnded,true);
});
test('freshness uses successful source checks and term date boundaries require course timezone',()=>{
 assert.equal(evaluateFactValidity({sourceCheckedAt:'2026-10-01T00:00:00Z'},now).sourceFreshness,'stale');
 assert.equal(evaluateFactValidity({sourceCheckedAt:'2026-10-25T00:00:00Z'},now).sourceFreshness,'fresh');
 assert.equal(evaluateFactValidity({sourceCheckedAt:'2026-10-25T00:00:00Z',sourceStaleAfterMs:3600000},now).sourceFreshness,'stale');
 assert.equal(evaluateFactValidity({termEndsOn:'2026-10-24'},now).termEnded,null);
 assert.equal(evaluateFactValidity({termEndsOn:'2026-10-24',courseTimezone:'America/Toronto'},new Date('2026-10-25T02:00:00Z')).termEnded,false);
 assert.equal(evaluateFactValidity({},now).sourceFreshness,'unknown');
});
test('date-only deadlines require known IANA zone for overdue comparison and retain literal precision',()=>{
 const early=new Date('2026-10-25T02:00:00Z');
 assert.equal(evaluateFactValidity({due:{date:'2026-10-24',precision:'date',timezone:'America/Toronto'}},early).action,'active');
 assert.equal(evaluateFactValidity({due:{date:'2026-10-24',precision:'date'}},now).action,'unknown');
 const result=renderCourseFacts([row()], 'CS101 deadlines',{},now);
 assert.match(result.answer,/2026-10-24 \(date only; America\/Toronto\)/);assert.doesNotMatch(result.answer,/23:59/);
});
test('date-only due uses canonical course zone for overdue and default window without changing its stored value',()=>{
 const value={date:'2026-10-24',at:null,timezone:null,precision:'date',original:'2026-10-24'};
 const due=row({value}),course=row({fact_id:'course-payload',entity_id:'course-entity',entity_kind:'course',attribute:'course_payload',
  value:{sourceTimezone:'America/Toronto'}});
 const result=renderCourseFacts([due,course],'deadlines',{},now);
 assert.equal(facts(result).length,1);assert.equal(facts(result)[0].validity.action,'overdue');
 assert.deepEqual(facts(result)[0].value,value);assert.match(result.answer,/2026-10-24 \(date only\)/);
 assert.doesNotMatch(result.answer,/time unconfirmed|23:59/);
 const boundary=row({fact_id:'boundary',entity_id:'boundary-task',course_ends_at:null,term_ends_on:null,
  value:{date:'2026-11-10',at:null,timezone:null,precision:'date'}});
 assert.equal(facts(renderCourseFacts([boundary,course],'deadlines',{},new Date('2026-10-25T02:00:00Z'))).length,0);
 const unknown=renderCourseFacts([row({value,course_ends_at:null,term_ends_on:null})],'CS101 deadlines',{},now);
 assert.equal(facts(unknown)[0].validity.action,'unknown');
});
test('future applicability, version, confirmation, and action are orthogonal',()=>{
 const validity=evaluateFactValidity({validityBasis:'explicit',validFrom:'2026-11-01T00:00:00Z',version:1,currentVersion:2,
  pendingConflict:true,completed:true},now);
 assert.equal(validity.time,'not_yet_valid');assert.equal(validity.version,'superseded');
 assert.equal(validity.confirmation,'conflict_pending');assert.equal(validity.action,'completed');
});
test('unknown, observed, and published times do not establish an effective date',()=>{
 for(const validityBasis of ['unknown','observed','published'] as const)
  assert.equal(evaluateFactValidity({validityBasis,validFrom:'2026-09-01T00:00:00Z'},now).time,'unknown');
 assert.throws(()=>evaluateFactValidity({},'2026-10-25'),/explicit valid clock/);
});
test('global default includes recent overdue and next sixteen days, independent of a selected document',()=>{
 const result=renderCourseFacts([row(),row({fact_id:'future',entity_id:'task-2',course_ends_at:null,term_ends_on:null,value:{date:'2026-11-09',precision:'date',timezone:'America/Toronto'}}),
  row({fact_id:'old',entity_id:'task-3',value:{date:'2026-09-01',precision:'date'}})],'What deadlines are due?',{},now);
 assert.equal(facts(result).length,2);assert.match(result.answer,/overdue/);assert.match(result.answer,/16 days/);
});
test('default reminders retain only the past week, while explicit historical items remain queryable and cancelled deadlines are excluded',()=>{
 const old=row({value:{date:'2026-09-01',precision:'date',timezone:'America/Toronto'}});
 assert.equal(facts(renderCourseFacts([old],'deadlines',{},now)).length,0);
 assert.equal(facts(renderCourseFacts([old],'CS101 deadlines',{},now)).length,1);
 const recent=row({value:{date:'2026-10-18',precision:'date',timezone:'America/Toronto'}});
 assert.equal(facts(renderCourseFacts([recent],'deadlines',{},now)).length,1);
 const cancelled=row({fact_id:'explicit-cancellation',attribute:'cancelled',value:true});
 assert.equal(facts(renderCourseFacts([task(),cancelled,row({course_ends_at:null,term_ends_on:null})],'Assignment 1 deadline',{},now)).length,0);
});
test('named task binds payload to its actual due fact and surfaces pending conflicts',()=>{
 const result=renderCourseFacts([task(),row({pending_conflict:true,source_missing:true})],'When is Assignment 1 due?',{},now);
 assert.equal(facts(result).length,1);assert.match(result.answer,/Assignment 1/);assert.match(result.answer,/conflicting update pending review/);
 assert.match(result.answer,/source missing/);assert.equal(facts(result)[0].validity.action,'overdue');
});
test('duplicate named tasks across courses ask for clarification',()=>{
 const result=renderCourseFacts([task(),row(),task({fact_id:'other-payload',entity_id:'other',course_id:'course-2',course_code:'CS102'}),
  row({fact_id:'other-due',entity_id:'other',course_id:'course-2',course_code:'CS102'})],'When is Assignment 1 due?',{},now);
 assert.equal(result.meta.status,'clarification_required');assert.equal(facts(result).length,0);
});
test('duplicate course codes ask for clarification and unmatched literal target never falls back globally',()=>{
 const duplicate=renderCourseFacts([row(),row({fact_id:'other',course_id:'course-2'})],'CS101 deadlines',{},now);
 assert.equal(duplicate.meta.status,'clarification_required');
 assert.equal(renderCourseFacts([row()],'CS999 deadlines',{},now).meta.status,'clarification_required');
 assert.equal(renderCourseFacts([row()],'When is "Missing task" due?',{},now).meta.status,'clarification_required');
 assert.equal(renderCourseFacts([row()],'When is Assignment 3 due?',{},now).meta.status,'clarification_required');
});
test('current queries omit future validity and completed facts only when canonical evidence supports completion',()=>{
 const future=renderCourseFacts([row({valid_from:'2026-11-01T00:00:00Z'})],'CS101 deadlines',{},now);
 assert.equal(facts(future).length,0);
 const completed=renderCourseFacts([task({value:{title:'Assignment 1',canvasStatus:'completed'}}),row()],'deadlines',{},now);
 assert.equal(facts(completed).length,0);
 const named=renderCourseFacts([task({value:{title:'Assignment 1',canvasStatus:'completed'}}),row({course_ends_at:null,term_ends_on:null})],'Assignment 1 deadline',{},now);
 assert.equal(facts(named)[0].validity.action,'completed');
});
test('future task payload cannot supply a current title or mark its due fact completed',()=>{
 const futurePayload=task({valid_from:'2026-11-01T00:00:00Z',value:{title:'Future title',canvasStatus:'completed'}});
 const result=renderCourseFacts([futurePayload,row()],'deadlines',{},now);
 assert.equal(facts(result)[0].validity.action,'overdue');assert.doesNotMatch(result.answer,/Future title/);
});
test('exam queries include canonical task deadlines with a separate identity citation',()=>{
 const result=renderCourseFacts([task({value:{title:'Midterm exam',canvasStatus:'upcoming'}}),row()],'exams',{},now);
 assert.equal(facts(result).length,1);assert.match(result.answer,/Midterm exam/);
 const citations=result.meta.citations as Array<Record<string,unknown>>;
 assert.equal(citations.length,2);assert.equal(citations[1].role,'task_identity');assert.equal(citations[1].factId,'payload-fact');
});
test('asOf uses actual applicable versions and actual historical payload titles',()=>{
 const historical=row({version:1,current_version:2,valid_from:'2026-09-01T00:00:00Z',valid_to:'2026-10-20T00:00:00Z'});
 const current=row({version:2,current_version:2,valid_from:'2026-10-20T00:00:00Z',value:{date:'2026-11-10',precision:'date'}});
 const result=renderCourseFacts([historical,current],'CS101 deadlines',{asOf:'2026-10-15T12:00:00Z'},now);
 assert.deepEqual(facts(result)[0].value,historical.value);assert.equal(facts(result)[0].validity.version,'superseded');
 assert.match(result.answer,/2026-10-24/);assert.doesNotMatch(result.answer,/2026-11-10/);
});
test('history refuses fabricated applicability from ingestion fallback and overlapping real intervals',()=>{
 assert.equal(renderCourseFacts([row({validity_basis:'observed'})],'CS101 deadlines',{history:true},now).meta.status,'history_unsupported');
 assert.equal(renderCourseFacts([row(),row({version:2,current_version:2})],'CS101 deadlines',{history:true},now).meta.status,'historical_conflict');
 assert.throws(()=>renderCourseFacts([row()],'deadlines',{asOf:'yesterday'},now),/explicit offset/);
});
test('canonical policy values and date-only PDF exam facts use verbatim evidence',()=>{
 const policy=row({fact_id:'policy',attribute:'course_policy',entity_id:'policy',course_ends_at:null,term_ends_on:null,value:{title:'Late policy',text:'Late work loses 10% per day.'}});
 const result=renderCourseFacts([policy],'CS101 late policy',{},now);
 assert.match(result.answer,/Late work loses 10% per day/);assert.equal(facts(result).length,1);
 const exam=row({fact_id:'exam',attribute:'exam',course_ends_at:null,term_ends_on:null,value:{title:'Final exam',text:'Final exam 2026-11-01',date:'2026-11-01',time:null,timezone:null}});
 assert.match(renderCourseFacts([exam],'CS101 exams',{},now).answer,/Final exam 2026-11-01/);
});
test('ended course policies leave current scope while unresolved overdue facts retain source warnings',()=>{
 const endedPolicy=row({attribute:'course_policy',value:{title:'Late policy',text:'Late work loses 10%.'}});
 assert.equal(renderCourseFacts([endedPolicy],'CS101 policies',{},now).meta.status,'no_facts');
 const overdue=renderCourseFacts([row({source_changed:true,source_missing:true})],'CS101 deadlines',{},now);
 assert.equal(facts(overdue)[0].validity.action,'overdue');assert.match(overdue.answer,/verification pending/);
 assert.equal(facts(overdue)[0].validity.sourceVerification,'pending_verification');
 const canvas=renderCourseFacts([row({source_url:'https://canvas.example.edu/courses/1/assignments/2'})],'CS101 deadlines',{},now);
 assert.equal((canvas.meta.citations as Array<Record<string,unknown>>)[0].url,'https://canvas.example.edu/courses/1/assignments/2');
 const unsafe=renderCourseFacts([row({source_url:'javascript:alert(1)'})],'CS101 deadlines',{},now);
 assert.equal((unsafe.meta.citations as Array<Record<string,unknown>>)[0].url,undefined);
});
test('citations carry immutable fact/evidence versions and only validated mapped GET URLs',()=>{
 const body='😀\nLate work loses 10% per day.',excerpt='Late work loses 10% per day.';
 const mapped=row({document_id:'doc 1',document_version_id:'dv1',document_source_hash:'hash',page_evidence_id:'page1',
  original_excerpt:excerpt,document_page_body:body,document_body_sha256:createHash('sha256').update(body).digest('hex'),
  document_start_utf16:3,document_end_utf16:body.length});
 const result=renderCourseFacts([mapped],'CS101 deadlines',{},now),citation=(result.meta.citations as Array<Record<string,unknown>>)[0];
 assert.equal(citation.evidenceId,'evidence-1');assert.equal(citation.factVersion,1);assert.equal(citation.sourceVersionId,'source-version-1');
 assert.equal(citation.ref,'fact-1');assert.match(result.answer,/\[fact-1\]/);assert.equal(typeof citation.title,'string');
 assert.match(String(citation.url),/^\/api\/library\/doc%201\?evidence=1&snapshot=1/);
 const invalid=renderCourseFacts([{...mapped,document_start_utf16:2}],'CS101 deadlines',{},now);
 assert.equal((invalid.meta.citations as Array<Record<string,unknown>>)[0].url,undefined);
 assert.equal((renderCourseFacts([row()],'CS101 deadlines',{},now).meta.citations as Array<Record<string,unknown>>)[0].url,undefined);
});
test('global reader authorizes the entity owner and binds exact source/page mappings in one query',async()=>{
 const calls:Array<{sql:string;args:unknown[]}>=[];
 const db={query:async(sql:string,args:unknown[])=>{calls.push({sql,args});return {rows:[row()]};}};
 const result=await answerCourseFacts(db as never,'alice','deadlines');
 assert.equal(calls.length,1);assert.equal(calls[0].args[0],'alice');assert.match(calls[0].sql,/n.owner_id=\$1/);
 assert.match(calls[0].sql,/d.owner_id=n.owner_id/);assert.match(calls[0].sql,/m.candidate_id=cf.id/);
 assert.match(calls[0].sql,/sv.source_item_id=e.source_item_id/);assert.equal(result.meta.scope,'owner-global');
});
test('projection refresh uses supplied clock, is repeatable, and never updates tasks or facts',async()=>{
 const writes:Array<{sql:string;args:unknown[]}>=[];
 const db={query:async(sql:string,args:unknown[])=>{if(sql.startsWith('SELECT'))return {rows:[row()]};writes.push({sql,args});return {rows:[]};}};
 const first=await refreshCourseFactValidity(db as never,'hourly',now),second=await refreshCourseFactValidity(db as never,'hourly',now);
 assert.deepEqual(first,second);assert.equal(first.refreshed,1);assert.deepEqual(writes[0].args,writes[1].args);
 assert.match(writes[0].sql,/course_fact_validity_projection/);assert.doesNotMatch(writes[0].sql,/UPDATE tasks|UPDATE facts/);
 const projected=JSON.parse(String(writes[0].args[4]));assert.equal(projected.action,'overdue');
});
